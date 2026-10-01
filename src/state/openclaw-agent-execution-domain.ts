import type { DatabaseSync } from "node:sqlite";
import { isPromise } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  assertSyncTransactionResult,
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
} from "../infra/sqlite-worker-contract.js";
import {
  requestSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";

export type AgentDatabaseAdmissionRestriction = (
  request: SqliteWorkerAdmissionRequest,
  dispatch: (request: SqliteWorkerAdmissionRequest) => void,
) => void;

export type AgentDatabaseDomainAdmission = {
  facts?: unknown;
  requestAdmission?: AgentDatabaseAdmissionRestriction;
};

/** A domain restriction must obtain exactly one grant for the original native stage. */
export function requestRestrictedAgentDatabaseAdmission(
  request: SqliteWorkerAdmissionRequest,
  restriction?: AgentDatabaseAdmissionRestriction,
): void {
  const { stage } = request;
  let admitted = false;
  const dispatch = (restricted: SqliteWorkerAdmissionRequest) => {
    if (admitted || restricted.stage !== stage) {
      throw new Error("Agent admission restriction changed its native stage");
    }
    requestSqliteWorkerOperationAdmission(restricted);
    admitted = true;
  };
  if (restriction) {
    restriction(request, dispatch);
  } else {
    dispatch(request);
  }
  if (!admitted) {
    throw new Error("Agent admission restriction omitted its native grant");
  }
}

export type AgentDatabaseDomainOperations = {
  "database.domain.bind": {
    input: { id: string; moduleUrl: string; input: unknown };
    output: void;
  };
  "database.domain.execute": {
    input: { id: string; command: SqliteWorkerCommand<SqliteWorkerOperations> };
    output: unknown;
  };
  "database.domain.publish": {
    input: {
      id: string;
      moduleUrl: string;
      input: unknown;
      command: SqliteWorkerCommand<SqliteWorkerOperations>;
    };
    output: unknown;
  };
  "database.domain.close": { input: { id: string }; output: void };
  "database.domain.run": {
    input: {
      id: string;
      moduleUrl: string;
      input: unknown;
      command: SqliteWorkerCommand<SqliteWorkerOperations>;
      scoped?: true;
    };
    output: unknown;
  };
};

type DomainFactory = (input: unknown, context: unknown) => unknown;
const scopedFactories = new Map<string, DomainFactory>();
async function loadFactory(href: string): Promise<DomainFactory> {
  const module: unknown = await import(href);
  if (!isRecord(module) || typeof module.bindSqliteWorkerBackend !== "function") {
    throw new Error("Agent publication module must export bindSqliteWorkerBackend");
  }
  const factory = module.bindSqliteWorkerBackend;
  return (input, bindingContext) => factory(input, bindingContext);
}

/** Prepare the fixed session domains before any retained native snapshot can open. */
export async function prepareAgentDatabaseScopedDomains() {
  for (const entry of [
    runtimeProcessEntrypoints.sessionManagerMetadata,
    runtimeProcessEntrypoints.sessionManagerMessage,
  ]) {
    const href = resolveRuntimeWorkerUrl(entry).href;
    if (!scopedFactories.has(href)) {
      scopedFactories.set(href, await loadFactory(href));
    }
  }
}

/** One admitted publication scope borrows the canonical connection; it never owns its close. */
export function createAgentDatabaseDomainOwner(context: {
  databasePath: string;
  getPreparedDatabase(): DatabaseSync;
  assertCurrent(): DatabaseSync;
  assertCleanupCurrent(): void;
  takePreparation(): unknown;
  admit(stage: "transaction" | "commit", admission?: AgentDatabaseDomainAdmission): void;
}) {
  let binding:
    | {
        id: string;
        backend: SqliteWorkerPreparedBackend<SqliteWorkerOperations>;
        authority: { active: boolean };
      }
    | undefined;
  let prepared: { id: string; factory: (input: unknown, context: unknown) => unknown } | undefined;
  let failedBinding = false;

  const requireBinding = (id: string) => {
    if (!binding || binding.id !== id || !binding.authority.active) {
      throw new Error("Agent database operation lost its bound publication scope");
    }
    return binding;
  };
  const bind = (
    input: AgentDatabaseDomainOperations["database.domain.bind"]["input"],
    database: DatabaseSync,
  ) => {
    if (!prepared || prepared.id !== input.id || binding) {
      throw new Error("Agent publication module was not prepared for this scope");
    }
    const factory = prepared.factory;
    prepared = undefined;
    failedBinding = true;
    const authority = { active: true };
    const outerTransaction = database.isTransaction;
    try {
      const backend = factory(input.input, {
        databasePath: context.databasePath,
        database,
        takePreparation() {
          if (!authority.active) {
            throw new Error("Agent publication preparation outlived its bound scope");
          }
          return context.takePreparation();
        },
        admit: (stage: "transaction" | "commit", admission?: AgentDatabaseDomainAdmission) => {
          if (!authority.active) {
            throw new Error("Agent publication cleanup cannot admit a transaction");
          }
          context.admit(stage, admission);
        },
        assertTransactionBoundary() {
          assertTransactionUsable(database);
          if (database.isTransaction !== outerTransaction) {
            throw new Error("Session domain changed its retained transaction boundary");
          }
        },
      });
      if (isPromise(backend)) {
        void backend.catch(() => {});
        throw new Error("Connection-bound publication factories must remain synchronous");
      }
      if (
        !isRecord(backend) ||
        typeof backend.execute !== "function" ||
        typeof backend.close !== "function" ||
        typeof backend.assertSettled !== "function" ||
        (SQLITE_WORKER_PREPARE_COMMAND in backend &&
          backend[SQLITE_WORKER_PREPARE_COMMAND] !== undefined &&
          typeof backend[SQLITE_WORKER_PREPARE_COMMAND] !== "function") ||
        (backend.prepare !== undefined && typeof backend.prepare !== "function")
      ) {
        throw new Error("Agent publication module returned an invalid connection-bound backend");
      }
      binding = {
        id: input.id,
        // SAFETY: Factory methods were checked above; the paired module owns command decoding.
        backend: backend as SqliteWorkerPreparedBackend<SqliteWorkerOperations>,
        authority,
      };
      failedBinding = false;
    } catch (error) {
      authority.active = false;
      throw error;
    }
  };
  const prepareCommand = async (
    input: AgentDatabaseDomainOperations["database.domain.execute"]["input"],
  ) => {
    const current = requireBinding(input.id);
    const loading = current.backend[SQLITE_WORKER_PREPARE_COMMAND]?.(input.command.type);
    if (loading) {
      await loading;
    }
    await current.backend.prepare?.(input.command);
    if (requireBinding(input.id) !== current) {
      throw new Error("Agent publication changed during command preparation");
    }
  };
  const closeBinding = () => {
    if (!binding) {
      return;
    }
    binding.authority.active = false;
    const closed = binding.backend.close();
    if (closed !== undefined) {
      void closed.catch(() => {});
      throw new Error("Connection-bound publication cleanup must remain synchronous");
    }
    binding = undefined;
  };

  const owner = {
    async prepare(command: SqliteWorkerCommand<AgentDatabaseDomainOperations>) {
      if (command.type === "database.domain.run") {
        try {
          if (command.input.scoped) {
            // Nested session calls cannot import modules while their parent holds
            // a synchronous snapshot. Prepare only these existing domain factories.
            await prepareAgentDatabaseScopedDomains();
          }
          await owner.prepare({ type: "database.domain.bind", input: command.input });
          // Async preparation only borrows the retained connection. Execution
          // revalidates live authority inside the run's existing cleanup owner.
          bind(command.input, context.getPreparedDatabase());
          await owner.prepare({ type: "database.domain.execute", input: command.input });
        } catch (error) {
          try {
            owner.close();
          } catch (cleanupError) {
            throw createSqliteLifecycleAggregateError(
              [error, cleanupError],
              "Agent publication preparation and cleanup failed",
              error,
            );
          }
          throw error;
        }
        return;
      }
      if (command.type === "database.domain.bind" || command.type === "database.domain.publish") {
        if (binding || prepared) {
          throw new Error("Agent database already has an admitted publication scope");
        }
        const url = new URL(command.input.moduleUrl);
        if (url.protocol !== "file:" || url.search || url.hash) {
          throw new Error("Agent publication requires a static local module URL");
        }
        prepared = {
          id: command.input.id,
          factory: scopedFactories.get(url.href) ?? (await loadFactory(url.href)),
        };
      } else if (command.type === "database.domain.execute") {
        await prepareCommand(command.input);
      }
    },
    async preparePublication(
      input: AgentDatabaseDomainOperations["database.domain.publish"]["input"],
    ) {
      bind(input, context.assertCurrent());
      requireBinding(input.id).backend.assertSettled?.();
      // End the synchronous factory admission before invoking either asynchronous preparation hook.
      await Promise.resolve();
      await prepareCommand(input);
    },
    cleanupPublication(id: string) {
      if (binding?.id === id) {
        context.assertCleanupCurrent();
        closeBinding();
      }
    },
    executeNested(
      command: Extract<
        SqliteWorkerCommand<AgentDatabaseDomainOperations>,
        { type: "database.domain.run" }
      >,
      retain: (database: DatabaseSync) => void,
    ): unknown {
      const factory = scopedFactories.get(command.input.moduleUrl);
      if (!factory) {
        throw new Error("Nested session domain was not prepared by its original scope");
      }
      const database = context.assertCurrent();
      retain(database);
      const outer = { binding, prepared, failedBinding };
      binding = undefined;
      prepared = { id: command.input.id, factory };
      failedBinding = false;
      try {
        // A domain failure after its inner write must still roll back this entire
        // child, including staged receipts, without disturbing the parent's snapshot.
        return withSqlitePostCommitPublications(database, () =>
          runSqliteDeferredTransactionSync(database, () => {
            const failures: unknown[] = [];
            let result: unknown;
            try {
              owner.execute({ type: "database.domain.bind", input: command.input });
              const current = requireBinding(command.input.id);
              const loading = current.backend[SQLITE_WORKER_PREPARE_COMMAND]?.(
                command.input.command.type,
              );
              if (isPromise(loading)) {
                void loading.catch(() => {});
              }
              assertSyncTransactionResult(loading);
              const preparation = current.backend.prepare?.(command.input.command);
              if (isPromise(preparation)) {
                void preparation.catch(() => {});
              }
              assertSyncTransactionResult(preparation);
              result = owner.execute({ type: "database.domain.execute", input: command.input });
              assertSyncTransactionResult(result);
              owner.assertSettled();
            } catch (error) {
              failures.push(error);
            }
            try {
              owner.close();
            } catch (error) {
              failures.push(error);
            }
            if (failures.length === 1) {
              throw failures[0];
            }
            if (failures.length > 1) {
              throw createSqliteLifecycleAggregateError(
                failures,
                "Nested session operation and cleanup failed",
                failures[0],
              );
            }
            return result;
          }),
        );
      } finally {
        binding = outer.binding;
        prepared = outer.prepared;
        failedBinding = outer.failedBinding;
      }
    },
    execute(command: SqliteWorkerCommand<AgentDatabaseDomainOperations>): unknown {
      if (command.type === "database.domain.run") {
        let result: unknown;
        const failures: unknown[] = [];
        try {
          result = owner.execute({ type: "database.domain.execute", input: command.input });
          owner.assertSettled();
        } catch (error) {
          failures.push(error);
        }
        try {
          owner.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw createSqliteLifecycleAggregateError(
            failures,
            "Agent publication and cleanup failed",
            failures[0],
          );
        }
        return result;
      }
      const database = context.assertCurrent();
      if (command.type === "database.domain.bind") {
        bind(command.input, database);
        return undefined;
      }
      const current = requireBinding(command.input.id);
      if (command.type === "database.domain.close") {
        closeBinding();
        return undefined;
      }
      return current.backend.execute(command.input.command);
    },
    assertSettled(this: void) {
      prepared = undefined;
      if (failedBinding) {
        throw new Error("Agent publication binding did not settle");
      }
      if (binding && !binding.authority.active) {
        throw new Error("Agent publication cleanup did not settle");
      }
      binding?.backend.assertSettled?.();
    },
    close(this: void) {
      closeBinding();
      prepared = undefined;
    },
  };
  return owner;
}
