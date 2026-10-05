import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  loadTranscriptSuffixEventsBoundedSync,
  readTranscriptIdentityByEventId,
  readTranscriptMutationAtSync,
  replaceTranscriptSuffixEventsSync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionCanonicalParentId } from "../../config/sessions/session-entry-navigation.js";
import type { SessionMaintenanceOperations } from "../../config/sessions/session-manager-write-contract.js";
import type {
  SessionTranscriptMaintenanceRead,
  SessionTranscriptMaintenanceFacts,
} from "../../config/sessions/session-transcript-hydration.types.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "../../config/sessions/session-transcript-index.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { isIndexedSessionEntry } from "./session-manager-codec.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import { prepareSessionManagerSync } from "./session-manager-incognito-scope.js";
import {
  prepareNativeSessionSuffixOperations,
  prepareSessionManagerHydration,
} from "./session-manager-incognito.js";
import {
  committedTranscriptViewError,
  receiveSessionManagerCommit,
  type SessionManagerActorCommittedError,
} from "./session-manager-persistence-error.js";
import { SessionManagerPersistence } from "./session-manager-persistence.js";
import {
  admitLoadedSuffixLabels,
  publishRewrittenSuffixLabels,
  remapSuffixEntries,
  remapSuffixParentFacts,
  walkResidentSessionSuffix,
} from "./session-manager-suffix-resident.js";
import type { SessionEntry } from "./session-manager-types.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import {
  runSessionPersistenceAsync,
  runSessionPersistenceSync,
  sessionPersistenceStep,
  type SessionPersistenceStep,
} from "./session-persistence-operation.js";

export class SessionManagerSuffixPersistence extends SessionManagerPersistence {
  /** @deprecated Use removeTrailingEntriesAsync; removed at the next Plugin SDK major. */
  removeTrailingEntries(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): number {
    prepareSessionManagerSync("removeTrailingEntries", this.persistenceTarget, this);
    return runSessionPersistenceSync(this.prepareTrailingEntriesRemoval(predicate, options));
  }

  async removeTrailingEntriesAsync(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): Promise<number> {
    return withSessionManagerWrite(this, async (admission) => {
      if (!admission) {
        return runSessionPersistenceSync(this.prepareTrailingEntriesRemoval(predicate, options));
      }
      const limits = this.boundedContextLimits;
      const history = limits ? this[sessionManagerPrepareHistoryRead]() : undefined;
      const retainedEntryIds = limits
        ? this.fileEntries.flatMap((entry) =>
            entry.type !== "session" && entry.type !== "message" ? [entry.id] : [],
          )
        : [];
      if (isIncognitoSessionKey(this.persistenceTarget?.sessionKey) && "db" in admission.database) {
        // Incognito reads and writes through its exact process-held database owner.
        if (!limits) {
          return runSessionPersistenceSync(this.prepareTrailingEntriesRemoval(predicate, options));
        }
        const native = await prepareNativeSessionSuffixOperations({
          target: this.persistenceTarget!,
          database: admission.database.db,
          limits,
          retainedEntryIds,
          assertCurrent: () => {
            admission.assertCurrent();
            history!.assertCurrent();
          },
        });
        return runSessionPersistenceAsync(
          this.prepareTrailingEntriesRemoval(predicate, options, undefined, history, native),
        );
      }
      const target = this.persistenceTarget!;
      const identity = { ...target };
      const version = this.transcriptVersion;
      const assertNavigation = this.captureTranscriptNavigationAssertion();
      const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
      const assertCurrent = () => {
        admission.assertCurrent();
        this.assertTranscriptWriteActive();
        assertOwned();
        assertNavigation();
        if (
          !sameSessionTranscriptTargetBinding(identity, this.persistenceTarget) ||
          this.transcriptVersion !== version
        ) {
          throw new Error("Session transcript changed during suffix preparation");
        }
      };
      const reader = prepareSessionManagerHydration(target, undefined, undefined, this);
      const { env: _env, ...scope } = withOwnedSessionTranscriptWriterFence(target);
      const { withSessionMetadataWorker } = await import("./session-manager-metadata-runtime.js");
      assertCurrent();
      return withSessionMetadataWorker(
        admission.options,
        admission.database,
        assertCurrent,
        async (worker) =>
          runSessionPersistenceAsync(
            this.prepareTrailingEntriesRemoval(
              predicate,
              options,
              {
                assertCurrent,
                read: async (request) => {
                  const result = await reader.readMaintenance(request);
                  reader.assertCurrent();
                  assertCurrent();
                  return result;
                },
                replace: async (args, retainedCustomDataIds) => {
                  const receipt = await receiveSessionManagerCommit(
                    "session.transcript.replaceSuffix",
                    () =>
                      worker.execute({
                        type: "session.transcript.replaceSuffix",
                        input: {
                          scope: { ...scope, storePath: admission.database.path },
                          args,
                          limits,
                          retainedEntryIds,
                          retainedCustomDataIds,
                        },
                      }),
                  );
                  if (receipt.value.projectionNeedsReconcile && !receipt.failure) {
                    startSessionTranscriptIndexReconcile({
                      ...admission.options,
                      preferredSessionId: identity.sessionId,
                    });
                  }
                  return receipt;
                },
              },
              history,
            ),
          ),
      );
    });
  }

