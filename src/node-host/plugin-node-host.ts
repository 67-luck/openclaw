/** Plugin node-host bridge for loading plugin registry commands and dispatching node capabilities. */
import { asOptionalRecord as normalizeRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { logDebug } from "../logger.js";
import { createPluginRuntimeCapabilityLease } from "../plugins/capability-lease.js";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import {
  getPluginInstance,
  getPluginOriginalValue,
  getPluginValueInstance,
  runPluginCleanup,
} from "../plugins/plugin-instance-scope.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import {
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "../plugins/registry-lifecycle.js";
import type {
  PluginNodeHostCommandRegistration,
  PluginRegistry,
} from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginServiceSchedulerRunner } from "../plugins/service-scheduler-context.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import type {
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandIo,
  PluginLogger,
} from "../plugins/types.js";
import type {
  OpenClawPluginNodeHostCommandContext,
  OpenClawPluginNodeHostCommandV2,
} from "../plugins/types.node-host.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { preparePluginExecAuthorization } from "./plugin-exec-policy.js";

const loadPluginRegistryLoaderModule = createLazyRuntimeModule(
  () => import("../plugins/loader.js"),
);
let nodeHostPluginRegistry: PluginRegistry | undefined;
let nodeHostPluginLifetime: ReturnType<typeof createNodeHostPluginLifetime> | undefined;

function resolveNodeHostPluginRegistry() {
  return nodeHostPluginRegistry ?? getActivePluginRegistry() ?? undefined;
}

function nodeHostCallbackIdentity(callback: object): object {
  const instance = getPluginValueInstance(callback);
  if (!instance) {
    return callback;
  }
  let identity = callback;
  for (
    let original = getPluginOriginalValue(identity, instance);
    original;
    original = getPluginOriginalValue(identity, instance)
  ) {
    identity = original;
  }
  return identity;
}

/** Ensure plugin registry data is loaded before node-host command dispatch. */
export async function ensureNodeHostPluginRegistry(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  commandAllowlist?: ReadonlySet<string>;
  onlyPluginIds?: string[];
  logger?: PluginLogger;
  scheduler?: GatewayScheduler;
}) {
  await nodeHostPluginLifetime?.close();
  const registry = (await loadPluginRegistryLoaderModule()).loadPluginRegistryHandle({
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    logger: params.logger,
  });
  const lifetime = createNodeHostPluginLifetime(registry, params);
  nodeHostPluginRegistry = registry;
  nodeHostPluginLifetime = lifetime;
  await using preparation = {
    transferred: false,
    async [Symbol.asyncDispose]() {
      if (!this.transferred) {
        await lifetime.close();
      }
    },
  };
  await lifetime.prepare();
  preparation.transferred = true;
  return lifetime;
}

