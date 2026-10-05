import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { prepareTranscriptRewriteSync } from "../../config/sessions/session-accessor.sqlite-branch-rewrite.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  assertSqliteTranscriptWriteIdentity,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptSuffixEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-suffix-write.js";
import { replaceSessionWithBranchedTranscriptInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionMaintenanceOperations } from "../../config/sessions/session-manager-write-contract.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../../config/sessions/session-transcript-index.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { prepareBranchedSession } from "./session-manager-branch-path.js";
import { isIndexedSessionEntry } from "./session-manager-codec.js";
import {
  readCommittedTranscriptRewrite,
  rewriteSessionTranscriptMessages,
} from "./session-manager-rewrite.worker.js";

type SessionMaintenanceContext = {
  database: DatabaseSync;
  admit(stage: "transaction" | "commit"): void;
  /** Native owners publish before later same-process commit observers. */
  publishSuffixCommit?(version: SessionTranscriptContextVersion): void;
};

export function executeSessionMaintenance(
  command: Extract<
    SqliteWorkerCommand<SessionMaintenanceOperations>,
    { type: "session.transcript.rewriteMessages" }
  >,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations["session.transcript.rewriteMessages"]["output"];
export function executeSessionMaintenance(
  command: Extract<
    SqliteWorkerCommand<SessionMaintenanceOperations>,
    { type: "session.transcript.branch" }
  >,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations["session.transcript.branch"]["output"];
export function executeSessionMaintenance(
  command: Extract<
    SqliteWorkerCommand<SessionMaintenanceOperations>,
    { type: "session.transcript.replaceSuffix" }
  >,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations["session.transcript.replaceSuffix"]["output"];
export function executeSessionMaintenance(
  command: Extract<
    SqliteWorkerCommand<SessionMaintenanceOperations>,
    { type: "session.transcript.rewrite" }
  >,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations["session.transcript.rewrite"]["output"];
export function executeSessionMaintenance(
  command: SqliteWorkerCommand<SessionMaintenanceOperations>,
  scope: SessionTranscriptWriteScope,
  context: SessionMaintenanceContext,
): SessionMaintenanceOperations[keyof SessionMaintenanceOperations]["output"] {
  // The host retains reconciliation beyond this worker command's lifetime.
  let projectionNeedsReconcile = false;
  const projection = {
    scheduleProjectionReconcile: false,
    onProjectionReconcileNeeded: () => {
      projectionNeedsReconcile = true;
    },
  };
  if (command.type === "session.transcript.rewriteMessages") {
    return rewriteSessionTranscriptMessages(
      { ...command.input.scope, ...scope },
      command.input.request,
      command.input.version,
      command.input.appendParentId,
      context.database,
      () => {},
      command.input.retention,
      (stage) => context.admit(stage),
    );
  }
  if (command.type === "session.transcript.branch") {
    const { branch, version: expected } = command.input;
    const resolved = resolveSqliteTranscriptScope(scope);
    const retainedEntryIds = new Set(command.input.retainedEntryIds);
    let selectedLeafEntryId: string | undefined;
    const committed = runOpenClawAgentWriteTransaction(
      (database) => {
        if (database.db !== context.database) {
          throw new Error("Session branch lost its borrowed canonical connection");
        }
        context.admit("transaction");
        const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
        if (
          version.generation !== expected.generation ||
          version.rawSeq !== expected.rawSeq ||
          version.updatedAt !== expected.updatedAt
        ) {
          throw new Error("Session transcript changed during branch preparation");
        }
        const prepared = prepareBranchedSession(
          readTranscriptEventRows(database, resolved.sessionId).map((row) =>
            JSON.parse(row.eventJson),
          ),
          branch.leafId,
          branch.header,
        );
        selectedLeafEntryId = prepared.selectedLeafEntryId;
        for (const entry of prepared.events) {
          if (isIndexedSessionEntry(entry) && entry.type === "label") {
            retainedEntryIds.add(entry.id);
          }
        }
        retainedEntryIds.add(branch.leafId);
        const result = replaceSessionWithBranchedTranscriptInTransaction(
          database,
          scope,
          { sessionId: branch.header.id, events: prepared.events },
          command.input.expectedLifecycleRevision,
          undefined,
          projection,
        );
        if (command.input.limits) {
          reconcileSessionTranscriptIndexInTransaction(database.db, branch.header.id);
          projectionNeedsReconcile = false;
        }
        context.admit("commit");
        return { ...result, projectionNeedsReconcile };
      },
      toDatabaseOptions(resolved),
      { operationLabel: command.type },
    );
    try {
      const reload = readCommittedTranscriptRewrite(
        { ...command.input.scope, ...scope, sessionId: branch.header.id },
        command.input.limits,
        [...retainedEntryIds],
        command.input.retainedCustomDataIds,
        selectedLeafEntryId,
      );
      serialize(reload);
      return { ...committed, reload: { ok: true, value: reload } };
    } catch (error) {
      return {
        ...committed,
        reload: {
          ok: false,
          error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
        },
      };
    }
  }
  if (command.type === "session.transcript.replaceSuffix") {
    assertSqliteTranscriptWriteIdentity(scope);
    const { sessionId } = scope;
    const [expected, next, prefix, mutationAt, startsAtPrefix, retained] = command.input.args;
    let version: SessionTranscriptContextVersion | undefined;
    let rewritten: { firstIndex: number; firstSeq: number } | undefined;
    const replaced = replaceTranscriptSuffixEventsSync(
      scope,
      expected,
      next,
      prefix,
      mutationAt,
      (committed, positions) => {
        version = committed;
        rewritten = positions;
        context.publishSuffixCommit?.(committed);
      },
      startsAtPrefix,
      retained,
      (stage) => {
        if (stage === "commit" && command.input.limits && projectionNeedsReconcile) {
          // The bounded receipt reads this projection before the host can schedule reconciliation.
          reconcileSessionTranscriptIndexInTransaction(context.database, sessionId);
          projectionNeedsReconcile = false;
        }
        context.admit(stage);
      },
      projection,
    );
    return { replaced, version, rewritten, projectionNeedsReconcile };
  }
  let version: SessionTranscriptContextVersion | undefined;
  const publish = prepareTranscriptRewriteSync(
    scope,
    command.input.appendParentId,
    () => {},
    command.input.version,
    (stage) => context.admit(stage),
    { messagesAlreadyRedacted: true, ...projection },
  );
  publish(command.input.entries, new Map(command.input.sources), (committed) => {
    version = committed;
  });
  if (!version) {
    throw new Error("Session rewrite did not return its committed version");
  }
  return { version, entries: command.input.entries, projectionNeedsReconcile };
}
