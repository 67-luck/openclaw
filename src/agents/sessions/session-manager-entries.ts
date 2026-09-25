import { buildSessionContext as buildCoreSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  readActiveTranscriptEntryAnchor,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import {
  sameSessionTranscriptTargetBinding,
  sessionTranscriptExecution,
} from "../../config/sessions/transcript-target-binding.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import {
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import type { ImageContent, Message, TextContent } from "../../llm/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { sessionFreshInputCommit } from "../../sessions/user-turn-transcript-admission.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { SessionTreeEntry as CoreSessionTreeEntry } from "../runtime/index.js";
import {
  sessionToolResultPending,
  sessionToolResultRepair,
} from "../session-tool-result-pending.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { SessionManagerAppend } from "./session-manager-append.js";
import { canonicalizeSessionEntry } from "./session-manager-codec.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import {
  sessionTranscriptAppendPublication,
  type AppendPersistenceOptions,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type LabelEntry,
  type ResetEntry,
  type ResetReason,
  type SessionContext,
  type SessionInfoEntry,
  type SessionMessageEntry,
  type SessionLeafControl,
} from "./session-manager-types.js";
import {
  captureSessionManagerHostExecution,
  withSessionManagerReadyWrite,
  withSessionManagerWrite,
} from "./session-manager-write-admission.js";
import type { SessionMessageAppendOutcome } from "./session-message-append-operation.js";

