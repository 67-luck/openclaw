import { isDeepStrictEqual } from "node:util";
import type { MessagePort } from "node:worker_threads";
import {
  createSessionReconcileTaskDelegate,
  type SessionReconcileEndpointIdentity,
} from "../config/sessions/session-transcript-reconcile-delegation.js";
import { attachSessionTranscriptReconcileDelegate } from "../config/sessions/session-transcript-reconcile-pool.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_PREPARE_NATIVE,
  SQLITE_WORKER_PREPARE_ADMITTED,
  SQLITE_WORKER_OPERATION_CLEANUP,
  SQLITE_WORKER_EXECUTE_SCOPED,
  type SqliteWorkerCommand,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "./openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { createAgentDatabaseCommandOwner } from "./openclaw-agent-execution-commands.js";
import type { AgentDatabaseOperations } from "./openclaw-agent-execution-contract.js";

export type VolatileAgentDatabaseTarget = { id: string; agentId: string; path: string };
export type VolatileAgentDatabaseOpen = {
  kind: "volatile-broker";
  id: string;
  projection: SessionReconcileEndpointIdentity;
};
export type VolatileAgentDatabaseOperations = {
  "database.volatile.execute": {
    input: {
      target: VolatileAgentDatabaseTarget;
      createIfMissing: boolean;
      command: SqliteWorkerCommand<AgentDatabaseOperations>;
    };
    output: unknown;
  };
  "database.volatile.close": { input: VolatileAgentDatabaseTarget; output: void };
};

/** Logical stores live in the canonical native cache inside this one process broker actor. */
export function createVolatileAgentDatabaseBackend(
  opening: VolatileAgentDatabaseOpen,
  projection: MessagePort,
): SqliteWorkerPreparedBackend<VolatileAgentDatabaseOperations> {
  type Logical = {
    target: VolatileAgentDatabaseTarget;
    database: OpenClawAgentDatabase;
    commands: ReturnType<typeof createAgentDatabaseCommandOwner>;
  };
  const logical = new Map<string, Logical>();
  attachSessionTranscriptReconcileDelegate(
    createSessionReconcileTaskDelegate(projection, opening.projection, (owner) => {
      const current = logical.get(owner.path);
      if (!current || current.target.agentId !== owner.agentId || !current.database.db.isOpen) {
        throw new Error("Transcript compute has no retained logical native owner");
      }
      return {
        ...current.target,
        incarnation: readOpenClawAgentDatabaseIdentity(current.database).incarnation,
      };
    }),
  );
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Volatile agent broker is closed");
    }
  };
  const find = (target: VolatileAgentDatabaseTarget) => {
    assertOpen();
    const current = logical.get(target.path);
    if (current && !isDeepStrictEqual(current.target, target)) {
      throw new Error("Volatile agent execution belongs to another logical incarnation");
    }
    return current;
  };
  const facts = (target: VolatileAgentDatabaseTarget, database?: OpenClawAgentDatabase) => ({
    kind: "volatile",
    brokerId: opening.id,
    target,
    ...(database ? { incarnation: readOpenClawAgentDatabaseIdentity(database).incarnation } : {}),
  });
  const prepareLogical = (target: VolatileAgentDatabaseTarget, create: boolean) => {
    let current = find(target);
    if (!current && create) {
      const options = {
        agentId: target.agentId,
        path: target.path,
        env: getSqliteWorkerStateContext().environment,
      };
      if (!isIncognitoOpenClawAgentSqlitePath(target.path, options)) {
        throw new Error("Volatile agent execution requires its logical incognito locator");
      }
      requestSqliteWorkerOperationAdmission({ stage: "open", facts: facts(target) });
      const database = openOpenClawAgentDatabase(options);
      const assertCurrent = () => {
        if (find(target)?.database !== database || !database.db.isOpen) {
          throw new Error("Volatile agent execution lost its native database");
        }
        return database;
      };
      const commands = createAgentDatabaseCommandOwner({
        options,
        getPreparedDatabase: () => assertCurrent().db,
        assertCurrent,
        assertCleanupCurrent() {
          assertCurrent();
        },
        admit(stage, admitted) {
          requestSqliteWorkerOperationAdmission({
            stage,
            facts: { ...facts(target, database), ...admitted },
          });
        },
      });
      current = { target: structuredClone(target), database, commands };
      logical.set(target.path, current);
    }
    if (current) {
      requestSqliteWorkerOperationAdmission({
        stage: "prepare",
        facts: facts(target, current.database),
      });
    }
    return current;
  };
  const closeLogical = async (current: Logical) => {
    current.commands.close();
    await closeOpenClawAgentDatabaseByPathAsync(current.target.path, current.target.agentId);
    logical.delete(current.target.path);
  };
  return {
    [SQLITE_WORKER_EXECUTE_SCOPED](request, retain) {
      if (request.type !== "database.volatile.execute") {
        throw new Error("A nested session scope cannot close its actor or logical owner");
      }
      // Connection sharing never supplies authority: this child asks its own
      // original open/prepare grant before entering the selected logical domain.
      const current = prepareLogical(request.input.target, request.input.createIfMissing);
      if (!current) {
        return undefined;
      }
      return current.commands.executeScoped(request.input.command, retain);
    },
    [SQLITE_WORKER_PREPARE_NATIVE](request) {
      if (request.type === "database.volatile.execute") {
        const current = prepareLogical(request.input.target, request.input.createIfMissing);
        current?.commands.beginRequest();
      }
    },
    async prepare(request) {
      if (request.type === "database.volatile.close") {
        const current = find(request.input);
        if (current) {
          await closeLogical(current);
        }
        return;
      }
      if (request.type !== "database.volatile.execute") {
        return;
      }
      const current = find(request.input.target);
      const command = request.input.command;
      if (!current || command.type === "database.prepareWrite") {
        return;
      }
      await current.commands.prepare(command);
    },
    [SQLITE_WORKER_PREPARE_ADMITTED](request) {
      if (request.type !== "database.volatile.execute") {
        return undefined;
      }
      const current = find(request.input.target);
      const command = request.input.command;
      if (current && command.type === "database.domain.publish") {
        return current.commands.preparePublication(command.input);
      }
      return undefined;
    },
    [SQLITE_WORKER_OPERATION_CLEANUP](request) {
      if (request.type !== "database.volatile.execute") {
        return;
      }
      const current = find(request.input.target);
      const command = request.input.command;
      if (current) {
        try {
          if (
            command.type === "database.domain.publish" ||
            command.type === "database.domain.run"
          ) {
            current.commands.cleanupPublication(command.input.id);
          }
        } finally {
          current.commands.endRequest();
        }
      }
    },
    execute(request) {
      if (request.type === "database.volatile.close") {
        return undefined;
      }
      const current = find(request.input.target);
      const command = request.input.command;
      if (!current || command.type === "database.prepareWrite") {
        return undefined;
      }
      return current.commands.execute(command);
    },
    assertSettled() {
      for (const current of logical.values()) {
        current.commands.assertSettled();
        assertTransactionUsable(current.database.db);
      }
    },
    async close() {
      closed = true;
      const errors: unknown[] = [];
      for (const current of logical.values()) {
        try {
          await closeLogical(current);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Volatile agent database cleanup failed",
          errors[0],
        );
      }
      projection.close();
    },
  };
}