  private *prepareTrailingEntriesRemoval(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
    worker?: {
      assertCurrent(): void;
      read(request: SessionTranscriptMaintenanceRead): Promise<SessionTranscriptMaintenanceFacts>;
      replace(
        args: SessionMaintenanceOperations["session.transcript.replaceSuffix"]["input"]["args"],
        retainedCustomDataIds: readonly string[],
      ): Promise<{
        value: SessionMaintenanceOperations["session.transcript.replaceSuffix"]["output"];
        failure?: SessionManagerActorCommittedError;
      }>;
    },
    history?: ReturnType<SessionManagerPersistence[typeof sessionManagerPrepareHistoryRead]>,
    native?: Awaited<ReturnType<typeof prepareNativeSessionSuffixOperations>>,
  ): Generator<SessionPersistenceStep, number, void> {
    this.assertTranscriptWriteActive();
    const publication = this.captureTranscriptPublication();
    const removedParentById = new Map<string, string | null>();
    const selection: { candidate?: SessionEntry; predecessor?: SessionEntry } = {};
    let contextStartEntryId = this.contextStartEntryId;
    let preserving = true;
    const inspect = (entry: SessionEntry, rawParentId: string | null): boolean => {
      if (!(preserving && options?.preserveTrailing?.(entry))) {
        preserving = false;
        if (!predicate(entry)) {
          selection.predecessor = entry;
          return false;
        }
        removedParentById.set(entry.id, rawParentId);
        selection.candidate = entry;
      }
      // Cleanup selects the predecessor; preserved suffix rows also leave the active branch.
      if (entry.id === contextStartEntryId) {
        contextStartEntryId = null;
      }
      return true;
    };
    const inspectedIds = new Set<string>();
    const inspectResident = () => {
      const branch = this.getBranch();
      if (history && this.rawLeafId !== this.appendParentId) {
        return;
      }
      if (!history) {
        this.resolveTranscriptEntrySeq(branch.at(-1)?.id);
      }
      for (const entry of walkResidentSessionSuffix(
        this.rawLeafId,
        branch,
        this.byId,
        this.opaqueFileEntries,
        this.invalidLeafControlIds,
        this.boundedParentIds,
        (residentEntry) => this.resolveEntryParentId(residentEntry),
        Boolean(history),
      )) {
        if (!entry) {
          if (history) {
            return;
          }
          throw new RangeError(
            "Bounded transcript cleanup cannot cross the hydrated removal window",
          );
        }
        if (history) {
          inspectedIds.add(entry.id);
        }
        const parents = this.boundedParentIds.get(entry.id);
        const rawParentId = parents
          ? parents.rawParentId
          : this.logicalParentsById.has(entry.id)
            ? this.logicalParentsById.get(entry.id)!
            : this.byId.get(entry.id)!.parentId;
        if (!inspect(entry, rawParentId)) {
          return;
        }
      }
    };
    yield* sessionPersistenceStep(
      inspectResident,
      history
        ? async () => {
            inspectResident();
            if (!selection.candidate && selection.predecessor) {
              return;
            }
            for await (const page of history.pages({
              selection: "branch",
              direction: "reverse",
              oversizedToolResults: "complete",
              reuseResidentCustomData: true,
            })) {
              if (!page.rawParentIds) {
                throw new Error("Persisted suffix history is missing raw parent facts");
              }
              for (const entry of page.entries) {
                const rawParentId = page.rawParentIds.get(entry.id)!;
                if (inspectedIds.has(entry.id)) {
                  if (removedParentById.has(entry.id)) {
                    removedParentById.set(entry.id, rawParentId);
                  }
                  if (entry.id === selection.candidate?.id) {
                    selection.candidate = entry;
                  }
                  if (entry.id === selection.predecessor?.id) {
                    return;
                  }
                } else if (!inspect(entry, rawParentId)) {
                  return;
                }
              }
            }
          }
        : undefined,
    );
    history?.assertCurrent();
    const { candidate } = selection;
    if (!candidate) {
      return 0;
    }
    // Fence only an actual mutation. Defensive cleanup remains a no-op when its target is absent,
    // even if another writer advanced the durable transcript after this manager was opened.
    if (this.persistenceTarget && this.transcriptMutationAt !== undefined) {
      const target = this.persistenceTarget;
      const mutationAt = yield* sessionPersistenceStep(
        () => readTranscriptMutationAtSync(target),
        worker
          ? async () => (await worker.read({ operation: "version" })).version?.updatedAt
          : undefined,
      );
      if (mutationAt !== this.transcriptMutationAt) {
        throw new Error(
          `SQLite transcript changed while preparing suffix removal for ${this.persistenceTarget.sessionId}`,
        );
      }
    }
    const target = this.persistenceTarget;
    history?.assertCurrent();
    const candidateSeq =
      target && isIndexedSessionEntry(candidate)
        ? yield* sessionPersistenceStep(
            () =>
              readTranscriptIdentityByEventId(
                openOpenClawAgentDatabase(
                  toDatabaseOptions(resolveSqliteTranscriptReadScope(target)),
                ),
                target.sessionId,
                candidate.id,
              )?.seq,
            history
              ? async () => (await history.readEntryNavigation(candidate.id))?.firstCanonicalRawSeq
              : worker
                ? async () =>
                    (await worker.read({ operation: "identity", eventId: candidate.id })).seq
                : undefined,
          )
        : undefined;
    const persistedSuffixStartSeq = candidateSeq ?? this.persistedSuffixStartSeq;
    const current = new SessionManagerSuffixPersistence(this.cwd, undefined, this.fileEntries);
    current.opaqueFileEntries = this.opaqueFileEntries.map((entry) => ({ ...entry }));
    current.buildIndex(this.admittedLabelRecords);
    current.inheritResidentContextEntries(this);
    current.rawLeafId = this.rawLeafId;
    current.appendParentId = this.appendParentId;
    current.appendMode = this.appendMode;
    const currentEntries = current.getPersistedFileEntries();
    const candidatePersistedIndex = currentEntries.findIndex(
      (entry) => isRecord(entry) && entry.id === candidate?.id,
    );
    // Custom data never participates in topology or FTS. Keep loaded payloads by reference
    // while the storage owner carries their original bytes through the atomic suffix rewrite.
    const retainedCustomData = new Map<string, unknown>(
      this.boundedContextIncomplete
        ? this.fileEntries.flatMap((entry) =>
            entry.type === "custom" && entry.data !== undefined
              ? [[entry.id, entry.data] as const]
              : [],
          )
        : [],
    );
    let retainedCustomDataIds = [...retainedCustomData.keys()];
    const restoreCustomData = <T>(entry: T): T =>
      isRecord(entry) &&
      entry.type === "custom" &&
      typeof entry.id === "string" &&
      retainedCustomData.has(entry.id)
        ? { ...entry, data: retainedCustomData.get(entry.id) }
        : entry;
    const header = this.getHeader();
    let retainedContextPrefix =
      persistedSuffixStartSeq !== undefined && candidatePersistedIndex >= 0
        ? currentEntries.slice(0, candidatePersistedIndex)
        : history && header
          ? [header]
          : [];
    let expectedPersistedEntries = currentEntries;
    const admittedLabelRecords = new Map(this.admittedLabelRecords);
    let useFullTranscriptFallback = false;
    if (this.persistenceTarget && persistedSuffixStartSeq !== undefined) {
      try {
        history?.assertCurrent();
        const suffixTarget = this.persistenceTarget;
        const limits = {
          maxBytes: SYNC_REBUILD_MAX_BYTES,
          maxEvents: SYNC_REBUILD_MAX_ROWS,
          retainedCustomDataIds,
        };
        const suffix = yield* sessionPersistenceStep(
          () =>
            loadTranscriptSuffixEventsBoundedSync(suffixTarget, persistedSuffixStartSeq, limits),
          worker
            ? async () => {
                const result = await worker.read({
                  operation: "suffix",
                  startSeq: persistedSuffixStartSeq,
                  ...limits,
                });
                if (!result.events || !result.eventSeqs) {
                  throw new Error("Session suffix reader returned no event positions");
                }
                return { events: result.events, eventSeqs: result.eventSeqs };
              }
            : undefined,
        );
        expectedPersistedEntries = suffix.events;
        admitLoadedSuffixLabels(admittedLabelRecords, suffix);
        // SQLite cannot project over-depth JSON. Those rows retain their complete payload
        // and stay on the ordinary exact-byte path rather than claiming an opaque reference.
        const projectedIds = new Set(
          expectedPersistedEntries.flatMap((entry) =>
            isRecord(entry) &&
            entry.type === "custom" &&
            typeof entry.id === "string" &&
            !Object.hasOwn(entry, "data")
              ? [entry.id]
              : [],
          ),
        );
        retainedCustomDataIds = retainedCustomDataIds.filter((id) => projectedIds.has(id));
      } catch (error) {
        const exceededPlanningLimit =
          error instanceof Error &&
          error.message.startsWith("Transcript suffix exceeds synchronous planning ");
        if (this.boundedContextIncomplete || !exceededPlanningLimit) {
          throw error;
        }
        retainedContextPrefix = [];
        expectedPersistedEntries = currentEntries;
        useFullTranscriptFallback = true;
      }
    }
    const preparedEntries = [...retainedContextPrefix, ...expectedPersistedEntries];
    const prepared = new SessionManagerSuffixPersistence(this.cwd, undefined, preparedEntries);
    prepared.inheritResidentContextEntries(this);
    let removeStart: number | undefined;
    const removedEntries: SessionEntry[] = [];
    for (let index = 1; index < prepared.fileEntries.length; index += 1) {
      const entry = prepared.fileEntries[index];
      if (isIndexedSessionEntry(entry) && removedParentById.has(entry.id)) {
        removeStart ??= index;
        removedEntries.push(entry);
      }
    }
    const removedEntryIds = new Set(removedEntries.map((entry) => entry.id));
    if (removedEntryIds.size !== removedParentById.size) {
      throw new Error(`SQLite session changed before trimming ${this.sessionId}`);
    }
    if (removeStart === undefined) {
      return 0;
    }
    const localPersistedPrefixLength =
      removeStart + prepared.opaqueFileEntries.filter((entry) => entry.index < removeStart).length;
    const preparedSuffixOffset = retainedContextPrefix.length;
    const persistedPrefixLength = useFullTranscriptFallback
      ? 0
      : (persistedSuffixStartSeq ?? Math.max(0, localPersistedPrefixLength - preparedSuffixOffset));
    const persistedBoundaryCount = this.persistedBoundaryCount;
    const removedBoundaryCount = removedEntries.filter(
      (entry) => entry.type === "compaction" || entry.type === "reset",
    ).length;
    for (let index = removeStart; index < prepared.fileEntries.length; index += 1) {
      const entry = prepared.fileEntries[index];
      if (
        isIndexedSessionEntry(entry) &&
        entry.type === "label" &&
        removedParentById.has(entry.targetId) &&
        !removedEntryIds.has(entry.id)
      ) {
        removedParentById.set(entry.id, entry.parentId);
      }
    }
    for (let index = prepared.fileEntries.length - 1; index >= removeStart; index -= 1) {
      const entry = prepared.fileEntries[index];
      if (!isIndexedSessionEntry(entry) || !removedParentById.has(entry.id)) {
        continue;
      }
      for (const opaqueEntry of prepared.opaqueFileEntries) {
        if (opaqueEntry.index > index) {
          opaqueEntry.index--;
        }
      }
      prepared.fileEntries.splice(index, 1);
    }

    const resolveRetainedParentId = (
      parentId: string | null,
      parentFor = (id: string) => removedParentById.get(id) ?? null,
    ): string | null => {
      const seen = new Set<string>();
      let currentId = parentId;
      while (currentId && removedParentById.has(currentId) && !seen.has(currentId)) {
        seen.add(currentId);
        currentId = parentFor(currentId);
      }
      return currentId;
    };
    const replacementParentId = resolveRetainedParentId(
      removedParentById.get(candidate.id) ?? null,
    );
    Object.assign(
      prepared,
      remapSuffixEntries(
        prepared.fileEntries,
        prepared.opaqueFileEntries,
        resolveRetainedParentId,
        admittedLabelRecords,
        prepared.residentContextEntries,
      ),
    );

    prepared.clampOpaqueFileEntryIndexes();
    prepared.buildIndex();
    for (const [id, parentId] of this.opaqueParentsById) {
      if (
        !removedParentById.has(id) &&
        !prepared.byId.has(id) &&
        !prepared.opaqueParentsById.has(id)
      ) {
        prepared.opaqueParentsById.set(id, resolveRetainedParentId(parentId));
      }
    }
    // Omitted canonical predecessors keep their identity; opaque predecessors only own raw cursors.
    prepared.leafId = resolveSessionCanonicalParentId(
      replacementParentId,
      {
        has: (id) =>
          prepared.byId.has(id) || (!removedParentById.has(id) && this.boundedParentIds.has(id)),
      },
      prepared.opaqueParentsById,
    );
    prepared.rawLeafId = replacementParentId;
    prepared.appendParentId = replacementParentId;
    const events = prepared.getPersistedFileEntries(
      prepared.appendMode,
      this.boundedContextIncomplete && persistedPrefixLength > 0,
    );
    const suffixEvents = preparedSuffixOffset > 0 ? events.slice(preparedSuffixOffset) : events;
    const incrementalPlanningBytes = [...expectedPersistedEntries, ...suffixEvents].reduce<number>(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event), "utf8"),
      0,
    );
    if (
      !this.boundedContextIncomplete &&
      (expectedPersistedEntries.length + suffixEvents.length > SYNC_REBUILD_MAX_ROWS ||
        incrementalPlanningBytes > SYNC_REBUILD_MAX_BYTES)
    ) {
      expectedPersistedEntries = currentEntries;
      useFullTranscriptFallback = true;
    }
    const replacementEvents = useFullTranscriptFallback
      ? events.map(restoreCustomData)
      : suffixEvents;
    const adoptPrepared = (
      version?: typeof this.transcriptVersion,
      reload?: () => PreparedSessionTranscriptReload,
      failure?: SessionManagerActorCommittedError,
      rewritten?: { firstIndex: number; firstSeq: number },
    ) => {
      try {
        if (failure) {
          throw failure;
        }
        worker?.assertCurrent();
        history?.assertCurrent();
        if (reload) {
          const committed = reload();
          if (
            committed.snapshot.version.generation !== version?.generation ||
            committed.snapshot.version.rawSeq !== version?.rawSeq ||
            committed.snapshot.version.updatedAt !== version?.updatedAt
          ) {
            throw new Error("Session transcript changed before committed suffix publication");
          }
          committed.snapshot.events = committed.snapshot.events.map(restoreCustomData);
          publication.beginAdoption();
          this.adoptPreparedTranscriptReload(committed);
          this.contextStartEntryId = contextStartEntryId;
          this.enforceResidentBudget();
          return;
        }
        if (this.persistenceTarget) {
          publishRewrittenSuffixLabels(prepared.admittedLabelRecords, replacementEvents, rewritten);
        }
        // Paired anchors share the rewritten view's revision, including omitted ancestors.
        const retainedParents = remapSuffixParentFacts(
          this.boundedParentIds,
          removedParentById,
          resolveRetainedParentId,
        );
        // Publish the detached tree before later post-commit observers can append through this manager.
        publication.beginAdoption();
        this.fileEntries = prepared.fileEntries.map(restoreCustomData);
        this.residentContextEntries = prepared.residentContextEntries;
        this.opaqueFileEntries = prepared.opaqueFileEntries;
        // Omitted canonical anchors precede the loaded suffix; their ordinals remain unchanged.
        const retainedTranscriptSeqs = this.captureTranscriptEntrySeqs([
          ...retainedContextPrefix.flatMap((entry) =>
            isIndexedSessionEntry(entry) ? [entry.id] : [],
          ),
          ...[...retainedParents.keys()].filter((id) => !prepared.byId.has(id)),
        ]);
        this.buildIndex(prepared.admittedLabelRecords);
        this.boundedParentIds = retainedParents;
        this.transcriptSeqByEntryId = retainedTranscriptSeqs;
        for (const [id, parentId] of prepared.opaqueParentsById) {
          if (!this.byId.has(id) && !this.opaqueParentsById.has(id)) {
            this.opaqueParentsById.set(id, parentId);
          }
        }
        this.leafId = prepared.leafId;
        this.rawLeafId = prepared.rawLeafId;
        this.appendParentId = prepared.appendParentId;
        this.appendMode = prepared.appendMode;
        this.pendingDeliberateAppend = prepared.pendingDeliberateAppend;
        this.boundedContextIncomplete = Boolean(
          this.boundedContextLimits && this.persistenceTarget,
        );
        this.persistedBoundaryCount =
          persistedBoundaryCount === undefined
            ? undefined
            : Math.max(0, persistedBoundaryCount - removedBoundaryCount);
        this.persistedSuffixStartSeq = this.boundedContextIncomplete
          ? retainedContextPrefix.length > 0
            ? this.persistedSuffixStartSeq
            : persistedSuffixStartSeq
          : undefined;
        this.transcriptVersion = version;
        this.transcriptMutationAt = version?.updatedAt;
        this.contextStartEntryId = contextStartEntryId;
        this.enforceResidentBudget();
      } catch (cause) {
        if (!version) {
          throw cause;
        }
        const error = new Error("Session transcript suffix committed but view publication failed", {
          cause,
        });
        error.name = "SessionSuffixCommittedError";
        recordModelFallbackStop(error);
        publication.invalidate(error, version);
        throw error;
      }
    };
    if (this.persistenceTarget) {
      history?.assertCurrent();
      const replacementTarget = this.persistenceTarget;
      const args: SessionMaintenanceOperations["session.transcript.replaceSuffix"]["input"]["args"] =
        [
          expectedPersistedEntries,
          replacementEvents,
          useFullTranscriptFallback ? 0 : persistedPrefixLength,
          this.transcriptMutationAt,
          persistedSuffixStartSeq !== undefined && !useFullTranscriptFallback,
          useFullTranscriptFallback ? [] : retainedCustomDataIds,
        ];
      const publish = (
        version: NonNullable<typeof this.transcriptVersion>,
        rewritten?: { firstIndex: number; firstSeq: number },
      ) =>
        adoptPrepared(
          version,
          native ? () => native.reload([...retainedCustomData.keys()]) : undefined,
          undefined,
          rewritten,
        );
      const replaced = yield* sessionPersistenceStep(
        () =>
          native
            ? native.replace(args, publish)
            : replaceTranscriptSuffixEventsSync(
                replacementTarget,
                args[0],
                args[1],
                args[2],
                args[3],
                publish,
                args[4],
                args[5],
              ),
        worker
          ? async () => {
              const receipt = await worker.replace(args, [...retainedCustomData.keys()]);
              const result = receipt.value;
              if (result.replaced) {
                adoptPrepared(
                  result.version,
                  this.boundedContextLimits
                    ? () => {
                        if (!result.reload?.ok) {
                          throw committedTranscriptViewError(result.reload?.error);
                        }
                        return result.reload.value;
                      }
                    : undefined,
                  receipt.failure,
                  result.rewritten,
                );
              } else if (receipt.failure) {
                throw receipt.failure;
              }
              return result.replaced;
            }
          : undefined,
      );
      if (!replaced) {
        throw new Error(`SQLite session changed before trimming ${this.sessionId}`);
      }
    } else {
      adoptPrepared();
    }
    return removedEntries.length;
  }
}