export class SessionManagerEntries extends SessionManagerAppend {
  appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    return this.appendMessageWithTranscriptAnchor(message, options).entryId;
  }

  async appendMessageAsync(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): Promise<string | undefined> {
    return (await this.appendMessageWithTranscriptAnchorAsync(message, options)).entryId;
  }

  async appendMessageWithTranscriptAnchorAsync(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): Promise<
    ReturnType<SessionManagerEntries["appendMessageWithTranscriptAnchor"]> & {
      viewWasSuperseded?: true;
    }
  > {
    return await withSessionManagerWrite(this, async () => {
      this.assertTranscriptWriteActive();
      const ready = this.persistenceTarget?.[sessionTranscriptExecution];
      // Standalone native storage and transaction-local callbacks retain their SDK boundary.
      if (
        !this.persistenceTarget ||
        (!ready &&
          (isIncognitoSessionKey(this.persistenceTarget.sessionKey) ||
            (message.role !== "assistant" && message.role !== "toolResult") ||
            options?.beforeFreshMessageCommit ||
            options?.[sessionFreshInputCommit]))
      ) {
        return this.appendMessageWithTranscriptAnchor(message, options);
      }
      const replay = this.replayCurrentUserMessage(message, options);
      if (replay) {
        return replay;
      }
      const prepared = this.prepareWorkerMessageAppend(message, options);
      return prepared.finish(await prepared.runtime.append(...prepared.args));
    });
  }

  private prepareWorkerMessageAppend(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ) {
    this.assertTranscriptWriteActive();
    const target = this.getSessionTarget();
    if (!target) {
      throw new Error("Session message worker requires a persistent session");
    }
    const sessionId = this.getSessionId();
    const assertOwned = captureOwnedTranscriptWriteAssertion(target);
    const assertCurrent = () => {
      assertOwned();
      if (
        this.getSessionId() !== sessionId ||
        !sameSessionTranscriptTargetBinding(target, this.getSessionTarget())
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    };
    const host = captureSessionManagerHostExecution(this);
    if (message.role === "assistant") {
      applyAssistantDeliveryDirectives(message);
    }
    const canonical = this.pendingToolResults.serialize(this[sessionToolResultPending].owner, () =>
      canonicalizeSessionEntry<SessionMessageEntry>(
        {
          type: "message",
          id: generateSessionEntryId(),
          parentId: this.appendParentId,
          timestamp: new Date().toISOString(),
          message,
        },
        options,
      ),
    );
    const activeBranchAppend =
      !this.pendingDeliberateAppend &&
      this.appendMode !== "side" &&
      !isSessionTranscriptSideAppendEntry(canonical);
    const admittedUserId = resolveSessionTranscriptReadFence(target)?.entryId;
    const runtime = this.getMessageRuntime();
    let adopted:
      | (ReturnType<SessionManagerEntries["appendMessageWithTranscriptAnchor"]> & {
          viewWasSuperseded?: true;
        })
      | undefined;
    const args: Parameters<typeof runtime.append> = [
      copyCodeModeSourceAppendOptions(options, {
        message: canonical.message,
        cwd: this.cwd,
        eventId: canonical.id,
        now: Date.parse(canonical.timestamp),
        parentId: canonical.parentId,
        ...(activeBranchAppend ? { appendIntent: "active-branch" as const } : {}),
        ...(options?.config ? { config: options.config } : {}),
        ...(options?.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
      }),
      {
        repairedCall: options?.[sessionToolResultRepair],
        ...(activeBranchAppend &&
        (message.role === "assistant" ||
          message.role === "toolResult" ||
          readNestedToolActivity(message) !== undefined)
          ? { parent: { parentId: canonical.parentId, admittedUserId } }
          : {}),
        initialize: this.messageInitialization(),
        limits: this.boundedContextLimits,
        loadedVersion: this.transcriptVersion,
        freshInput: options?.[sessionFreshInputCommit]?.authority,
        assertFreshInput: options?.[sessionFreshInputCommit]?.assertCurrent,
        beforeFreshMessageCommit: options?.beforeFreshMessageCommit,
      },
      {
        host,
        assertCurrent,
        stage: (value) => this.stageMessageView(value.facts, () => args[2]!.adopt(value)),
        adopt: (value) => {
          const { facts } = value;
          const receipt = facts.receipt;
          if (
            facts.kind !== "manager" ||
            !receipt.anchor ||
            receipt.effectiveParentId === undefined
          ) {
            throw new Error("Session message commit omitted its manager receipt");
          }
          if (
            options?.idempotencyLookup === "caller-checked" &&
            (!receipt.appended || receipt.messageId !== canonical.id)
          ) {
            throw new Error(`Session transcript append was not persisted: ${canonical.id}`);
          }
          const replay = receipt.messageId !== canonical.id;
          canonical.message = value.message;
          const result = this.adoptWorkerCommittedEntry(
            canonical,
            {
              committedVersion: facts.after,
              reload: value.reload,
              result: {
                anchor: receipt.anchor,
                lifecycleRevision: facts.lifecycleRevision,
                appended: receipt.appended,
                effectiveParentId: receipt.effectiveParentId,
                ...(replay ? { adoptedMessageId: receipt.messageId } : {}),
                ...(value.reload ? { reloadAfterAppend: true } : {}),
              },
            },
            admittedUserId,
          );
          adopted = {
            entryId: replay ? receipt.messageId : result.entry.id,
            message: result.entry.message,
            anchor: result.anchor,
            lifecycleRevision: result.lifecycleRevision,
            appended: result.appended,
            ...(result.viewWasSuperseded ? { viewWasSuperseded: true as const } : {}),
          };
        },
        publish: () => assertCurrent(),
      },
    ];
    return {
      runtime,
      args,
      finish: (outcome: SessionMessageAppendOutcome) => {
        if (outcome.kind !== "committed" && outcome.kind !== "tentative") {
          if (outcome.kind === "missing") {
            throw new Error("Session transcript message was not persisted");
          }
          if (outcome.kind === "unknown" && outcome.error instanceof Error) {
            recordModelFallbackStop(outcome.error);
          }
          throw outcome.error;
        }
        if (outcome.failures.length || !adopted) {
          const cause =
            outcome.failures.length === 1
              ? outcome.failures[0]
              : new AggregateError(
                  outcome.failures,
                  "Session message committed without successful delivery",
                );
          if (outcome.kind === "tentative") {
            throw cause;
          }
          const error = new SessionTranscriptMessageCommittedError(
            outcome.facts.receipt.messageId,
            cause,
            target,
            outcome.facts.after,
            outcome.facts.lifecycleRevision,
          );
          if (!adopted) {
            this.invalidateTranscriptView(error);
          }
          throw error;
        }
        return {
          ...adopted,
          ...(outcome.publish ? { [sessionTranscriptAppendPublication]: outcome.publish } : {}),
        };
      },
    };
  }

  private replayCurrentUserMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): ReturnType<SessionManagerEntries["appendMessageWithTranscriptAnchor"]> | undefined {
    if (
      options?.idempotencyLookup !== "caller-checked" &&
      message.role === "user" &&
      "idempotencyKey" in message &&
      typeof message.idempotencyKey === "string" &&
      message.idempotencyKey.length > 0
    ) {
      const currentTurnId = this.resolveCurrentTurnEntryId();
      const current = currentTurnId ? this.byId.get(currentTurnId) : undefined;
      if (
        current?.type === "message" &&
        current.message.role === "user" &&
        "idempotencyKey" in current.message &&
        current.message.idempotencyKey === message.idempotencyKey
      ) {
        const anchor = this.persistenceTarget
          ? this.persistenceTarget[sessionTranscriptExecution]
            ? prepareSessionTranscriptHydration(this.persistenceTarget).readActiveAnchorReady(
                current.id,
              )
            : readActiveTranscriptEntryAnchor({ ...this.persistenceTarget, entryId: current.id })
          : undefined;
        if (this.persistenceTarget && !anchor) {
          throw new Error(`Session transcript anchor was not returned: ${current.id}`);
        }
        return {
          entryId: current.id,
          message: current.message,
          ...(anchor ? { anchor } : {}),
          appended: false,
        };
      }
    }
    return undefined;
  }

  appendMessageWithTranscriptAnchor(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): {
    entryId: string;
    message: SessionMessageEntry["message"];
    anchor?: TranscriptEntryAnchor;
    lifecycleRevision?: string;
    appended: boolean;
    [sessionTranscriptAppendPublication]?: (observer: () => void) => void;
  } {
    // A current keyed user entry replays its stored body before either append engine
    // prepares a fresh candidate or invokes its fresh-input admission.
    const replay = this.replayCurrentUserMessage(message, options);
    if (replay) {
      return replay;
    }
    if (this.persistenceTarget?.[sessionTranscriptExecution]) {
      return withSessionManagerReadyWrite(this, () => {
        const prepared = this.prepareWorkerMessageAppend(message, options);
        return prepared.finish(prepared.runtime.appendReady(...prepared.args));
      });
    }
    if (message.role === "assistant") {
      applyAssistantDeliveryDirectives(message);
    }
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      message,
    };
    const {
      entry: persisted,
      anchor,
      lifecycleRevision,
      appended,
      [sessionTranscriptAppendPublication]: publication,
    } = this.appendEntry(entry, options);
    return {
      entryId: persisted.id,
      message: persisted.message,
      ...(anchor ? { anchor } : {}),
      lifecycleRevision,
      appended,
      ...(publication ? { [sessionTranscriptAppendPublication]: publication } : {}),
    };
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    metadata?: CompactionEntry["__openclaw"],
    tokensAfter?: number,
  ): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      details,
      fromHook,
      ...(metadata?.runId || metadata?.itemId ? { __openclaw: metadata } : {}),
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }

  appendResetBoundary(reason: ResetReason, firstKeptEntryId?: string): string {
    const entry: ResetEntry = {
      type: "reset",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      reason,
      ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      customType,
      data,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      name: name.replace(/[\r\n]+/g, " ").trim(),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string {
    const entry: CustomMessageEntry = {
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  appendLeafControl(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): SessionLeafControl {
    if (this.persistenceTarget?.[sessionTranscriptExecution]) {
      return withSessionManagerReadyWrite(this, () =>
        this.withTentativeTranscriptView(() => this.appendLeafControlInOwner(params)),
      );
    }
    return this.appendLeafControlInOwner(params);
  }

  private appendLeafControlInOwner(
    params: Parameters<SessionManagerEntries["appendLeafControl"]>[0],
  ): SessionLeafControl {
    this.assertTranscriptViewAvailable();
    if (params.targetId !== null && !this.byId.has(params.targetId)) {
      throw new Error(`Entry ${params.targetId} not found`);
    }
    if (
      params.appendParentId !== null &&
      !this.byId.has(params.appendParentId) &&
      !this.opaqueParentsById.has(params.appendParentId)
    ) {
      throw new Error(`Append parent ${params.appendParentId} not found`);
    }
    const previousLeafId = this.leafId;
    this.leafId = params.targetId;
    const entry = this.createLeafControl(
      this.appendParentId,
      params.appendParentId,
      params.appendMode,
    );
    this.leafId = previousLeafId;
    this.persistRecord(entry);
    this.rememberLeafControl(entry);
    this.leafId = params.targetId;
    this.appendParentId = params.appendParentId;
    this.appendMode = params.appendMode;
    this.pendingDeliberateAppend = false;
    return entry;
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    this.assertTranscriptViewAvailable();
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = {
      type: "label",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this.appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return entry.id;
  }

  buildSessionContext(): SessionContext {
    return buildCoreSessionContext(this.getBranch() as CoreSessionTreeEntry[]) as SessionContext;
  }

  branch(branchFromId: string): void {
    this.assertTranscriptViewAvailable();
    if (!this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    // Navigation must unwind before earlier tentative appends, whose rollback
    // protects a newer independently adopted view by checking the selected leaf.
    this.withTentativeTranscriptView(() => {
      this.leafId = branchTargetId;
      this.appendParentId = branchTargetId;
      this.appendMode = undefined;
      this.pendingDeliberateAppend = true;
    });
  }

  resetLeaf(): void {
    this.assertTranscriptViewAvailable();
    this.withTentativeTranscriptView(() => {
      this.leafId = null;
      this.appendParentId = null;
      this.appendMode = undefined;
      this.pendingDeliberateAppend = true;
    });
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = branchFromId === null ? null : this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateSessionEntryId(),
      parentId: branchTargetId,
      timestamp: new Date().toISOString(),
      fromId: branchTargetId ?? "root",
      summary,
      details,
      fromHook,
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }
}
