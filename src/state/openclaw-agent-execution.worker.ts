import { serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import type { Result } from "@openclaw/normalization-core/result";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_CLOSE_RECEIPT,
  SQLITE_WORKER_PREPARE_NATIVE,
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  SQLITE_WORKER_OPERATION_CLEANUP,
  SQLITE_WORKER_PREPARE_ADMITTED,
  type SqliteWorkerCloseReceipt,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  SqliteWorkerOpenRefusedError,
} from "../infra/sqlite-worker-operation-admission.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { prepareOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.js";
import { retainAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import {
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { getOpenClawAgentDatabaseIfOpen, openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { closeAgentDatabaseExecution } from "./openclaw-agent-execution-close.js";
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
  let startupJournalRequested = false;
  // This request-local flag is installed only for the synchronous native command below.
  const readDeletionJournal = () =>
    readAgentDeletionJournalStatusInDatabase(
      expectDefined(shared, "Agent execution shared-state owner").db,
      input.agentId,
    ) !== "absent";
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
        const opened = openOpenClawAgentDatabase(options, lease, {
          starting: () =>
            requestSqliteWorkerOperationAdmission({
              stage: "prepare",
              facts: { kind: "agent-registration-start", lease: lease.receipt },
            }),
          committed(receipt) {
            registration = receipt;
          },
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
    if (!database || !database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options) !== database) {
      throw new Error("Agent execution lost its retained native database");
    }
    requestSqliteWorkerOperationAdmission({
      stage: "prepare",
      facts: {
        identity,
        validation,
        ...(startupJournalRequested ? { agentDeletionJournalPresent: readDeletionJournal() } : {}),
      },
    });
    return database;
  };
  const admit = (
    stage: "transaction" | "commit",
    admitted?: { domain?: unknown; publication?: unknown },
  ) => {
    assertFileIdentity();
    const facts = {
      identity,
      ...(startupJournalRequested ? { agentDeletionJournalPresent: readDeletionJournal() } : {}),
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
    assertCleanupCurrent() {
      if (
        !database ||
        !identity ||
        !database.db.isOpen ||
        database.db.location() !== identity.nativeLocation ||
        getOpenClawAgentDatabaseIfOpen(options) !== database
      ) {
        throw new Error("Agent cleanup lost its retained native database");
      }
      assertFileIdentity();
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
      commands.beginRequest();
      if (command.type !== "database.domain.run") {
        return;
      }
      // Promotion and later execution consume one request-local attachment.
      // Async preparation never inherits the synchronous admission authority.
      startupJournalRequested = commands.startupJournal();
      try {
        commands.execute({ type: "database.prepareWrite", input: undefined });
      } finally {
        startupJournalRequested = false;
      }
    },
    prepare: commands.prepare,
    [SQLITE_WORKER_PREPARE_ADMITTED](command) {
      if (command.type !== "database.domain.publish") {
        return undefined;
      }
      startupJournalRequested = commands.startupJournal();
      try {
        return commands.preparePublication(command.input);
      } finally {
        startupJournalRequested = false;
      }
    },
    [SQLITE_WORKER_OPERATION_CLEANUP](command) {
      try {
        if (command.type === "database.domain.publish" || command.type === "database.domain.run") {
          startupJournalRequested = commands.hasRequest() ? commands.startupJournal() : false;
          commands.cleanupPublication(command.input.id);
        }
      } finally {
        startupJournalRequested = false;
        commands.endRequest();
      }
    },
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
      // Creating OPEN executes directly, without the ordinary preparation and
      // cleanup hooks. Its attachment belongs only to that opening job.
      const openingRequest = !commands.hasRequest();
      if (openingRequest) {
        if (command.type !== "database.prepareWrite") {
          throw new Error("Agent command lost its request-local preparation facts");
        }
        commands.beginRequest();
      }
      startupJournalRequested = commands.startupJournal();
      try {
        return commands.execute(command);
      } finally {
        startupJournalRequested = false;
        if (openingRequest) {
          commands.endRequest();
        }
      }
    },
    [SQLITE_WORKER_CLOSE_RECEIPT]() {
      return closeReceipt;
    },
    close() {
      closed = true;
      closeReceipt = undefined;
      closeReceipt = closeAgentDatabaseExecution({
        database,
        identity,
        closeDomain: () => commands.close(),
        releaseBorrow,
        releaseSharedBorrow: () => sharedBorrow?.release(),
      });
    },
  };
}
