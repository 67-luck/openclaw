import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { formatErrorMessage } from "../infra/errors.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { retainSqliteWorkerErrorCode } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureAgentDatabaseAdmission } from "./agent-database-admission.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseExecutionOwner,
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-contract.js";
import {
  createAgentDatabaseNativeGeneration,
  type AgentDatabaseExecutionScope,
  type AgentDatabaseNativeGeneration,
} from "./openclaw-agent-execution-native.js";
import { supportsOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-support.js";
import {
  createVolatileAgentDatabaseGeneration,
  retainGatewayAgentDatabaseExecution,
} from "./openclaw-agent-execution-volatile.js";
import {
  observeOpenClawDatabaseMaintenanceResource,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";

export type {
  AgentDatabaseExecutionBinding,
  OpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-contract.js";
export { supportsOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-support.js";

const log = createSubsystemLogger("state/agent-db");
// References are derived; the canonical agent and shared resource owners govern retirement.
const executionState = resolveGlobalSingleton<{
  owners: Map<string, AgentDatabaseExecutionOwner>;
  // The slot stays occupied during eviction and after failed cleanup.
  idle?: AgentDatabaseExecutionOwner;
}>(Symbol.for("openclaw.agentDatabaseExecutionOwners"), () => ({ owners: new Map() }));
const executions = executionState.owners;
const runInExecutionOwnerContext = AsyncLocalStorage.snapshot();

/** Enumerate admitted process-held stores without opening or adopting a generation. */
export function listOpenVolatileAgentDatabaseExecutions() {
  return [...new Set(executions.values())]
    .flatMap((owner) => {
      const target = owner.readVolatileTarget();
      return target ? [target] : [];
    })
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.storePath.localeCompare(right.storePath),
    );
}

/** Early Gateway lifetime owns the process broker; logical stores keep their existing resources. */
export function retainGatewaySessionBroker() {
  return retainGatewayAgentDatabaseExecution(async () => {
    const errors: unknown[] = [];
    for (const owner of executions.values()) {
      if (owner.backend === "volatile") {
        try {
          await owner.close();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    throwSqliteLifecycleErrors(errors, "Logical agent database cleanup failed");
  });
}

/** Borrow before callers yield; native opening stays lazy and release joins owned work. */
export function captureOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  constraints: {
    expectedIdentity?: AgentDatabaseExecutionFileIdentity;
    expectedCreationIdentity?: DatabasePathIdentity;
  } = {},
): OpenClawAgentDatabaseExecution {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const volatile = isIncognitoOpenClawAgentSqlitePath(pathname, options);
  if (volatile && (constraints.expectedIdentity || constraints.expectedCreationIdentity)) {
    throw new Error("Volatile agent execution cannot borrow a durable file identity");
  }
  if (!supportsOpenClawAgentDatabaseExecution(options)) {
    throw new Error("This agent database scope still requires its existing native owner");
  }
  let existing = executions.get(pathname);
  const expectedCreationIdentity = constraints.expectedCreationIdentity
    ? Object.freeze({ ...constraints.expectedCreationIdentity })
    : undefined;
  if (!existing || expectedCreationIdentity) {
    const identity: DatabasePathIdentity = volatile
      ? { key: `path:${pathname}`, canonicalPath: pathname }
      : readDatabasePathIdentitySync(pathname);
    existing ??= executions.get(identity.canonicalPath);
    if (expectedCreationIdentity) {
      const capturesAbsence = expectedCreationIdentity.key.startsWith("path:");
      if (
        constraints.expectedIdentity ||
        (capturesAbsence &&
          (existing ||
            agentDatabaseLifecycle.databases.has(pathname) ||
            agentDatabaseLifecycle.pending.has(pathname))) ||
        (!capturesAbsence &&
          (!expectedCreationIdentity.key.startsWith("file:") ||
            typeof expectedCreationIdentity.birthtime !== "string")) ||
        identity.key !== expectedCreationIdentity.key ||
        identity.canonicalPath !== expectedCreationIdentity.canonicalPath ||
        identity.birthtime !== expectedCreationIdentity.birthtime
      ) {
        throw new Error("Agent creation no longer owns its originally observed target");
      }
    }
    if (!existing) {
      return createAgentDatabaseExecution(options, {
        agentId,
        pathname,
        identity,
        initialIdentity: constraints.expectedIdentity,
        expectedCreationIdentity,
      });
    }
  }
  if (existing.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} is already open for agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
  const env =
    process.platform === "win32"
      ? cloneEnvWithPlatformSemantics(options.env ?? process.env)
      : options.env;
  const state = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(env));
  if (existing.sharedDatabaseKey !== state.admission.identity.key) {
    throw new Error(
      "Agent database execution belongs to another shared-state database; drain its existing resources before changing the state directory.",
    );
  }
  return existing.borrow(pathname, constraints.expectedIdentity, expectedCreationIdentity);
}

function createAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  prepared: {
    agentId: string;
    pathname: string;
    identity: DatabasePathIdentity;
    initialIdentity?: AgentDatabaseExecutionFileIdentity;
    expectedCreationIdentity?: DatabasePathIdentity;
  },
): OpenClawAgentDatabaseExecution {
  const { agentId, pathname, identity, initialIdentity, expectedCreationIdentity } = prepared;
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const executionOptions = { agentId, path: pathname, env: context.environment };
  const volatile = isIncognitoOpenClawAgentSqlitePath(pathname, executionOptions);
  const aliases = new Map<string, () => void>();
  const assertAgentAdmitted = captureAgentDatabaseAdmission(agentId, { env: context.environment });
  let retired = false;
  const bindingIncarnation = Object.freeze({});
  let revoked = false;
  let borrowers = 0;
  let creationReference: object | undefined;
  let generation: AgentDatabaseNativeGeneration | undefined;
  let fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  let nativeClosing: Promise<void> | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  let unregisterShared: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleDrainListener: Disposable | undefined;

  const clearIdleTimer = () => {
    idleDrainListener?.[Symbol.dispose]();
    idleDrainListener = undefined;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const reportCleanupFailure = (error: unknown) => {
    // Diagnostic failures cannot turn a committed command into a replayable failure.
    try {
      log.warn(`Agent database idle cleanup failed: ${formatErrorMessage(error)}`);
    } catch {
      // The resource owner still retains the cleanup failure.
    }
  };
  const finishRetirement = () => {
    retired = true;
    if (executions.get(pathname) !== owner) {
      return;
    }
    unregisterAgent();
    unregisterShared?.();
  };

  const assertCurrent = () => {
    if (
      retired ||
      executions.get(pathname) !== owner ||
      !supportsOpenClawAgentDatabaseExecution(executionOptions)
    ) {
      throw new Error("Agent database execution admission is closed");
    }
    context.admission.assertCurrent();
    assertAgentAdmitted();
  };
  const closeNative = (expected?: AgentDatabaseNativeGeneration): Promise<void> => {
    if (expected && generation !== expected) {
      return Promise.resolve();
    }
    clearIdleTimer();
    if (nativeClosing) {
      return nativeClosing;
    }
    const captured = generation;
    if (!captured) {
      return Promise.resolve();
    }
    const result = captured.close().then(
      () => {
        if (generation === captured) {
          generation = undefined;
          cleanupFailure = undefined;
          if (executionState.idle === owner) {
            executionState.idle = undefined;
          }
        }
      },
      (error: unknown) => {
        cleanupFailure = { error };
        throw error;
      },
    );
    nativeClosing = result;
    void result
      .finally(() => {
        if (nativeClosing === result) {
          nativeClosing = undefined;
        }
      })
      .catch(() => undefined);
    return result;
  };
  async function run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    expectedIdentity?: AgentDatabaseExecutionFileIdentity,
    retireNativeOnFailure = false,
    createIfMissing = false,
    creatingTarget?: DatabasePathIdentity,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const pending = agentDatabaseLifecycle.pending.get(pathname);
    if (pending) {
      if (creatingTarget && !fileIdentity) {
        throw new Error("Agent creation cannot adopt another pending opener");
      }
      if (pending.agentId !== agentId) {
        throw new Error(`Agent database ${pathname} is opening for ${pending.agentId}`);
      }
      await pending.promise;
      pending.controller.signal.throwIfAborted();
      assertCallerCurrent();
    }
    if (nativeClosing) {
      await nativeClosing;
      assertCallerCurrent();
    }
    if (cleanupFailure) {
      // A volatile generation is the database itself, not a reopenable file.
      // Its failed cleanup cannot authorize a replacement native generation.
      if (volatile) {
        throw cleanupFailure.error;
      }
      // A transient lifecycle refusal must not poison every later borrower.
      // Retire the original generation before admitting any replacement work.
      await closeNative();
      assertCurrent();
      source.assertCurrent();
      assertCallerCurrent();
    }
    if (!generation) {
      for (let idle = executionState.idle; idle && idle !== owner; idle = executionState.idle) {
        await idle.closeIdle();
        assertCurrent();
        source.assertCurrent();
        assertCallerCurrent();
      }
      if (!generation) {
        const created = createAgentDatabaseNativeGeneration(
          agentId,
          identity.canonicalPath,
          context,
          assertCurrent,
          () => {
            if (executions.get(pathname) !== owner || generation !== created || !nativeClosing) {
              throw new Error("Agent cleanup no longer owns its original execution reference");
            }
          },
          expectedIdentity ?? fileIdentity,
          (received) => {
            if (
              fileIdentity &&
              (fileIdentity.physicalIdentity !== received.physicalIdentity ||
                fileIdentity.birthtime !== received.birthtime)
            ) {
              throw new Error("Agent database execution belongs to another physical file");
            }
            fileIdentity ??= Object.freeze({ ...received });
          },
          fileIdentity ? undefined : creatingTarget,
        );
        generation = created;
      }
    }
    const current = generation;
    try {
      const result = await current.run(
        source,
        operation,
        assertCallerCurrent,
        createIfMissing,
        signal,
      );
      if (generation === current && current.failed()) {
        try {
          await owner.close();
        } catch (error) {
          reportCleanupFailure(error);
        }
      }
      return result;
    } catch (error) {
      const nativeFailed = current.failed();
      if (generation === current && (nativeFailed || retireNativeOnFailure)) {
        try {
          if (nativeFailed || volatile) {
            // The volatile generation is the store itself. Retiring it must
            // retire this logical owner, never permit a later durable reopen.
            await owner.close();
          } else {
            // The rejected broker scope has settled; only its captured native owner is retired.
            await closeNative(current);
          }
        } catch (cleanupError) {
          throw retainSqliteWorkerErrorCode(
            new AggregateError([error, cleanupError], "Agent operation and cleanup failed", {
              cause: error,
            }),
            error,
          );
        }
      }
      throw error;
    }
  }
  const owner: AgentDatabaseExecutionOwner = {
    backend: volatile ? "volatile" : "durable",
    agentId,
    get sharedDatabaseKey() {
      return context.admission.identity.key;
    },
    readVolatileTarget() {
      if (!volatile || retired || revoked || closing || cleanupFailure || !generation) {
        return undefined;
      }
      try {
        generation.captureClaim().assertCurrent();
        return { agentId, storePath: pathname };
      } catch {
        // Cold and revoked logical owners are not open incognito stores.
        return undefined;
      }
    },
    borrow(borrowedPath, expected, creating) {
      const expectedIdentity = expected ? Object.freeze({ ...expected }) : undefined;
      const creatingTarget = creating ? Object.freeze({ ...creating }) : undefined;
      const assertReferenceCurrent = (nativeIdentity?: AgentDatabaseExecutionFileIdentity) => {
        assertCurrent();
        if (volatile) {
          return;
        }
        if (!fileIdentity || creatingTarget) {
          const current = readDatabasePathIdentitySync(borrowedPath);
          if (
            current.canonicalPath !== identity.canonicalPath ||
            (creatingTarget?.key.startsWith("file:") &&
              (current.key !== creatingTarget.key ||
                current.birthtime !== creatingTarget.birthtime))
          ) {
            throw new Error("Agent database borrower changed its originally observed target");
          }
        }
        if (
          fileIdentity &&
          expectedIdentity &&
          (fileIdentity.physicalIdentity !== expectedIdentity.physicalIdentity ||
            (fileIdentity.birthtime !== undefined &&
              expectedIdentity.birthtime !== undefined &&
              fileIdentity.birthtime !== expectedIdentity.birthtime))
        ) {
          throw new Error("Agent database borrower belongs to another physical file");
        }
        const file = fileIdentity ?? expectedIdentity;
        const birthtime = fileIdentity?.birthtime ?? expectedIdentity?.birthtime;
        if (file) {
          if (
            nativeIdentity &&
            (nativeIdentity.physicalIdentity !== file.physicalIdentity ||
              (birthtime !== undefined && nativeIdentity.birthtime !== birthtime))
          ) {
            throw new Error("Agent database borrower belongs to another physical file");
          }
          // The native owner validates its own path last; a borrowed alias has a separate lifetime.
          if (!nativeIdentity || borrowedPath !== nativeIdentity.nativeLocation) {
            assertExistingDatabaseIdentity(
              borrowedPath,
              `file:${file.physicalIdentity}`,
              birthtime,
            );
          }
        }
      };
      assertReferenceCurrent();
      if (creatingTarget && !fileIdentity && generation) {
        throw new Error("Agent creation cannot capture another pending native opener");
      }
      retainAlias(borrowedPath);
      observeOpenClawDatabaseMaintenanceResource(aliases.get(pathname));
      borrowers += 1;
      clearIdleTimer();
      if (executionState.idle === owner && !nativeClosing && !cleanupFailure) {
        executionState.idle = undefined;
      }
      const reference = {};
      if (creatingTarget && !fileIdentity) {
        creationReference ??= reference;
      }
      const assertCreationReference = (create: boolean) => {
        if (creatingTarget && !fileIdentity && !create) {
          throw new Error("Originally observed agent target requires creating admission first");
        }
        if (creationReference && !fileIdentity && (!create || creationReference !== reference)) {
          throw new Error(
            "Originally observed agent target requires its captured creating reference",
          );
        }
      };
      let released = false;
      let release: Promise<void> | undefined;
      const pending = new Set<Promise<unknown>>();

      const assertBorrowed = () => {
        if (released) {
          throw new Error("Agent database execution reference is released");
        }
        assertReferenceCurrent();
      };
      return {
        binding: {
          incarnation: bindingIncarnation,
          backend: owner.backend,
          agentId,
          path: borrowedPath,
          assertCurrent: assertReferenceCurrent,
          borrow() {
            assertReferenceCurrent();
            return owner.borrow(borrowedPath, expectedIdentity, creatingTarget);
          },
        },
        backend: owner.backend,
        agentId,
        path: borrowedPath,
        get fileIdentity() {
          assertBorrowed();
          return fileIdentity;
        },
        assertCurrent: assertBorrowed,
        ...(volatile
          ? {
              retainReadyOperation(
                source: AgentDatabaseRequestExecutionSource,
                operationOptions?: { createIfMissing?: boolean },
              ) {
                assertBorrowed();
                if (!generation?.retainReady) {
                  throw new Error("Volatile agent execution is not prepared");
                }
                const retained = generation.retainReady(
                  source,
                  assertReferenceCurrent,
                  operationOptions?.createIfMissing,
                );
                const joined = createDeferredCore();
                pending.add(joined.promise);
                let operationClose: Promise<void> | undefined;
                return {
                  ...retained,
                  close() {
                    return (operationClose ??= retained.close().finally(() => {
                      pending.delete(joined.promise);
                      joined.resolve();
                    }));
                  },
                };
              },
            }
          : {}),
        captureGenerationClaim() {
          assertBorrowed();
          const captured = generation;
          if (!captured) {
            throw new Error("Agent database execution has no admitted generation");
          }
          const claim = captured.captureClaim();
          return {
            identity: claim.identity,
            incarnation: claim.incarnation,
            assertCurrent() {
              assertBorrowed();
              if (generation !== captured) {
                throw new Error("Agent database execution generation was replaced");
              }
              claim.assertCurrent();
            },
          };
        },
        async prepare(source, signal) {
          assertBorrowed();
          assertCreationReference(true);
          const result = run(
            source,
            async () => undefined,
            (nativeIdentity) => {
              assertReferenceCurrent(nativeIdentity);
              assertCreationReference(true);
            },
            expectedIdentity,
            false,
            true,
            creatingTarget,
            signal,
          );
          pending.add(result);
          void result.finally(() => pending.delete(result)).catch(() => undefined);
          await result;
        },
        async runExisting(source, operation, runOptions) {
          assertBorrowed();
          assertCreationReference(false);
          const result = run(
            source,
            operation,
            (nativeIdentity) => {
              assertReferenceCurrent(nativeIdentity);
              assertCreationReference(false);
            },
            expectedIdentity,
            runOptions?.retireNativeOnFailure,
          );
          pending.add(result);
          void result.finally(() => pending.delete(result)).catch(() => undefined);
          return result;
        },
        release() {
          released = true;
          release ??= (async () => {
            await Promise.allSettled(pending);
            if (
              creationReference === reference &&
              !fileIdentity &&
              !nativeClosing &&
              !cleanupFailure
            ) {
              if (generation) {
                // Source refusal can leave an unaccepted generation allocated before native open.
                try {
                  await closeNative(generation);
                } catch (error) {
                  reportCleanupFailure(error);
                }
              }
              if (!generation && !nativeClosing && !cleanupFailure) {
                creationReference = undefined;
              }
            }
            borrowers -= 1;
            if (borrowers !== 0 || retired || cleanupFailure || volatile) {
              return;
            }
            const drainSignal = getGatewayRestartDrainSignal();
            if (generation && !nativeClosing && !executionState.idle && !drainSignal.aborted) {
              executionState.idle = owner;
              const timer = runInExecutionOwnerContext(() =>
                setTimeout(() => {
                  if (idleTimer !== timer || executionState.idle !== owner) {
                    return;
                  }
                  void owner.closeIdle().catch(reportCleanupFailure);
                }, SQLITE_IDLE_HANDLE_TTL_MS),
              );
              idleTimer = timer;
              timer.unref();
              // Exit cannot join worker leases behind stalled non-storage cleanup.
              // Only idle generations retire here; accepted writers keep their custody.
              idleDrainListener = addAbortListener(drainSignal, () => {
                runInExecutionOwnerContext(() => {
                  void owner.closeIdle().catch(reportCleanupFailure);
                });
              });
              return;
            }
            try {
              await owner.closeIdle();
            } catch (error) {
              // The completed command stays acknowledged; the resource owner retains cleanup.
              reportCleanupFailure(error);
            }
          })();
          return release;
        },
      };
    },
    async closeIdle() {
      await closeNative();
      // A reborrow may have retained the owner or started its next native generation.
      if (borrowers === 0 && !generation) {
        finishRetirement();
      }
    },
    close() {
      retired = true;
      closing ??= (async () => {
        await closeNative();
        finishRetirement();
      })().catch((error: unknown) => {
        closing = undefined;
        if (!revoked) {
          // A rejected native close has not retired anything yet: the owner still holds
          // its generation and lease, and `executions` still points at it. Leaving it
          // retired would refuse every later borrower with "admission is closed" until
          // the process drains. Re-admit the owner instead; its retained cleanupFailure
          // makes the next request retry the native close before any new work.
          retired = false;
        }
        throw error;
      });
      return closing;
    },
  };
  const unregisterAgent = () => {
    for (const [alias, unregister] of aliases) {
      if (executions.get(alias) === owner) {
        executions.delete(alias);
      }
      unregister();
    }
    aliases.clear();
  };
  const retainAlias = (alias: string) => {
    if (aliases.has(alias)) {
      return;
    }
    // Cleanup keeps captured locators even if a symlink is later removed or retargeted.
    const register = () =>
      registerOpenClawAgentDatabaseAsyncResource({
        agentId,
        path: alias,
        revoke() {
          revoked = true;
          retired = true;
          clearIdleTimer();
        },
        close: () => owner.close(),
      });
    // One claim owns the executor; later aliases only select that owner for cleanup.
    const unregister =
      aliases.size === 0 ? register() : runOutsideOpenClawDatabaseMaintenanceScope(register);
    aliases.set(alias, unregister);
    executions.set(alias, owner);
  };
  try {
    retainAlias(pathname);
    retainAlias(identity.canonicalPath);
    unregisterShared = registerOpenClawStateDatabaseAsyncResource({
      close: async (sharedIdentity) => {
        if (!sharedIdentity || sharedIdentity.key === context.admission.identity.key) {
          await owner.close();
        }
      },
    });
    if (volatile) {
      generation = createVolatileAgentDatabaseGeneration(
        { agentId, path: pathname },
        context,
        assertCurrent,
      );
    }
    return owner.borrow(pathname, initialIdentity, expectedCreationIdentity);
  } catch (error) {
    unregisterAgent();
    unregisterShared?.();
    throw error;
  }
}
