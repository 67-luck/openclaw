import {
  validatePreparedAssistantAppendSync,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import { prepareTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { sessionTranscriptExecution } from "../../config/sessions/transcript-target-binding.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { preparePendingToolResultDelta } from "../session-tool-result-pending-facts.js";
import {
  sessionToolResultPending,
  sessionToolResultRepair,
} from "../session-tool-result-pending.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import { canonicalizeSessionEntry, isTalkRealtimeVoiceEntry } from "./session-manager-codec.js";
import {
  prepareCurrentTurnReplayWitness,
  resolveCurrentTurnEntryId,
  sessionManagerPrepareCurrentTurnReplay,
} from "./session-manager-current-turn.js";
import {
  isSqliteTranscriptMutationConflict,
  type PersistRecordResult,
} from "./session-manager-persistence-contract.js";
import { SessionManagerSuffixPersistence } from "./session-manager-suffix-persistence.js";
import {
  sessionTranscriptAppendPublication,
  type AppendPersistenceOptions,
  type SessionEntry,
} from "./session-manager-types.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";
import type { PersistWorkerRecordResult } from "./session-manager-worker-persistence.js";
import { withSessionManagerReadyWrite } from "./session-manager-write-admission.js";

export class SessionManagerAppend extends SessionManagerSuffixPersistence {
  protected appendEntry<T extends SessionEntry>(
    entry: T,
    options?: AppendPersistenceOptions,
  ): {
    entry: T;
    anchor?: TranscriptEntryAnchor;
    lifecycleRevision?: string;
    appended: boolean;
    [sessionTranscriptAppendPublication]?: (observer: () => void) => void;
  } {
    if (this.persistenceTarget?.[sessionTranscriptExecution]) {
      return withSessionManagerReadyWrite(this, () =>
        this.withTentativeTranscriptView(() => this.appendEntryInOwner(entry, options)),
      );
    }
    return this.appendEntryInOwner(entry, options);
  }

  private appendEntryInOwner<T extends SessionEntry>(entry: T, options?: AppendPersistenceOptions) {
    this.assertTranscriptViewAvailable();
    const canonicalEntry = this.pendingToolResults.serialize(
      this[sessionToolResultPending].owner,
      () => canonicalizeSessionEntry(entry, options),
    );
    const activeBranchAppend =
      !this.pendingDeliberateAppend &&
      this.appendMode !== "side" &&
      !isSessionTranscriptSideAppendEntry(canonicalEntry);
    const persistenceOptions = copyCodeModeSourceAppendOptions(options, {
      ...options,
      ...(activeBranchAppend ? { appendIntent: "active-branch" as const } : {}),
    });
    const preparedTurnAppend =
      activeBranchAppend &&
      canonicalEntry.type === "message" &&
      (canonicalEntry.message.role === "assistant" ||
        canonicalEntry.message.role === "toolResult" ||
        // A nested send can advance the transcript before its tool activity is recorded.
        readNestedToolActivity(canonicalEntry.message) !== undefined);
    let attemptOptions: AppendPersistenceOptions & { expectedMutationAt?: number | null } =
      persistenceOptions;
    const admittedUserId = this.persistenceTarget
      ? resolveSessionTranscriptReadFence(this.persistenceTarget)?.entryId
      : undefined;
    if (preparedTurnAppend && this.persistenceTarget) {
      const validatedMutationAt = validatePreparedAssistantAppendSync(
        this.persistenceTarget,
        canonicalEntry.parentId,
        admittedUserId,
      );
      if (validatedMutationAt === undefined) {
        throw this.createTranscriptMutationConflictError();
      }
      attemptOptions = copyCodeModeSourceAppendOptions(persistenceOptions, {
        ...persistenceOptions,
        expectedMutationAt: validatedMutationAt,
      });
    }
    // Keep preparation local to this append: retries must not redact the payload again or
    // consume its code-mode source token against a different message object.
    const appendTarget = this.persistenceTarget;
    const preparedMessage =
      appendTarget && canonicalEntry.type === "message"
        ? this.pendingToolResults.serialize(this[sessionToolResultPending].owner, () =>
            prepareTranscriptMessageAppend(
              copyCodeModeSourceAppendOptions(options, {
                message: canonicalEntry.message,
                config: options?.config,
              }),
              {
                scope: appendTarget,
                envelope: {
                  type: "message",
                  id: canonicalEntry.id,
                  parentId: canonicalEntry.parentId,
                  timestamp: canonicalEntry.timestamp,
                },
              },
            ),
          )
        : undefined;
    const nativeMessage =
      canonicalEntry.type === "message" &&
      this.persistenceTarget &&
      !this.persistenceTarget[sessionTranscriptExecution];
    let committed = false;
    let publication: (() => void) | undefined;
    let adopted:
      | (ReturnType<SessionManagerAppend["adoptPersistedEntry"]> & { entry: T })
      | undefined;
    const persist = (attempt: typeof attemptOptions) => {
      if (!nativeMessage) {
        return this.persistRecord(canonicalEntry, attempt, preparedMessage);
      }
      committed = false;
      const view = this.captureNativeTranscriptViewRollback(() => {
        committed = true;
      });
      try {
        return this.persistRecord(canonicalEntry, attempt, preparedMessage, {
          enter: view.enter,
          enterPublicFresh: view.enterPublicFresh,
          assertCurrent: () => {
            view.assertCurrent();
            this.assertTranscriptWriteActive();
          },
          complete: (result) => {
            // Private reloads must not impersonate a public target replacement.
            // Admitted-user reload keeps its separate unfenced entry/user checks.
            if (
              result &&
              (result.adoptedMessageId ||
                (!admittedUserId &&
                  (result.reloadAfterAppend ||
                    result.effectiveParentId !== canonicalEntry.parentId)))
            ) {
              result.reload = prepareSessionTranscriptHydration(
                this.persistenceTarget!,
                this.boundedContextLimits,
              ).initializeReady();
            }
            adopted = this.adoptPersistedEntry(canonicalEntry, result, admittedUserId);
          },
          retainPublication: (publish) => {
            publication = publish;
          },
        });
      } catch (error) {
        if (!committed) {
          view.abort();
        }
        throw error;
      }
    };
    const readRetryMutationAt = this.captureTranscriptMutationReader();
    let persistenceResult;
    try {
      persistenceResult = persist(attemptOptions);
    } catch (error) {
      // Fixed journal settlement can fail after native COMMIT. It cannot grant
      // another write attempt, even when its error resembles a mutation conflict.
      if (committed) {
        throw error;
      }
      const deliberateBranchAppend = this.pendingDeliberateAppend;
      const sideBranchAppend =
        this.appendMode === "side" || isSessionTranscriptSideAppendEntry(canonicalEntry);
      const retryableExplicitParentAppend = deliberateBranchAppend || sideBranchAppend;
      if (
        (!activeBranchAppend && !retryableExplicitParentAppend) ||
        !isSqliteTranscriptMutationConflict(error)
      ) {
        throw error;
      }
      const canRetryPreparedAppend =
        retryableExplicitParentAppend ||
        canonicalEntry.type !== "message" ||
        canonicalEntry.message.role === "user" ||
        preparedTurnAppend;
      if (!canRetryPreparedAppend) {
        throw error;
      }
      // Preserve the prepared parent so storage can distinguish a descendant tail from an
      // unrelated branch. Turn-bound assistant and tool-result messages may follow only a
      // descendant tail with no newer user turn; compatible reset and reentrant writes remain.
      const retryOptions: AppendPersistenceOptions & { expectedMutationAt?: number | null } =
        preparedTurnAppend
          ? (() => {
              const validatedMutationAt = this.persistenceTarget
                ? validatePreparedAssistantAppendSync(
                    this.persistenceTarget,
                    canonicalEntry.parentId,
                    admittedUserId,
                  )
                : undefined;
              if (validatedMutationAt === undefined) {
                throw error;
              }
              return copyCodeModeSourceAppendOptions(persistenceOptions, {
                ...persistenceOptions,
                expectedMutationAt: validatedMutationAt,
              });
            })()
          : copyCodeModeSourceAppendOptions(persistenceOptions, {
              ...persistenceOptions,
              expectedMutationAt: readRetryMutationAt(),
            });
      persistenceResult = persist(retryOptions);
    }
    if (!this.persistenceTarget && canonicalEntry.type === "message") {
      const captured = this.pendingToolResults.capture(undefined);
      const repaired = options?.[sessionToolResultRepair];
      const change = captured.stage(
        preparePendingToolResultDelta({
          entry: canonicalEntry,
          appended: true,
          calls: captured.facts,
          repairedToken: repaired && captured.token(repaired),
          // Detached settlement validates the candidate before live view adoption.
          events: () => [...this.fileEntries, canonicalEntry],
        }),
      );
      change.stage();
      change.commit();
    }
    if (!nativeMessage) {
      adopted = this.adoptPersistedEntry(canonicalEntry, persistenceResult, admittedUserId);
    }
    if (!adopted) {
      throw new Error("Native session message omitted its private adoption");
    }
    // Every fixed fact is settled. User observers run outside both write-retry
    // attempts and their rollback scopes, before the parent's public observer.
    const publish = publication;
    publish?.();
    return {
      ...adopted,
      ...(persistenceResult?.[sessionTranscriptAppendPublication]
        ? {
            [sessionTranscriptAppendPublication]:
              persistenceResult[sessionTranscriptAppendPublication],
          }
        : {}),
    };
  }

  protected adoptWorkerCommittedEntry<T extends SessionEntry>(
    entry: T,
    committed: PersistWorkerRecordResult,
    admittedUserId?: string,
  ): {
    entry: T;
    anchor?: TranscriptEntryAnchor;
    lifecycleRevision?: string;
    appended: boolean;
    viewWasSuperseded?: true;
  } {
    if (this.hasNewerPublishedTranscriptView(committed.committedVersion)) {
      // A native SDK append can publish a later view before the worker receipt arrives.
      return {
        entry: {
          ...entry,
          parentId:
            committed.result?.effectiveParentId !== undefined
              ? committed.result.effectiveParentId
              : entry.parentId,
        },
        anchor: committed.result?.anchor,
        lifecycleRevision: committed.result?.lifecycleRevision,
        appended: committed.result?.appended ?? true,
        viewWasSuperseded: true,
      };
    }
    if (committed.viewFailure) {
      throw committed.viewFailure;
    }
    this.transcriptVersion = committed.committedVersion;
    this.transcriptMutationAt = committed.committedVersion.updatedAt;
    return this.adoptPersistedEntry(entry, committed.result, admittedUserId, committed.reload);
  }

  protected adoptPersistedEntry<T extends SessionEntry>(
    canonicalEntry: T,
    persistenceResult: PersistRecordResult,
    admittedUserId?: string,
    preparedReload?: PreparedSessionTranscriptReload,
  ): { entry: T; anchor?: TranscriptEntryAnchor; lifecycleRevision?: string; appended: boolean } {
    const reload = preparedReload ?? persistenceResult?.reload;
    if (persistenceResult?.adoptedMessageId) {
      if (reload) {
        this.adoptPreparedTranscriptReload(reload);
      } else {
        this.reloadPersistedTranscript();
      }
      // Context-excluded users have no payload in byId. The exact SQLite replay
      // anchors their identity; physical ancestry still closes older turns.
      // Final Talk speech records history without consuming the consult's keyed input.
      if (
        this.resolveCurrentTurnEntryId(isTalkRealtimeVoiceEntry) !==
        persistenceResult.adoptedMessageId
      ) {
        throw new Error(
          `Session transcript keyed user is outside the current turn: ${persistenceResult.adoptedMessageId}`,
        );
      }
      canonicalEntry.id = persistenceResult.adoptedMessageId;
    } else if (
      persistenceResult?.reloadAfterAppend ||
      (persistenceResult?.effectiveParentId !== undefined &&
        persistenceResult.effectiveParentId !== canonicalEntry.parentId)
    ) {
      if (admittedUserId) {
        if (this.transcriptMutationAt === undefined) {
          throw new Error("Session transcript append mutation fence was not returned");
        }
        if (reload) {
          this.adoptPreparedTranscriptReload(reload, {
            expectedMutationAt: this.transcriptMutationAt,
            expectedEntryId: canonicalEntry.id,
            admittedUserId,
          });
        } else {
          this.reloadPersistedTranscriptAfterAppend(
            this.transcriptMutationAt,
            canonicalEntry.id,
            admittedUserId,
          );
        }
      } else if (reload) {
        this.adoptPreparedTranscriptReload(reload);
      } else {
        this.reloadPersistedTranscript();
      }
    } else {
      if (
        !isSessionTranscriptSideAppendEntry(canonicalEntry) &&
        canonicalEntry.parentId === this.appendParentId &&
        this.leafId !== this.appendParentId
      ) {
        this.logicalParentsById.set(canonicalEntry.id, this.leafId);
      }
      this.fileEntries.push(canonicalEntry);
      // Reloaded views already include the committed boundary; count only local adoption.
      if (
        this.persistedBoundaryCount !== undefined &&
        (canonicalEntry.type === "compaction" || canonicalEntry.type === "reset")
      ) {
        this.persistedBoundaryCount += 1;
      }
      this.byId.set(canonicalEntry.id, canonicalEntry);
      this.appendParentId = canonicalEntry.id;
      if (isSessionTranscriptSideAppendEntry(canonicalEntry)) {
        this.appendMode = "side";
      } else {
        this.leafId = canonicalEntry.id;
        this.appendMode = undefined;
      }
    }
    this.pendingDeliberateAppend = false;
    return {
      entry: canonicalEntry,
      anchor: persistenceResult?.anchor,
      lifecycleRevision: persistenceResult?.lifecycleRevision,
      // Detached managers append locally; only the storage owner supplies a durable anchor.
      appended: persistenceResult?.appended ?? true,
    };
  }

  private createTranscriptMutationConflictError(): Error {
    const error = new Error(
      `SQLite transcript changed while preparing rewrite for ${this.persistenceTarget?.sessionId ?? this.sessionId}`,
    );
    error.name = "SqliteTranscriptMutationConflictError";
    return error;
  }

  // SDK v2026.9.5 exposes this synchronous opt-in; internal replay uses async preparation.
  resolveCurrentTurnEntryId(
    isInterruptedTail?: (entry: SessionEntry) => boolean,
    options?: { includeOmittedCustomMessages?: boolean },
  ): string | null {
    this.assertTranscriptViewAvailable();
    const includeOmitted = options?.includeOmittedCustomMessages === true;
    return resolveCurrentTurnEntryId(
      {
        target: this.persistenceTarget,
        version: this.transcriptVersion,
        entries: this.byId,
        parentId: this.appendParentId,
        remainingAncestors: includeOmitted
          ? (this.boundedContextLimits?.maxEvents ?? this.byId.size + this.opaqueParentsById.size)
          : this.byId.size,
        isInterruptedTail,
      },
      includeOmitted,
    );
  }

  [sessionManagerPrepareCurrentTurnReplay](
    isInterruptedTail: (entry: SessionEntry) => boolean,
    matchesUser: (entry: SessionEntry | undefined) => boolean,
    signal?: AbortSignal,
  ) {
    return prepareCurrentTurnReplayWitness(
      () => {
        this.assertTranscriptViewAvailable();
        return {
          target: this.persistenceTarget,
          version: this.transcriptVersion,
          entries: this.byId,
          parentId: this.appendParentId,
          remainingAncestors:
            this.boundedContextLimits?.maxEvents ?? this.byId.size + this.opaqueParentsById.size,
          isInterruptedTail,
        };
      },
      matchesUser,
      signal,
    );
  }
}
