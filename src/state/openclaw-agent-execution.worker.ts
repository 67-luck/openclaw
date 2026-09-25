import { serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import type { Result } from "@openclaw/normalization-core/result";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  onSqliteWalCheckpoint,
  type SqliteWalCheckpointSnapshot,
} from "../infra/sqlite-wal-checkpoint.js";
import {
  SQLITE_WORKER_CLOSE_RECEIPT,
  SQLITE_WORKER_PREPARE_NATIVE,
  type SqliteWorkerCloseReceipt,
  type SqliteWorkerPreparedBackend,
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
} from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  SqliteWorkerOpenRefusedError,
} from "../infra/sqlite-worker-operation-admission.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { prepareOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import {
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { getOpenClawAgentDatabaseIfOpen, openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { createAgentDatabaseCommandOwner } from "./openclaw-agent-execution-commands.js";
import type {
  AgentDatabaseExecutionIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import { prepareAgentDatabaseScopedDomains } from "./openclaw-agent-execution-domain.js";
import {
  createVolatileAgentDatabaseBackend,
  type VolatileAgentDatabaseOpen,
} from "./openclaw-agent-execution-volatile.worker.js";
import {
  requireOpenClawStateDatabaseIdentity,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

export function createSqliteWorkerBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string },
): SqliteWorkerPreparedBackend<AgentDatabaseOperations> {
  const backend = openAgentDatabaseBackend(input, opening);
  try {
    backend.execute({ type: "database.prepareWrite", input: undefined });
    backend.assertSettled?.();
    return backend;
  } catch (error) {
    try {
      backend.close();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Agent creation and cleanup failed",
        error,
      );
    }
    throw error;
  }
}

/** Gateway readiness includes the native message kernel, before any synchronous SDK call. */
export async function createVolatileSqliteWorkerBackend(
  input: VolatileAgentDatabaseOpen,
  opening: { backendService?: MessagePort },
) {
  if (!opening.backendService) {
    throw new Error("Volatile agent backend requires its compute endpoint");
  }
  await prepareAgentDatabaseScopedDomains();
  return createVolatileAgentDatabaseBackend(input, opening.backendService);
}

/** The broker supplies a private admission channel before invoking this native factory. */
export function openExistingSqliteWorkerBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string; existingIdentity?: string },
): SqliteWorkerPreparedBackend<AgentDatabaseOperations> {
  return openAgentDatabaseBackend(input, opening);
}

type AgentDatabaseNativeBackend = Omit<
  SqliteWorkerPreparedBackend<AgentDatabaseOperations>,
  "close"
> & {
  close(): void;
};

function openAgentDatabaseBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string; existingIdentity?: string },
): AgentDatabaseNativeBackend {
  if (opening.databasePath !== input.databasePath) {
    throw new Error("Agent database open does not match its captured execution owner");
  }
  const admitOpen = () => {
    try {
      requestSqliteWorkerOperationAdmission({ stage: "open", facts: input });
    } catch (error) {
      throw new SqliteWorkerOpenRefusedError(error);
    }
  };
  admitOpen();
  const options = { agentId: input.agentId, path: input.databasePath, env: input.environment };
  const preparedFileIdentity =
    input.creatingIdentity?.key ??
    opening.existingIdentity ??
    readDatabasePathIdentitySync(input.databasePath).key;
  let admittedFileIdentity = preparedFileIdentity;
  let admittedFileBirthtime = input.creatingIdentity?.birthtime;
  const assertFileIdentity = () => {
    if (input.expectedIdentity) {
      assertExistingDatabaseIdentity(
        input.databasePath,
        `file:${input.expectedIdentity.physicalIdentity}`,
        input.expectedIdentity.birthtime,
      );
    }
    if (admittedFileIdentity.startsWith("path:")) {
      const current = readDatabasePathIdentitySync(input.databasePath);
      if (
        current.key !== admittedFileIdentity ||
        (input.creatingIdentity && current.canonicalPath !== input.creatingIdentity.canonicalPath)
      ) {
        throw new Error("Agent database target changed before creating open");
      }
    } else {
      if (
        input.creatingIdentity &&
        readDatabasePathIdentitySync(input.databasePath).canonicalPath !==
          input.creatingIdentity.canonicalPath
      ) {
        throw new Error("Agent database target changed before creating open");
      }
      assertExistingDatabaseIdentity(
        input.databasePath,
        admittedFileIdentity,
        admittedFileBirthtime,
      );
    }
  };
  let database: OpenClawAgentDatabase | undefined;
  let shared: ReturnType<typeof openOpenClawStateDatabase> | undefined;
  let sharedBorrow: ReturnType<typeof retainOpenClawStateDatabase> | undefined;
  let releaseBorrow: (() => void) | undefined;
  let identity: AgentDatabaseExecutionIdentity | undefined;
  let openingFailure: { error: unknown } | undefined;
  const requirePreparedDatabase = () => {
    if (!database || !database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options) !== database) {
      throw new Error("Agent execution lost its retained native database");
    }
    return database;
  };
  const openWriter = () => {
    let validation: OpenClawAgentDatabaseValidation | undefined;
    if (!database) {
      // Promotion needs the current command's source authority before any durable open work.
      admitOpen();
      assertFileIdentity();
      if (!shared) {
        shared = openOpenClawStateDatabase({
          path: input.stateDatabasePath,
          env: input.environment,
          initializationAgentPaths: [input.databasePath],
        });
        sharedBorrow = retainOpenClawStateDatabase(shared);
      }
      const lease = prepareOpenClawAgentDatabaseWorkerLease(options, shared, input.leaseId);
      const { port1, port2 } = new MessageChannel();
      try {
        requestSqliteWorkerOperationAdmission(
          {
            stage: "prepare",
            facts: {
              kind: "shared-owner",
              identity: requireOpenClawStateDatabaseIdentity(shared),
              lease: lease.receipt,
              validationPort: port2,
            },
          },
          [port2],
        );
        // The host posts before granting admission; shared revocation remains live after transfer.
        // SAFETY: this private port receives only the host's typed validation receipt.
        lease.validation = receiveMessageOnPort(port1)?.message as
          | OpenClawAgentDatabaseValidation
          | undefined;
      } catch (error) {
        throw new SqliteWorkerOpenRefusedError(error);
      } finally {
        port1.close();
        port2.close();
      }
      assertFileIdentity();
      let registration: OpenClawAgentDatabaseRegistrationCommit | undefined;
      let openingResult: Result<OpenClawAgentDatabase, unknown>;
      try {
        const opened = openOpenClawAgentDatabase(options, lease, (receipt) => {
          registration = receipt;
        });
        database = opened;
        releaseBorrow = retainAgentDatabase(opened.db);
        openingResult = { ok: true, value: opened };
      } catch (error) {
        // The opener can retain a failed native handle before returning one to this actor.
        openingFailure = { error };
        openingResult = { ok: false, error };
      }
      if (registration) {
        try {
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: { kind: "agent-registration-committed", registration },
          });
        } catch (error) {
          if (!openingResult.ok) {
            throw createSqliteLifecycleAggregateError(
              [openingResult.error, error],
              `${String(openingResult.error)}; committed registration reporting failed: ${String(error)}`,
              openingResult.error,
            );
          }
          throw error;
        }
      }
      if (!openingResult.ok) {
        throw openingResult.error;
      }
      const opened = openingResult.value;
      const nativeIdentity = readOpenClawAgentDatabaseIdentity(opened);
      if (typeof nativeIdentity.identity !== "string") {
        throw new Error("Disk agent execution requires its canonical file identity");
      }
      const openedFileIdentity = `file:${nativeIdentity.identity}`;
      if (
        admittedFileIdentity.startsWith("file:") &&
        (openedFileIdentity !== admittedFileIdentity ||
          (admittedFileBirthtime !== undefined &&
            nativeIdentity.birthtime !== admittedFileBirthtime))
      ) {
        throw new Error("Agent writer differs from its admitted physical file");
      }
      if (
        input.expectedIdentity &&
        nativeIdentity.identity !== input.expectedIdentity.physicalIdentity
      ) {
        throw new Error("Agent writer differs from its expected physical file");
      }
      admittedFileIdentity = openedFileIdentity;
      admittedFileBirthtime = nativeIdentity.birthtime;
      identity = {
        kind: "file",
        physicalIdentity: nativeIdentity.identity,
        birthtime: nativeIdentity.birthtime,
        incarnation: nativeIdentity.incarnation,
        nativeLocation: nativeIdentity.filename,
      };
      validation = getOpenClawAgentDatabaseValidation(opened);
    }
    const current = requirePreparedDatabase();
    requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: { identity, validation } });
    return current;
  };
  const admit = (
    stage: "transaction" | "commit",
    admitted?: { domain?: unknown; publication?: unknown },
  ) => {
    assertFileIdentity();
    const facts = {
      identity,
      ...(admitted?.domain === undefined ? {} : { domain: admitted.domain }),
      ...(admitted?.publication === undefined ? {} : { publication: admitted.publication }),
    };
    // Commands/results retain broker framing. Only this unframed authority
    // envelope is bounded; never duplicate transcript bodies in domain facts.
    if (serialize(facts).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
      throw new SqliteWorkerError("Agent admission facts exceed the transport limit", "overloaded");
    }
    requestSqliteWorkerOperationAdmission({ stage, facts });
    if (stage === "commit") {
      ensureOpenClawAgentDatabasePermissions(input.databasePath, options);
    }
  };
  const commands = createAgentDatabaseCommandOwner({
    options,
    getPreparedDatabase() {
      assertOpen();
      const current = requirePreparedDatabase();
      assertFileIdentity();
      return current.db;
    },
    assertCurrent() {
      assertOpen();
      const current = openWriter();
      assertFileIdentity();
      return current;
    },
    admit,
  });
  let closed = false;
  let closeReceipt: SqliteWorkerCloseReceipt | undefined;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Agent database execution owner is closed");
    }
  };
  return {
    [SQLITE_WORKER_PREPARE_NATIVE](command) {
      // A composite domain binds after async loading; promotion must happen
      // here under the original command's admission, never in that async phase.
      if (command.type === "database.domain.run") {
        commands.execute({ type: "database.prepareWrite", input: undefined });
      }
    },
    prepare: commands.prepare,
    assertSettled() {
      if (openingFailure) {
        // A failed promotion requires native retirement, including custody retained by the opener.
        throw openingFailure.error;
      }
      commands.assertSettled();
      if (database) {
        assertTransactionUsable(database.db);
        if (!identity || !database.db.isOpen || database.db.isTransaction) {
          throw new Error("Agent database command left an unsettled native connection");
        }
      }
    },
    execute(command) {
      assertOpen();
      return commands.execute(command);
    },
    [SQLITE_WORKER_CLOSE_RECEIPT]() {
      return closeReceipt;
    },
    close() {
      closed = true;
      closeReceipt = undefined;
      let checkpoint: SqliteWalCheckpointSnapshot | undefined;
      const errors: unknown[] = [];
      for (const cleanup of [
        () => commands.close(),
        () => {
          if (!database) {
            return;
          }
          const closingPath = sqliteReaderDatabasePathKey(database.path);
          const stopObserving = onSqliteWalCheckpoint((observation) => {
            if (observation.databasePath === closingPath) {
              checkpoint = {
                health: observation.health,
                observedAtNs: observation.observedAtNs,
              };
            }
          });
          try {
            closeOpenClawAgentDatabaseByPath(database.path, database.agentId);
          } finally {
            stopObserving();
          }
        },
        () => releaseBorrow?.(),
        () => sharedBorrow?.release(),
      ]) {
        try {
          cleanup();
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
          "Agent database cleanup failed",
          errors[0],
        );
      }
      if (identity && checkpoint) {
        closeReceipt = {
          identity: {
            key: `file:${identity.physicalIdentity}`,
            canonicalPath: identity.nativeLocation,
          },
          incarnation: identity.incarnation,
          checkpoint,
        };
      }
    },
  };
}
