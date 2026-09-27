import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSessionHistoryPrelude } from "../../../packages/agent-core/src/harness/session/session.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import type { TranscriptAppendRefusal } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { readSessionTranscriptCurrentTurnEntry } from "../../config/sessions/session-accessor.sqlite-current-turn.js";
import {
  readCommittedIncognitoSessionSharing,
  readExactSessionEntryCandidatesInDatabase,
} from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.sqlite-entry-list.read.js";
import {
  applySessionEntryPatchInDatabase,
  readSessionEntryPatchSnapshot,
} from "../../config/sessions/session-accessor.sqlite-entry-mutation.js";
import {
  listSessionChildEntriesReadOnly,
  resolveSessionKeyBySessionId,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  loadExactSessionEntryCandidates,
  loadSessionEntryByIdReadOnly,
  loadSessionEntryReadOnlyResultInScope,
  resolveSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import { ensureSessionEntryInTransaction } from "../../config/sessions/session-accessor.sqlite-initial-entry.js";
import { readTranscriptMutationAtSync } from "../../config/sessions/session-accessor.sqlite-metadata-read.js";
import {
  readSessionTranscriptModelContext,
  withSessionTranscriptContextCursor,
  validateSessionTranscriptContextAdmission,
  validateSessionTranscriptContextAnchor,
  validateSessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import {
  inspectTranscriptEventsSync,
  loadTranscriptReadSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { prepareSessionEntryReplacementPublication } from "../../config/sessions/session-accessor.sqlite-replacement-state.js";
import {
  resolveSqliteTranscriptScope,
  resolveSqliteTranscriptReadScope,
  getSessionKysely,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { appendTranscriptEventSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  assertCanonicalSessionKeyWrite,
  readWithCanonicalSessionAdmission,
} from "../../config/sessions/session-canonical-key.js";
import { readSessionRowEntryInDatabase } from "../../config/sessions/session-entry-read.worker.js";
import {
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
} from "../../config/sessions/session-sharing-store.kernel.js";
import type { SessionTranscriptContextNext } from "../../config/sessions/session-transcript-context-scope.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { executeSqliteQueryTakeFirstSync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { requestSqliteWorkerHostStep } from "../../infra/sqlite-worker-native-scope.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import type {
  MetadataTarget,
  SessionEntryReadResult,
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
} from "./session-manager-metadata-contract.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";

function copyTranscriptRefusal(value: unknown): TranscriptAppendRefusal | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.agentIdHash !== "string" ||
    typeof value.expectedSessionIdHash !== "string" ||
    typeof value.sessionKeyHash !== "string"
  ) {
    throw new Error("Session metadata refusal has an invalid identity");
  }
  const identity = {
    agentIdHash: value.agentIdHash,
    expectedSessionIdHash: value.expectedSessionIdHash,
    sessionKeyHash: value.sessionKeyHash,
  };
  if (value.code === "session-entry-missing") {
    return { ...identity, code: value.code };
  }
  if (value.code === "session-rebound" && typeof value.actualSessionIdHash === "string") {
    return { ...identity, code: value.code, actualSessionIdHash: value.actualSessionIdHash };
  }
  throw new Error("Session metadata refusal has an invalid kind");
}

function readCommittedMetadataView(
  scope: MetadataTarget,
  limits: SessionManagerBoundedContextLimits | undefined,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
): PreparedSessionTranscriptReload {
  return runWithSessionTranscriptReadFence(admission, (): PreparedSessionTranscriptReload => {
    if (limits) {
      return {
        kind: "bounded",
        snapshot: readSessionTranscriptBoundedActiveContextCore(scope, {
          ...limits,
          ...(admission !== undefined ? { ignoreReadFence: true } : {}),
        }),
      };
    }
    if (admission !== undefined) {
      const inspected = inspectTranscriptEventsSync(scope);
      return {
        kind: "full",
        snapshot: {
          events: inspected.events,
          version: {
            generation: inspected.snapshot.generation,
            rawSeq: inspected.snapshot.lastSeq,
            updatedAt: inspected.snapshot.transcriptUpdatedAt,
          },
        },
      };
    }
    return { kind: "full", snapshot: loadTranscriptReadSnapshotSync(scope) };
  });
}

/** Borrow the canonical actor's connection; this domain never opens or closes a database. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit", facts?: unknown): void;
    assertTransactionBoundary?(): void;
  },
): SqliteWorkerBackend<SessionMetadataWorkerOperations> {
  let closed = false;
  const assertOpen = () => {
    if (closed || !context.database.isOpen) {
      throw new Error("Session metadata domain is closed");
    }
    assertTransactionUsable(context.database);
  };
  const execute = (
    command: SqliteWorkerCommand<SessionMetadataOperations>,
  ): SessionMetadataWorkerOperations[keyof SessionMetadataWorkerOperations]["output"] => {
    assertOpen();
    if (
      command.type === "session.metadata.entrySnapshot" ||
      command.type === "session.metadata.entryPatch" ||
      command.type === "session.metadata.entryRead"
    ) {
      const input = command.input;
      const resolved = { ...input.scope, env: getSqliteWorkerStateContext().environment };
      const options = toDatabaseOptions(resolved);
      const database = getOpenClawAgentDatabaseIfOpen(options);
      if (!database || database.db !== context.database || database.path !== context.databasePath) {
        throw new Error("Session entry command changed its original native owner");
      }
      const physical = readOpenClawAgentDatabaseIdentity(database);
      const descriptor = {
        incarnation: physical.incarnation,
        physical: {
          identity:
            typeof physical.identity === "string" ? physical.identity : physical.incarnation,
          ...(physical.birthtime ? { birthtime: physical.birthtime } : {}),
        },
      };
      if (command.type === "session.metadata.entryRead") {
        const { query, expected } = command.input;
        if (
          expected &&
          (expected.identity !== descriptor.physical.identity ||
            expected.birthtime !== descriptor.physical.birthtime ||
            (expected.incarnation !== undefined && expected.incarnation !== descriptor.incarnation))
        ) {
          throw new Error("Captured session database changed before read");
        }
        const scope = {
          agentId: resolved.agentId,
          storePath: database.path,
          env: resolved.env,
          sessionKey: resolved.sessionKey,
        };
        let result: SessionEntryReadResult;
        switch (query.kind) {
          case "resolve":
            result = {
              kind: query.kind,
              value: resolveSessionEntry(scope, {
                ...query.options,
                databaseAgentId: database.agentId,
              }),
            };
            break;
          case "resolve-result": {
            const selected = loadSessionEntryReadOnlyResultInScope({
              ...scope,
              databaseAgentId: database.agentId,
              projection: query.projection,
            });
            if (selected.ok) {
              result = { kind: query.kind, value: selected };
            } else {
              const error = encodeOpenClawStateWorkerError(selected.error, {
                includeOrdinary: true,
              });
              if (!error) {
                throw selected.error;
              }
              result = { kind: query.kind, value: { ok: false, error } };
            }
            break;
          }
          case "candidates":
            result = {
              kind: query.kind,
              value: loadExactSessionEntryCandidates({
                readSource: { agentId: database.agentId, path: database.path },
                env: resolved.env,
                sessionKeys: query.sessionKeys,
                projection: query.projection,
                readOnly: true,
              }),
            };
            break;
          case "batch":
            result = {
              kind: query.kind,
              value: readWithCanonicalSessionAdmission(database, () =>
                readExactSessionEntryCandidatesInDatabase(
                  database,
                  query.sessionKeys,
                  query.projection,
                ).map((selected) =>
                  selected.ok
                    ? selected
                    : {
                        ok: false as const,
                        error: encodeOpenClawStateWorkerError(selected.error, {
                          includeOrdinary: true,
                        }),
                      },
                ),
              ),
            };
            break;
          case "key-occupied":
            result = {
              kind: query.kind,
              value:
                query.sessionKeys.length > 0 &&
                Boolean(
                  executeSqliteQueryTakeFirstSync(
                    database.db,
                    getSessionKysely(database.db)
                      .selectFrom("session_nodes")
                      .select("session_key")
                      .where("session_key", "in", sqliteStringSet(query.sessionKeys))
                      .limit(1),
                  ),
                ),
            };
            break;
          case "by-id":
            result = {
              kind: query.kind,
              value: loadSessionEntryByIdReadOnly({
                ...scope,
                sessionId: query.sessionId,
                projection: query.projection,
              }),
            };
            break;
          case "key-by-id":
            result = {
              kind: query.kind,
              value: resolveSessionKeyBySessionId({ ...scope, sessionId: query.sessionId }),
            };
            break;
          case "children":
            result = {
              kind: query.kind,
              value: listSessionChildEntriesReadOnly({ ...scope, projection: query.projection }),
            };
            break;
          case "row":
            result = {
              kind: query.kind,
              value: readSessionRowEntryInDatabase(database, resolved.sessionKey),
            };
            break;
          case "sharing":
            result = {
              kind: query.kind,
              value: readCommittedIncognitoSessionSharing(database.db, resolved.sessionKey),
            };
            break;
          case "members":
            result = {
              kind: query.kind,
              value: listSessionMembersInDatabase(database, resolved.sessionKey),
            };
            break;
          case "has-member":
            result = {
              kind: query.kind,
              value: hasSessionMemberInDatabase(database, resolved.sessionKey, query.identityId),
            };
            break;
          case "list":
            result = {
              kind: query.kind,
              value: listSessionEntriesReadOnly(
                {
                  ...query.scope,
                  agentId: database.agentId,
                  storePath: database.path,
                  env: resolved.env,
                },
                query.options,
              ),
            };
            break;
        }
        return { ok: true, value: { result, ...descriptor } };
      }
      if (command.type === "session.metadata.entrySnapshot") {
        return {
          ok: true,
          value: {
            prepared: readSessionEntryPatchSnapshot(database, command.input.selection),
            ...descriptor,
          },
        };
      }
      const patch = command.input;
      assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
      if (patch.incarnation !== physical.incarnation) {
        throw new Error("Captured session database changed before update");
      }
      const facts = {
        kind: "session-entry.patch",
        operationId: patch.operationId,
        databasePath: context.databasePath,
        sessionKey: resolved.sessionKey,
        incarnation: physical.incarnation,
      };
      const mutation = runOpenClawAgentWriteTransaction((writer) => {
        if (writer.db !== context.database) {
          throw new Error("Session entry patch lost its native transaction");
        }
        context.admit("transaction", facts);
        const skipped =
          patch.shouldCommit &&
          requestSqliteWorkerHostStep({
            kind: "entry-should-commit",
            value: { operationId: patch.operationId },
          }) === false;
        const result = skipped
          ? { entry: null }
          : applySessionEntryPatchInDatabase(writer, {
              operationLabel: patch.operationLabel,
              validateCanonicalKeys: patch.validateCanonicalKeys,
              readSnapshot: (current) => readSessionEntryPatchSnapshot(current, patch.selection),
              prepared: patch.prepared,
              sessionKey: resolved.sessionKey,
              writeBase: patch.writeBase,
              next: patch.next,
              options: {
                consumePendingReset: patch.consumePendingReset,
                providerReviewMutation: patch.providerReviewMutation,
                ...(patch.assertCommitAllowed
                  ? {
                      assertCommitAllowed: () => {
                        requestSqliteWorkerHostStep({
                          kind: "entry-before-write",
                          value: { operationId: patch.operationId },
                        });
                      },
                    }
                  : {}),
              },
            });
        const publication =
          "identity" in result && result.identity
            ? prepareSessionEntryReplacementPublication({
                ...result.identity,
                // Metadata patches do not request replacement archive recovery.
                pendingArchiveRecovery: false,
                maintenancePlans: [],
                membershipInvalidatedKeys: [],
              })
            : undefined;
        context.admit("commit", { ...facts, publication });
        deferSqliteWorkerCommitReceipt(context.database, { ...facts, result, publication });
        return result;
      }, options);
      return { ok: true, value: mutation };
    }
    if (command.type === "session.metadata.context") {
      const scope = { ...command.input.scope, env: getSqliteWorkerStateContext().environment };
      const resolved = resolveSqliteTranscriptReadScope(scope);
      if (toDatabaseOptions(resolved).path !== context.databasePath) {
        throw new Error("Session context read changed its native database owner");
      }
      const result = runWithSessionTranscriptReadFence(command.input.admission, () =>
        withSessionTranscriptContextCursor(
          scope,
          (messages, header, version) => {
            deferSqliteWorkerCommitReceipt(context.database, { kind: "session-context" });
            requestSqliteWorkerHostStep(
              { kind: "session-context", value: { header, version } },
              (action): SessionTranscriptContextNext => {
                if (action.kind === "return") {
                  messages.return(undefined);
                  return { done: true };
                }
                const next = messages.next();
                return next.done
                  ? { done: true }
                  : {
                      done: false,
                      value: next.value,
                      historyPrelude: isSessionHistoryPrelude(next.value),
                    };
              },
            );
          },
          true,
        ),
      );
      return { ok: true, value: result.found };
    }
    // Database execution already carries the captured host environment. Command payloads
    // must not transport process.env or its non-cloneable Windows semantics proxy.
    const scope = { ...command.input.scope, env: getSqliteWorkerStateContext().environment };
    const resolved = resolveSqliteTranscriptScope(scope);
    const options = toDatabaseOptions(resolved);
    if (
      readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(options)).canonicalPath !==
      context.databasePath
    ) {
      throw new Error("Session metadata target changed its database owner");
    }
    scope.storePath = context.databasePath;
    resolved.path = context.databasePath;
    options.path = context.databasePath;
    if (command.type === "session.metadata.activeAnchor") {
      return {
        ok: true,
        value: readActiveTranscriptEntryAnchorInTransaction({
          database: { db: context.database, path: context.databasePath },
          resolved,
          entryId: command.input.entryId,
        }),
      };
    }
    if (command.type === "session.metadata.modelContext") {
      return {
        ok: true,
        value: runWithSessionTranscriptReadFence(command.input.admission, () =>
          readSessionTranscriptModelContext(scope, command.input.through, command.input.limits),
        ),
      };
    }
    if (command.type === "session.metadata.validateContext") {
      const { admission, through, version } = command.input;
      if (admission) {
        validateSessionTranscriptContextAdmission(scope, admission);
      } else if (!through) {
        validateSessionTranscriptContextVersion(scope, version);
      }
      if (through) {
        validateSessionTranscriptContextAnchor(scope, through);
      }
      return { ok: true, value: undefined };
    }
    if (command.type === "session.metadata.read") {
      const limits = command.input.limits;
      return {
        ok: true,
        value: runWithSessionTranscriptReadFence(
          command.input.admission,
          (): PreparedSessionTranscriptReload =>
            limits
              ? {
                  kind: "bounded",
                  snapshot: readSessionTranscriptBoundedActiveContextCore(scope, {
                    ...limits,
                    readOnly: true,
                  }),
                }
              : {
                  kind: "full",
                  snapshot: loadTranscriptReadSnapshotSync(scope, { readOnly: true }),
                },
        ),
      };
    }
    if (command.type === "session.metadata.currentTurn") {
      return {
        ok: true,
        value: runWithSessionTranscriptReadFence(command.input.admission, () =>
          readSessionTranscriptCurrentTurnEntry(scope, {
            ...command.input.request,
            readOnly: true,
          }),
        ),
      };
    }
    if (command.type === "session.metadata.mutation") {
      return { ok: true, value: readTranscriptMutationAtSync(scope) };
    }
    assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
    const outcome = runOpenClawAgentWriteTransaction<
      SessionMetadataWorkerOperations[
        | "session.metadata.initialize"
        | "session.metadata.append"]["output"]
    >((database) => {
      if (database.db !== context.database) {
        throw new Error("Session metadata lost its borrowed canonical connection");
      }
      context.admit(
        "transaction",
        command.type === "session.metadata.initialize"
          ? { kind: command.type, sessionKey: resolved.sessionKey }
          : undefined,
      );
      if (command.type === "session.metadata.initialize") {
        const physical = readOpenClawAgentDatabaseIdentity(database);
        const committed = ensureSessionEntryInTransaction(
          database,
          resolved,
          scope,
          command.input.entry,
          command.input.initialWriterRunId,
        );
        const result = {
          ...committed,
          identity: committed.identity && {
            ...committed.identity,
            databaseIdentity:
              typeof physical.identity === "string" ? physical.identity : physical.incarnation,
          },
        };
        const receipt = {
          kind: command.type,
          sessionKey: resolved.sessionKey,
          sessionId: scope.sessionId,
          created: result.identity !== undefined,
          databaseIdentity: result.identity?.databaseIdentity,
        };
        context.admit("commit", receipt);
        deferSqliteWorkerCommitReceipt(context.database, receipt);
        return { ok: true, value: result };
      }
      let projectionNeedsReconcile = false;
      const projection = {
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded: () => {
          projectionNeedsReconcile = true;
        },
      } as const;
      const snapshot = appendTranscriptEventSnapshotSync(
        scope,
        command.input.event,
        command.input.options,
        projection,
      );
      context.admit("commit");
      deferSqliteWorkerCommitReceipt(context.database, {
        kind: command.type,
        sessionKey: resolved.sessionKey,
        sessionId: scope.sessionId,
      });
      return { ok: true, value: { snapshot, projectionNeedsReconcile } };
    }, options);
    if (
      outcome.ok &&
      "projectionNeedsReconcile" in outcome.value &&
      outcome.value.projectionNeedsReconcile &&
      isIncognitoOpenClawAgentSqlitePath(context.databasePath, options)
    ) {
      // The memory source and its write claims stay here; only compute is delegated
      // to the process-owned projection pool through the enrolled endpoint.
      const start = () =>
        startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: scope.sessionId });
      if (!deferSqlitePostCommitPublication(context.database, start)) {
        start();
      }
    }
    if (
      command.type === "session.metadata.append" &&
      command.input.event.type !== "session" &&
      command.input.view &&
      outcome.ok &&
      "snapshot" in outcome.value &&
      outcome.value.snapshot.ok
    ) {
      const { event, view } = command.input;
      const committed = outcome.value.snapshot.value;
      if (!committed.result?.appended) {
        return outcome;
      }
      const version = view.loadedVersion;
      const effectiveParentId = committed.result.effectiveParentId;
      if (
        (version &&
          (committed.before.generation !== version.generation ||
            committed.before.rawSeq !== version.rawSeq)) ||
        (effectiveParentId !== undefined && effectiveParentId !== event.parentId)
      ) {
        try {
          outcome.value.reload = {
            ok: true,
            value: readCommittedMetadataView(scope, view.limits, view.admission),
          };
          // Detect view serialization failure while the small committed receipt is still retained.
          serialize(outcome);
        } catch (error) {
          // This transaction already committed. Preserve its receipt across read failure.
          outcome.value.reload = {
            ok: false,
            error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
          };
        }
      }
    }
    return outcome;
  };
  return {
    execute(command) {
      try {
        return execute(command);
      } catch (error) {
        if (error instanceof SessionTranscriptWriterClaimReboundError) {
          return { ok: false, refusal: copyTranscriptRefusal(error.cause) };
        }
        throw error;
      }
    },
    assertSettled() {
      assertOpen();
      if (context.assertTransactionBoundary) {
        return context.assertTransactionBoundary();
      }
      if (context.database.isTransaction) {
        throw new Error("Session metadata command left a transaction open");
      }
    },
    close() {
      closed = true;
    },
  };
}
