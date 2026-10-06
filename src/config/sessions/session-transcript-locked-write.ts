import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import { captureSessionPendingInputWorkerCustody } from "./session-accessor.sqlite-pending-inputs.js";
import type { SqliteTranscriptSnapshotState } from "./session-accessor.sqlite-read.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { prepareTranscriptMessageAppendForWorker } from "./session-accessor.sqlite-transcript-message-append.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptWriteLockAccessorContext,
} from "./session-accessor.types.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type {
  LockedTranscriptCommitted,
  SessionMessageRewriteOperations,
} from "./session-message-rewrite.worker.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import {
  captureExternalSessionCommitGuard,
  prepareSessionSourceAuthority,
  type PreparedSessionSourceAuthority,
  type SessionSourcePredicateFacts,
} from "./session-source-authority.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { captureOwnedTranscriptWriteAssertion } from "./transcript-write-context.js";

/** One callback retains the physical reader and canonical writer through accepted settlement. */
export function withWorkerTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope &
    ResolvedTranscriptScope & { env: NodeJS.ProcessEnv; path: string; storePath: string },
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
  native: <R>(
    scope: SessionTranscriptWriteScope,
    run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<R> | R,
    alreadyLocked?: boolean,
    snapshot?: SqliteTranscriptSnapshotState,
    onSnapshot?: (snapshot: SqliteTranscriptSnapshotState | undefined) => void,
  ) => Promise<R>,
): Promise<T> {
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  const custody = captureSessionPendingInputWorkerCustody();
  const initialDatabase = { ...toDatabaseOptions(scope), path: scope.path };
  const identity = readDatabasePathIdentitySync(scope.path);
  const execution = identity.key.startsWith("file:")
    ? undefined
    : captureOpenClawAgentDatabaseExecution(initialDatabase, {
        expectedCreationIdentity: identity,
      });
  const read = () =>
    withSessionTranscriptReadSource(
      scope,
      () => {
        throw new Error("Worker transcript lock requires a durable target");
      },
      async (source) => {
        const resolved = {
          ...source.resolved,
          sessionKey: source.resolved.sessionKey ?? scope.sessionKey,
        };
        const database = { ...toDatabaseOptions(resolved), path: source.scope.storePath };
        const fenced = { ...scope, ...source.scope, sessionId: resolved.sessionId };
        const owned = await prepareSessionSourceAuthority(assertOwned);
        if (owned.nativeSource) {
          // Released synchronous authority callbacks reread the database; revisit at the next SDK major.
          try {
            source.assertCurrent();
            return await native(fenced, run);
          } finally {
            await owned.release?.();
          }
        }
        let freshSource: PreparedSessionSourceAuthority | undefined;
        let fresh = false;
        let custodyRequired = false;
        const assertCurrent = () => {
          source.assertCurrent();
          owned.assertCurrent();
          if (fresh) {
            freshSource?.assertCurrent();
          }
        };
        const result = await runSessionEntryWorkerOperation<
          LockedTranscriptCommitted,
          { value: T } | LockedTranscriptCommitted
        >({
          database,
          agentId: resolved.agentId,
          assertCurrent,
          candidateKind: "session-transcript-locked",
          retainedExecution: execution,
          releaseSource: () => owned.release?.(),
          prepareWorker: () => ({
            async prepare() {
              const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
              await restoreSessionColdTranscript(fenced, assertCurrent);
            },
            beforeWrite: assertCurrent,
            async release() {},
          }),
          onTransactionFacts(facts) {
            if (!isRecord(facts)) {
              return false;
            }
            if (facts.kind === "session-transcript-lock-source") {
              fresh = facts.fresh === true;
              const authority = fresh ? freshSource : owned;
              authority?.assertCurrent();
              if (isRecord(facts.refusedSource) && typeof facts.refusedSource.index === "number") {
                authority?.checks[facts.refusedSource.index]?.refuse(
                  // SAFETY: The paired worker reads these facts in the current transaction.
                  facts.refusedSource.facts as SessionSourcePredicateFacts,
                );
                throw new Error("Session source refusal omitted its prepared assertion");
              }
              return true;
            }
            if (facts.kind === "session-transcript-lock-custody") {
              if (!custody) {
                throw new Error("Locked transcript has no pending-input custody");
              }
              custodyRequired = true;
              custody.assertCurrent(
                // SAFETY: The paired worker supplies current facts when custody has prepared authority.
                facts.authority as SessionPendingInputAuthorityFacts | undefined,
                assertCurrent,
              );
              return true;
            }
            return false;
          },
          assertCandidate(candidate) {
            if (custodyRequired) {
              custody?.assertCurrent(candidate.authority, assertCurrent);
            }
          },
          onAcknowledged(candidate) {
            if (candidate.custody) {
              custody?.publish(candidate.custody);
            }
            if (candidate.projectionNeedsReconcile) {
              startSessionTranscriptIndexReconcile({
                ...database,
                preferredSessionId: resolved.sessionId,
              });
            }
          },
          onCommitted: (candidate) => candidate,
          async run(worker, commit) {
            const target = {
              scope: resolved,
              fence: {
                expectedWriterRunId: fenced.expectedWriterRunId,
                expectedLifecycleRevision: fenced.expectedLifecycleRevision,
                expectedOwner: fenced.expectedOwner,
              },
              sources: owned.checks.map((check) => check.predicate),
            };
            let snapshot: SqliteTranscriptSnapshotState | undefined;
            const value = await withTranscriptLockSettlement((queue) => {
              const queued = <R>(operation: () => Promise<R>): Promise<R> =>
                queue(() => {
                  assertCurrent();
                  return operation();
                });
              const mutate = async (
                input: SessionMessageRewriteOperations["session.transcript.lock.commit"]["input"],
              ) => {
                const receipt = await commit(() =>
                  executeSessionMessageRewriteOperation(worker, database.agentId, {
                    type: "session.transcript.lock.commit",
                    input,
                  }),
                );
                if (!("kind" in receipt)) {
                  throw new Error("Locked transcript omitted its committed receipt");
                }
                // Transport preserves anchor fields but not their frozen state.
                if (receipt.result?.anchor) {
                  Object.freeze(receipt.result.anchor);
                }
                if (snapshot) {
                  snapshot = receipt.snapshot;
                }
                return receipt;
              };
              const append = async <TMessage>(
                options: LockedTranscriptMessageAppendOptions<TMessage>,
                sequenced: boolean,
              ) => {
                const {
                  config,
                  prepareMessageAfterIdempotencyCheck: legacyPrepare,
                  prepareMessageAfterIdempotencyCheckAsync: prepare,
                  beforeFreshMessageCommit,
                  ...serializable
                } = options;
                const freshGuard = captureExternalSessionCommitGuard(beforeFreshMessageCommit);
                const input = {
                  ...target,
                  options: serializable,
                  snapshot,
                  custody: custody?.facts,
                  relocation: custody?.relocation,
                };
                const expected =
                  prepare || beforeFreshMessageCommit
                    ? await executeSessionMessageRewriteOperation(worker, database.agentId, {
                        type: "session.transcript.lock.prepare",
                        input,
                      })
                    : undefined;
                const authority = await prepareSessionSourceAuthority(
                  expected?.pending || expected?.existing ? undefined : freshGuard,
                );
                if (
                  freshGuard?.nativeSource ||
                  authority.nativeSource ||
                  (legacyPrepare && !prepare)
                ) {
                  // Released synchronous authority callbacks reread the database; revisit at the next SDK major.
                  try {
                    return await native(
                      fenced,
                      async (context) =>
                        sequenced
                          ? context.appendMessageWithMessageSequence(options)
                          : { result: await context.appendMessage(options) },
                      true,
                      snapshot,
                      (next) => {
                        snapshot = next;
                      },
                    );
                  } finally {
                    await authority.release?.();
                  }
                }
                fresh = false;
                freshSource = authority;
                try {
                  let message: TMessage | undefined = options.message;
                  if (prepare && expected && !expected.pending && !expected.existing) {
                    message = await prepare(options.message);
                  }
                  assertCurrent();
                  const preparedMessageJson =
                    prepare && (expected?.pending || expected?.existing)
                      ? undefined
                      : isRecord(message)
                        ? prepareTranscriptMessageAppendForWorker({ message, config }).messageJson
                        : JSON.stringify(redactTranscriptMessageForStorage(message, { config }));
                  const receipt = await mutate({
                    ...input,
                    kind: "message",
                    freshSources: authority.checks.map((check) => check.predicate),
                    freshAuthorityPrepared:
                      !beforeFreshMessageCommit || (!expected?.pending && !expected?.existing),
                    sequenced,
                    preparedMessageJson,
                    ...(prepare && expected
                      ? {
                          preparation: {
                            message,
                            prepared: !expected.pending && !expected.existing,
                            version: expected.version,
                          },
                        }
                      : {}),
                  });
                  return {
                    lifecycleRevision: receipt.lifecycleRevision,
                    messageSeq: receipt.messageSeq,
                    // SAFETY: The paired command returns this append's generic message after storage redaction.
                    result: receipt.result as TranscriptMessageAppendResult<TMessage> | undefined,
                  };
                } finally {
                  fresh = false;
                  freshSource = undefined;
                  await authority.release?.();
                }
              };
              return run({
                publishUpdate: (update) => queued(() => publishTranscriptUpdate(fenced, update)),
                readEvents: () =>
                  queued(async () => {
                    const hydration = await source.owner.readTranscript({
                      target: { ...resolved, storePath: database.path },
                      resolvedScope: resolved,
                      expectedIdentity: source.expectedIdentity,
                      includeEventJson: true,
                    });
                    assertCurrent();
                    if (hydration.kind !== "full") {
                      throw new Error("Locked transcript requires complete history");
                    }
                    if (!hydration.snapshot.eventJson || !hydration.snapshot.eventSeqs) {
                      throw new Error("Locked transcript omitted its stored rows");
                    }
                    snapshot = {
                      kind: "current",
                      rows: hydration.snapshot.eventJson.map((eventJson, index) => ({
                        eventJson,
                        seq: hydration.snapshot.eventSeqs![index]!,
                      })),
                    };
                    return hydration.snapshot.events;
                  }),
                readMessageFacts: (params) =>
                  queued(async () => {
                    const facts = await executeSessionMessageRewriteOperation(
                      worker,
                      database.agentId,
                      { type: "session.transcript.lock.facts", input: { ...target, ...params } },
                    );
                    assertCurrent();
                    for (const anchor of facts.anchorsByIdempotencyKey.values()) {
                      Object.freeze(anchor);
                    }
                    return facts;
                  }),
                appendMessage: (options) =>
                  queued(async () => (await append(options, false)).result),
                appendMessageWithMessageSequence: (options) => queued(() => append(options, true)),
                replaceEvents: (events) =>
                  queued(async () => {
                    if (snapshot?.kind === "stale") {
                      throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
                    }
                    const receipt = await mutate({
                      ...target,
                      kind: "replace",
                      events,
                      snapshot,
                    });
                    snapshot = receipt.snapshot;
                  }),
              });
            });
            return { value };
          },
        });
        if (!("value" in result)) {
          throw new Error("Locked transcript omitted its callback result");
        }
        return result.value;
      },
    );
  if (!execution) {
    return read();
  }
  return withSessionEntryWorker(
    initialDatabase,
    undefined,
    () => execution.assertCurrent(),
    async (owner, source) => {
      await owner.prepare(source);
    },
    undefined,
    execution,
  )
    .then(read)
    .finally(() => execution.release());
}