function createNodeHostPluginLifetime(
  registry: PluginRegistry,
  params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    commandAllowlist?: ReadonlySet<string>;
    scheduler?: GatewayScheduler;
  },
) {
  type Owner = {
    scheduler: ReturnType<typeof createPluginServiceScheduler>;
    lease: ReturnType<typeof createPluginRuntimeCapabilityLease>;
    preparing: Promise<void>;
  };
  const owners = new Map<string, Owner>();
  const commands = registry.nodeHostCommands.filter(
    (entry) => !params.commandAllowlist || params.commandAllowlist.has(entry.command.command),
  );
  const signal = capturePluginRegistryLifecycleSignal(
    registry,
    capturePluginRegistryLifecycleEpoch(registry),
    { scopedRuntime: true },
  );
  if (!signal) {
    throw new Error("Node plugin registry is retired");
  }
  const instances = new Set(
    commands.flatMap((entry) => {
      const record = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
      const instance = record ? getPluginInstance(record) : getPluginValueInstance(entry.command);
      return instance ? [instance] : [];
    }),
  );
  const custody = new PluginInvocationScope(registry, instances, {
    retained: true,
    kind: "custody",
  });
  let cleanupScope = custody;
  const availabilityStops = new Set<() => Promise<void>>();
  const legacyPreparations = new Set(
    commands.flatMap(({ command }) =>
      command.apiVersion !== 2 && command.prepare ? [command.prepare] : [],
    ),
  );
  let initialPreparation: Promise<void> | undefined;
  const preparations = new Map<string, Map<object, OpenClawPluginNodeHostCommandV2["prepare"]>>();
  for (const entry of commands) {
    if (entry.command.apiVersion !== 2) {
      continue;
    }
    let callbacks = preparations.get(entry.pluginId);
    if (!callbacks) {
      callbacks = new Map();
      preparations.set(entry.pluginId, callbacks);
    }
    const prepare = entry.command.prepare;
    const identity = nodeHostCallbackIdentity(prepare);
    if (!callbacks.has(identity)) {
      callbacks.set(identity, prepare);
    }
  }
  let closed = false;
  let stopping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let disconnectFailure: AggregateError | undefined;
  let disconnected = false;
  const completedDisconnects = new Map<object | undefined, Set<object>>();
  let finalCleanup: ReturnType<PluginInvocationScope["beginCleanup"]> | undefined;
  const disconnect = () => {
    if (closing) {
      return closing;
    }
    if (stopping) {
      return stopping;
    }
    if (disconnected) {
      return Promise.resolve();
    }
    const current = [...owners.values()];
    stopping = Promise.resolve()
      .then(async () => {
        await Promise.all([
          ...(initialPreparation ? [initialPreparation.catch(() => undefined)] : []),
          ...current.map((owner) => owner.preparing.catch(() => undefined)),
        ]);
        const results = await Promise.allSettled([
          cleanupScope.run(() =>
            notifyRegisteredNodeHostCommandDisconnect(registry, commands, completedDisconnects),
          ),
          ...current.map((owner) => owner.scheduler.stop()),
        ]);
        for (const owner of current) {
          owner.lease.revoke();
        }
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          disconnectFailure = new AggregateError(
            failures,
            "node plugin lifetime retirement failed; reconnect the node to retry cleanup",
          );
          throw disconnectFailure;
        }
        owners.clear();
        disconnectFailure = undefined;
        disconnected = true;
      })
      .finally(() => {
        stopping = undefined;
      });
    for (const owner of current) {
      owner.scheduler.beginClose();
    }
    return stopping;
  };
  const assertOpen = () => {
    if (closed || nodeHostPluginRegistry !== registry) {
      throw new Error("Node plugin preparation owner is retired");
    }
    signal.throwIfAborted();
  };
  const lifetime = {
    async prepare() {
      while (stopping) {
        await stopping;
      }
      if (disconnectFailure) {
        throw disconnectFailure;
      }
      assertOpen();
      params.scheduler?.signal.throwIfAborted();
      if (disconnected) {
        completedDisconnects.clear();
        disconnected = false;
      }
      initialPreparation ??= Promise.resolve().then(() =>
        custody.run(async () => {
          signal.throwIfAborted();
          await withPluginRuntimeRegistryScope(registry, async () => {
            await Promise.all(
              [...legacyPreparations].map(async (prepare) =>
                prepare({ config: params.config, env: params.env ?? process.env }),
              ),
            );
          });
        }),
      );
      for (const [pluginId, callbacks] of preparations) {
        if (owners.has(pluginId)) {
          continue;
        }
        if (!params.scheduler) {
          throw new Error("Node plugin preparation requires the host scheduler");
        }
        const record = registry.plugins.find((plugin) => plugin.id === pluginId);
        const lease = createPluginRuntimeCapabilityLease("node plugin preparation");
        const runOwned = createPluginServiceSchedulerRunner({
          registry,
          record,
          instance: record ? getPluginInstance(record) : undefined,
          lease,
        });
        const scheduler = createPluginServiceScheduler(params.scheduler, runOwned);
        const owner: Owner = {
          scheduler,
          lease,
          preparing: Promise.resolve().then(async () => {
            await runOwned(async () => {
              for (const prepare of callbacks.values()) {
                scheduler.signal.throwIfAborted();
                await prepare({ config: params.config, env: params.env ?? process.env, scheduler });
              }
            });
          }),
        };
        owners.set(pluginId, owner);
      }
      await Promise.all([
        initialPreparation,
        ...Array.from(owners.values(), (owner) => owner.preparing),
      ]);
      assertOpen();
    },
    watchAvailability(onChange: () => void) {
      assertOpen();
      const stop = watchRegisteredNodeHostCommandAvailability(
        { config: params.config, env: params.env ?? process.env },
        onChange,
        params.commandAllowlist,
      );
      availabilityStops.add(stop);
      return stop;
    },
    disconnect,
    close() {
      if (closing) {
        return closing;
      }
      closed = true;
      signal.removeEventListener("abort", retire);
      const cleanup = (finalCleanup ??= custody.beginCleanup());
      cleanupScope = cleanup.scope;
      const disconnected = disconnect();
      closing = Promise.resolve()
        .then(async () => {
          const results = await Promise.allSettled([
            disconnected,
            cleanup.scope.run(() => Promise.all([...availabilityStops].map((stop) => stop()))),
          ]);
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "node plugin owner close failed");
          }
          await cleanup.release();
        })
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
      return closing;
    },
  };
  const retire = () => {
    void lifetime
      .close()
      .catch((error: unknown) => logDebug(`node-host: plugin retirement failed: ${String(error)}`));
  };
  signal.addEventListener("abort", retire, { once: true });
  return lifetime;
}

