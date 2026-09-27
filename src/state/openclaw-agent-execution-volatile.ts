import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSessionTranscriptReconcileEndpoint } from "../config/sessions/session-transcript-reconcile-pool.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { SqliteWorkerOpenCustody } from "../infra/sqlite-worker-broker.types.js";
import { createSqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import {
  isSqliteWorkerStoreAvailable,
  openVolatileAgentDatabaseSqliteWorkerStore,
  retainSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import { isIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseOperations,
  AgentDatabaseRequestExecutionSource,
} from "./openclaw-agent-execution-contract.js";
import type {
  AgentDatabaseExecutionScope,
  AgentDatabaseNativeGeneration,
} from "./openclaw-agent-execution-native.js";
import type {
  VolatileAgentDatabaseOperations,
  VolatileAgentDatabaseTarget,
} from "./openclaw-agent-execution-volatile.worker.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type Store = SqliteWorkerStore<VolatileAgentDatabaseOperations>;
export type AgentDatabaseReadyOperation = AgentDatabaseExecutionScope & {
  executeReady<K extends keyof AgentDatabaseOperations>(command: {
    type: K;
    input: AgentDatabaseOperations[K]["input"];
  }): AgentDatabaseOperations[K]["output"];
  close(): Promise<void>;
};

export type GatewayAgentDatabaseExecution = {
  readonly id: string;
  readonly context: OpenClawStateWorkerContext;
  phase: "preparing" | "ready" | "closing";
  readonly ready: Promise<void>;
  dataClosed: boolean;
  store?: Store;
  readonly projection: ReturnType<typeof createSessionTranscriptReconcileEndpoint>;
  retain(): { ready: Promise<void>; stop(): Promise<void> };
};

/** Reserve the process backend before bootstrap can create an incognito native owner. */
export function retainGatewayAgentDatabaseExecution(closeLogicalOwners: () => Promise<void>) {
  const context = captureOpenClawStateWorkerContext();
  const existing = agentDatabaseLifecycle.gatewayExecution;
  if (existing) {
    context.admission.assertCurrent();
    existing.context.admission.assertCurrent();
    if (
      existing.context.admission.databasePath !== context.admission.databasePath ||
      existing.context.admission.identity.key !== context.admission.identity.key
    ) {
      throw new Error("Close the existing Gateway session broker before changing shared storage");
    }
    return existing.retain();
  }
  if (
    [...agentDatabaseLifecycle.databases.values()].some(
      (database) => agentDatabaseLifecycle.incognito.has(database) && database.db.isOpen,
    )
  ) {
    throw new Error("Close the existing native incognito owner before starting the Gateway");
  }
  if (
    [...agentDatabaseLifecycle.retainedCloses].some(({ path, agentId }) =>
      isIncognitoOpenClawAgentSqlitePath(path, { agentId }),
    )
  ) {
    throw new Error("Native incognito cleanup must join before Gateway enrollment");
  }
  const id = randomUUID();
  const preparation = createDeferredCore();
  const projection = createSessionTranscriptReconcileEndpoint();
  let references = 0;
  let closing: Promise<void> | undefined;
  let cleanup: Parameters<NonNullable<SqliteWorkerOpenCustody["retainCleanup"]>>[0] | undefined;
  let nativeStopped: Promise<void> | undefined;
  const owner: GatewayAgentDatabaseExecution = {
    id,
    context,
    projection,
    phase: "preparing",
    ready: preparation.promise,
    dataClosed: false,
    retain() {
      if (owner.phase === "closing") {
        throw new Error("Gateway session broker cleanup has not joined");
      }
      references += 1;
      let released = false;
      return {
        ready: owner.ready,
        stop() {
          if (!released) {
            released = true;
            references -= 1;
          }
          if (references) {
            return Promise.resolve();
          }
          owner.phase = "closing";
          return (closing ??= (async () => {
            await owner.ready.catch(() => undefined);
            const errors: unknown[] = [];
            try {
              await closeLogicalOwners();
            } catch (error) {
              errors.push(error);
            }
            try {
              if (owner.store) {
                await owner.store.close();
              } else if (cleanup?.pending) {
                await cleanup.close();
              }
            } catch (error) {
              errors.push(error);
            }
            // A refused logical command cannot suppress the separately retained
            // native/compute joins. Native stop replaces only the data finish receipt.
            try {
              if (nativeStopped) {
                await nativeStopped;
              }
            } catch (error) {
              errors.push(error);
            }
            try {
              await projection.close();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length === 1) {
              throw errors[0];
            }
            if (errors.length > 1) {
              throw new AggregateError(errors, "Gateway session broker cleanup failed", {
                cause: errors[0],
              });
            }
            if (agentDatabaseLifecycle.gatewayExecution === owner) {
              agentDatabaseLifecycle.gatewayExecution = undefined;
            }
          })().catch((error: unknown) => {
            closing = undefined;
            throw error;
          }));
        },
      };
    },
  };
  agentDatabaseLifecycle.gatewayExecution = owner;
  const assertOpening = () => {
    if (agentDatabaseLifecycle.gatewayExecution !== owner || owner.phase === "closing") {
      throw new Error("Gateway session broker preparation was revoked");
    }
    context.admission.assertCurrent();
  };
  const ready = openVolatileAgentDatabaseSqliteWorkerStore<VolatileAgentDatabaseOperations>({
    id,
    moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
    input: { kind: "volatile-broker", id, projection: projection.identity },
    backendService: projection.port,
    stateContext: context,
    stateDatabasePath: context.admission.databasePath,
    assertCurrent: assertOpening,
    retainCleanup: (retained) => {
      cleanup = retained;
    },
    onNativeStopped: (stopped) => {
      nativeStopped = stopped;
      void stopped.then(() => {
        owner.dataClosed = true;
        projection.nativeStopped();
      });
    },
  }).then((store) => {
    owner.store = store;
    assertOpening();
    owner.phase = "ready";
  });
  // Publish the actual readiness before handing the first lifetime to bootstrap.
  void ready.then(preparation.resolve, preparation.reject);
  void preparation.promise.catch(() => undefined);
  return owner.retain();
}

export function createVolatileAgentDatabaseGeneration(
  target: Omit<VolatileAgentDatabaseTarget, "id">,
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
): AgentDatabaseNativeGeneration & {
  retainReady(
    source: AgentDatabaseRequestExecutionSource,
    assertCallerCurrent?: () => void,
    createIfMissing?: boolean,
  ): AgentDatabaseReadyOperation;
} {
  const broker = agentDatabaseLifecycle.gatewayExecution;
  if (
    !broker ||
    broker.phase !== "ready" ||
    !broker.store ||
    broker.context.admission.databasePath !== context.admission.databasePath ||
    broker.context.admission.identity.key !== context.admission.identity.key
  ) {
    throw new Error("The logical agent database requires its ready Gateway session broker");
  }
  const store = broker.store;
  const logical = Object.freeze({ ...target, id: randomUUID() });
  let incarnation: string | undefined;
  let closing: Promise<void> | undefined;
  let retiring = false;
  let nativeClosed = false;
  const projection = broker.projection.enroll(logical, (owner) => {
    assertCurrent();
    if (
      owner.agentId !== logical.agentId ||
      owner.path !== logical.path ||
      !incarnation ||
      owner.incarnation !== incarnation
    ) {
      throw new Error("Transcript compute belongs to another logical native incarnation");
    }
  });
  const scopes = new Set<Promise<void>>();
  const retainReady = (
    source: AgentDatabaseRequestExecutionSource,
    assertCallerCurrent?: () => void,
    createIfMissing = false,
  ): AgentDatabaseReadyOperation => {
    assertCurrent();
    if (retiring || broker.phase !== "ready") {
      throw new Error("Volatile agent execution is closing");
    }
    const check = () => {
      assertCurrent();
      assertCallerCurrent?.();
      source.assertCurrent();
    };
    const retained = retainSqliteWorkerStoreOperation(
      store,
      context,
      check,
      createSqliteWorkerAdmissionFactory(
        source.requiresHostContinuation,
        source.createAdmission({
          operation: "execute",
          attachment: { kind: "agent-execution", startupJournal: false },
          nativeLocations: [
            context.admission.databasePath,
            context.admission.identity.canonicalPath,
          ],
          assertCurrent: check,
          authorize(request) {
            check();
            const facts = request.facts;
            if (
              !isRecord(facts) ||
              facts.kind !== "volatile" ||
              facts.brokerId !== broker.id ||
              !isDeepStrictEqual(facts.target, logical)
            ) {
              throw new Error("Volatile admission differs from its retained logical owner");
            }
            if (request.stage === "open") {
              if (!createIfMissing || incarnation !== undefined) {
                throw new Error("Volatile native creation was not admitted");
              }
            } else {
              if (
                typeof facts.incarnation !== "string" ||
                (incarnation !== undefined && incarnation !== facts.incarnation)
              ) {
                throw new Error("Volatile admission belongs to another native incarnation");
              }
              incarnation ??= facts.incarnation;
            }
          },
        }),
      ),
      true,
    );
    const joined = createDeferredCore();
    scopes.add(joined.promise);
    let closed: Promise<void> | undefined;
    return {
      execute<K extends keyof AgentDatabaseOperations>(
        command: { type: K; input: AgentDatabaseOperations[K]["input"] },
        options?: { signal?: AbortSignal },
      ) {
        const result = retained.execute(
          {
            type: "database.volatile.execute",
            input: { target: logical, createIfMissing, command },
          },
          options,
        );
        // This original logical target forwards the unchanged command to its paired backend.
        // SAFETY: the backend returns that owner's selected command result.
        return result as Promise<AgentDatabaseOperations[K]["output"]>;
      },
      executeReady<K extends keyof AgentDatabaseOperations>(command: {
        type: K;
        input: AgentDatabaseOperations[K]["input"];
      }) {
        const result = retained.executeReady({
          type: "database.volatile.execute",
          input: { target: logical, createIfMissing, command },
        });
        // The same original target and command use the paired backend's synchronous ready path.
        // SAFETY: this is that command's returned value, never a Promise adapter.
        return result as AgentDatabaseOperations[K]["output"];
      },
      close() {
        if (!closed) {
          closed = retained.close().finally(() => {
            scopes.delete(joined.promise);
            joined.resolve();
          });
        }
        return closed;
      },
    };
  };
  return {
    failed: () => !isSqliteWorkerStoreAvailable(store),
    retainReady,
    async run(source, operation, assertCallerCurrent, createIfMissing) {
      const scope = retainReady(source, assertCallerCurrent, createIfMissing);
      try {
        if (createIfMissing) {
          await scope.execute({ type: "database.prepareWrite", input: undefined });
        }
        return await operation(scope);
      } finally {
        await scope.close();
      }
    },
    close() {
      retiring = true;
      projection.revoke();
      return (closing ??= (async () => {
        const errors: unknown[] = [];
        // Healthy logical close keeps every sibling in the carrier alive. An
        // already failed carrier instead needs its retained native retirement.
        if (isSqliteWorkerStoreAvailable(store)) {
          await Promise.allSettled(scopes);
        }
        if (!nativeClosed && !broker.dataClosed) {
          try {
            await store.execute({ type: "database.volatile.close", input: logical });
            nativeClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (!isSqliteWorkerStoreAvailable(store)) {
          try {
            await store.close();
          } catch (error) {
            errors.push(error);
          }
        }
        await Promise.allSettled(scopes);
        try {
          // oxlint-disable-next-line unicorn/require-array-join-separator -- This joins the retained projection lifecycle, not an array.
          await projection.join();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Logical agent cleanup failed", { cause: errors[0] });
        }
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      }));
    },
  };
}
