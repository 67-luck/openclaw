import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { hasSqlitePostCommitScope } from "../../infra/sqlite-post-commit.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

export class SqliteTranscriptMutationConflictError extends Error {
  constructor(sessionId: string) {
    super(`SQLite transcript changed while preparing rewrite for ${sessionId}`);
    this.name = "SqliteTranscriptMutationConflictError";
  }
}

export type TranscriptWriteSnapshot<T> = {
  result: T;
  lifecycleRevision?: string;
  before: SessionTranscriptContextVersion;
  after: SessionTranscriptContextVersion;
};

export type TranscriptWriteViewGuard = {
  assertCurrent: () => void;
  onPendingTransaction: (database: DatabaseSync) => void;
};

export function runTranscriptWriteSnapshotSync<T>(
  scope: SessionTranscriptWriteScope,
  operation: (
    database: OpenClawAgentDatabase,
    resolved: ReturnType<typeof resolveSqliteTranscriptScope>,
  ) => T,
  beforeCommitInTransaction?: () => void,
  expectedMutationAt?: number | null,
  view?: TranscriptWriteViewGuard,
): Result<TranscriptWriteSnapshot<T>, TranscriptAppendRefusal> {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let connection: DatabaseSync | undefined;
  const result = runOpenClawAgentWriteTransaction<
    Result<TranscriptWriteSnapshot<T>, TranscriptAppendRefusal>
  >(
    (database) => {
      connection = database.db;
      return runTranscriptWriteSnapshotInTransaction(
        database,
        fencedScope,
        operation,
        beforeCommitInTransaction,
        expectedMutationAt,
        view,
      );
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.transcript.write-snapshot" },
  );
  // A savepoint can return while its enclosing transaction still owns rollback.
  if (result.ok && connection && hasSqlitePostCommitScope(connection)) {
    view?.onPendingTransaction(connection);
  }
  if (fencedScope.expectedWriterRunId !== undefined && !result.ok) {
    throw new SessionTranscriptWriterClaimReboundError(result.error);
  }
  return result;
}

/** Reuse the admitted writing connection; never reopen it to read commit facts. */
export function runTranscriptWriteSnapshotInTransaction<T>(
  database: OpenClawAgentDatabase,
  scope: SessionTranscriptWriteScope,
  operation: (
    database: OpenClawAgentDatabase,
    resolved: ReturnType<typeof resolveSqliteTranscriptScope>,
  ) => T,
  beforeCommitInTransaction?: () => void,
  expectedMutationAt?: number | null,
  view?: TranscriptWriteViewGuard,
): Result<TranscriptWriteSnapshot<T>, TranscriptAppendRefusal> {
  if (!database.db.isTransaction) {
    throw new Error("Transcript append requires its admitted writer transaction");
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  beforeCommitInTransaction?.();
  view?.assertCurrent();
  assertOwnedTranscriptWriteCommit(scope);
  const fresh = readSessionEntryRow(database, resolved.sessionKey, "list");
  const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, scope);
  if (refusal) {
    return err(refusal);
  }
  const before = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
  if (expectedMutationAt !== undefined && before.updatedAt !== expectedMutationAt) {
    throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
  }
  const lifecycleRevision = fresh?.entry.lifecycleRevision;
  const value = operation(database, resolved);
  view?.assertCurrent();
  assertOwnedTranscriptWriteCommit(scope);
  return ok({
    result: value,
    lifecycleRevision,
    before,
    after: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
  });
}