/** List registered node-host capabilities and command ids in deterministic order. */
export function listRegisteredNodeHostCapsAndCommands(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
  options: { includeDuplex?: boolean; commandAllowlist?: ReadonlySet<string> } = {},
): {
  caps: string[];
  commands: string[];
  computerUse?: ComputerUseCapabilityDescriptor;
  nodePluginTools: NodePluginToolDescriptor[];
} {
  const registry = resolveNodeHostPluginRegistry();
  return withPluginRuntimeRegistryScope(registry, () => {
    const caps = new Set<string>();
    const commands = new Set<string>();
    let computerUse: ComputerUseCapabilityDescriptor | undefined;
    const nodePluginTools = new Map<string, NodePluginToolDescriptor>();
    for (const entry of registry?.nodeHostCommands ?? []) {
      if (options.commandAllowlist && !options.commandAllowlist.has(entry.command.command)) {
        continue;
      }
      if (entry.command.duplex === true && options.includeDuplex === false) {
        continue;
      }
      // Availability belongs to the node-local plugin. Gateway policy still keeps
      // the command registered so a differently configured remote node can expose it.
      if (entry.command.isAvailable?.(context) === false) {
        continue;
      }
      if (entry.command.cap) {
        caps.add(entry.command.cap);
      }
      commands.add(entry.command.command);
      if (!options.commandAllowlist && entry.command.computerUse) {
        computerUse = parseComputerUseCapabilityDescriptor(entry.command.computerUse(context));
      }
      const agentTool = options.commandAllowlist ? null : buildNodePluginToolDescriptor(entry);
      if (agentTool) {
        nodePluginTools.set(`${agentTool.pluginId}\0${agentTool.name}`, agentTool);
      }
    }
    return {
      caps: [...caps].toSorted((left, right) => left.localeCompare(right)),
      commands: [...commands].toSorted((left, right) => left.localeCompare(right)),
      ...(computerUse ? { computerUse } : {}),
      nodePluginTools: [...nodePluginTools.values()].toSorted(
        (left, right) =>
          left.pluginId.localeCompare(right.pluginId) || left.name.localeCompare(right.name),
      ),
    };
  });
}

/** Watch plugin-owned availability inputs that can change during this process. */
export function watchRegisteredNodeHostCommandAvailability(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
  onChange: () => void,
  commandAllowlist?: ReadonlySet<string>,
): () => Promise<void> {
  const registry = resolveNodeHostPluginRegistry();
  let cleanups: Array<() => void | Promise<void>> = [];
  let stopped = false;
  let stopping: Promise<void> | undefined;
  withPluginRuntimeRegistryScope(registry, () => {
    for (const entry of registry?.nodeHostCommands ?? []) {
      if (commandAllowlist && !commandAllowlist.has(entry.command.command)) {
        continue;
      }
      const cleanup = entry.command.watchAvailability?.(context, () => {
        if (!stopped) {
          withPluginRuntimeRegistryScope(registry, onChange);
        }
      });
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }
  });
  return () => {
    stopped = true;
    return (stopping ??= Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled(
          cleanups.map(async (cleanup) =>
            withPluginRuntimeRegistryScope(registry, () => cleanup()),
          ),
        );
        // Retry only unfinished owners; successful cleanup must not run twice.
        cleanups = cleanups.filter((_cleanup, index) => results[index]?.status === "rejected");
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "node-host watcher cleanup failed");
        }
      })
      .catch((error: unknown) => {
        stopping = undefined;
        throw error;
      }));
  };
}

/** Release plugin command state before a reconnected Gateway can invoke it again. */
export async function notifyRegisteredNodeHostCommandDisconnect(
  registry = resolveNodeHostPluginRegistry(),
  commands: readonly PluginNodeHostCommandRegistration[] = registry?.nodeHostCommands ?? [],
  completed = new Map<object | undefined, Set<object>>(),
): Promise<void> {
  const callbacks = new Map<object | undefined, Map<object, () => void | Promise<void>>>();
  const failures: unknown[] = [];
  for (const { command } of commands) {
    try {
      runPluginCleanup(command, () => {
        const callback = command.onDisconnect;
        if (!callback) {
          return;
        }
        const instance = getPluginValueInstance(callback);
        const identity = nodeHostCallbackIdentity(callback);
        // Callable views bind different command receivers to the same cleanup owner.
        // Original values identify duplicates; invocation always uses the admitted view.
        let owned = callbacks.get(instance);
        if (!owned) {
          owned = new Map();
          callbacks.set(instance, owned);
        }
        if (!owned.has(identity) && !completed.get(instance)?.has(identity)) {
          owned.set(identity, async () => {
            await runPluginCleanup(command, () => callback());
            let completedOwned = completed.get(instance);
            if (!completedOwned) {
              completedOwned = new Set();
              completed.set(instance, completedOwned);
            }
            completedOwned.add(identity);
          });
        }
      });
    } catch (error) {
      failures.push(error);
    }
  }
  await withPluginRuntimeRegistryScope(registry, async () => {
    const results = await Promise.allSettled(
      [...callbacks.values()].flatMap((owned) =>
        [...owned.values()].map(async (callback) => await callback()),
      ),
    );
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (failures.length === 1) {
      const failure = failures[0];
      throw failure instanceof Error
        ? failure
        : new Error("node-host plugin disconnect cleanup failed", { cause: failure });
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "node-host plugin disconnect cleanup failed");
    }
  });
}

/** Retained command work remains owned even when its capability is unavailable. */
export function hasRegisteredNodeHostCommandActiveWork(): boolean {
  const registry = resolveNodeHostPluginRegistry();
  return withPluginRuntimeRegistryScope(registry, () => {
    for (const entry of registry?.nodeHostCommands ?? []) {
      try {
        if (entry.command.hasActiveWork?.() !== false) {
          if (!entry.command.hasActiveWork) {
            logDebug(
              `node-host: ${entry.pluginId}/${entry.command.command} has no idle hook; auto-update deferred`,
            );
          }
          return true;
        }
      } catch (error) {
        logDebug(`node-host: plugin work state unavailable: ${String(error)}`);
        return true;
      }
    }
    return false;
  });
}

function buildNodePluginToolDescriptor(
  entry: PluginNodeHostCommandRegistration,
): NodePluginToolDescriptor | null {
  const agentTool = entry.command.agentTool;
  if (!agentTool) {
    return null;
  }
  const name = normalizeOptionalString(agentTool.name) ?? "";
  const description = normalizeOptionalString(agentTool.description) ?? "";
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || !description) {
    return null;
  }
  const mcpServer = normalizeOptionalString(agentTool.mcp?.server) ?? "";
  const mcpTool = normalizeOptionalString(agentTool.mcp?.tool) ?? "";
  return {
    pluginId: entry.pluginId,
    name,
    description,
    parameters: normalizeRecord(agentTool.parameters) ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    command: entry.command.command,
    ...(mcpServer && mcpTool ? { mcp: { server: mcpServer, tool: mcpTool } } : {}),
  };
}

/** Invoke a registered node-host plugin command, or return null for unknown commands. */
export async function invokeRegisteredNodeHostCommand(
  command: string,
  paramsJSON?: string | null,
  io?: OpenClawPluginNodeHostCommandIo,
  context?: OpenClawPluginNodeHostCommandContext,
): Promise<string | null> {
  const registry = resolveNodeHostPluginRegistry();
  const match = (registry?.nodeHostCommands ?? []).find(
    (entry) => entry.command.command === command,
  );
  if (!match) {
    return null;
  }
  let active = true;
  const registeredCommand = match.command;
  const pluginRecord = registry?.plugins.find((record) => record.id === match.pluginId);
  const assertActive = () => {
    if (
      !active ||
      match.command !== registeredCommand ||
      io?.signal.aborted ||
      context?.signal?.aborted ||
      resolveNodeHostPluginRegistry() !== registry ||
      !registry?.nodeHostCommands.includes(match) ||
      !pluginRecord ||
      !registry.plugins.includes(pluginRecord) ||
      !pluginRecord.enabled ||
      pluginRecord.status !== "loaded"
    ) {
      throw new Error("node plugin invocation authority is closed");
    }
  };
  const invokeContext = context
    ? {
        ...context,
        prepareExecAuthorization: (source: "human-approved" | "session-full") =>
          preparePluginExecAuthorization({
            source,
            command,
            sessionKey: context.sessionKey,
            assertActive,
          }),
      }
    : undefined;
  try {
    return await withPluginRuntimeRegistryScope(registry, async () => {
      if (match.command.duplex === true || match.command.duplex === "optional") {
        if (match.command.duplex === true && !io) {
          throw new Error(`node command requires duplex transport: ${command}`);
        }
        return invokeContext
          ? await match.command.handle(paramsJSON, io, invokeContext)
          : await match.command.handle(paramsJSON, io);
      }
      return invokeContext
        ? await match.command.handle(paramsJSON, undefined, invokeContext)
        : await match.command.handle(paramsJSON);
    });
  } finally {
    active = false;
  }
}

export function isRegisteredNodeHostCommandDuplex(command: string): boolean {
  const registry = resolveNodeHostPluginRegistry();
  const duplex = (registry?.nodeHostCommands ?? []).find(
    (entry) => entry.command.command === command,
  )?.command.duplex;
  return duplex === true || duplex === "optional";
}

function resetNodeHostPluginRegistry(): void {
  nodeHostPluginRegistry = undefined;
  nodeHostPluginLifetime = undefined;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.nodeHostPluginTestApi")] = {
    getNodeHostPluginRegistry: () => nodeHostPluginRegistry,
    resetNodeHostPluginRegistry,
  };
}
