import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryActive, revokePluginRecord } from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { PluginServiceSchedulerV1 } from "../plugins/service-scheduler.types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginNodeHostCommandV2 } from "../plugins/types.node-host.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  ensureNodeHostPluginRegistry,
  invokeRegisteredNodeHostCommand,
  notifyRegisteredNodeHostCommandDisconnect,
} from "./plugin-node-host.js";
import { resetNodeHostPluginRegistry } from "./plugin-node-host.test-support.js";

vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: () => getActivePluginRegistry(),
}));

afterEach(() => {
  resetNodeHostPluginRegistry();
  resetPluginRuntimeStateForTest();
  vi.useRealTimers();
});

type CatalogCommandOptions = Pick<
  OpenClawPluginNodeHostCommandV2,
  "prepare" | "onDisconnect" | "watchAvailability"
>;

function registerOwnedCatalog(
  options: CatalogCommandOptions,
  siblings: CatalogCommandOptions[] = [],
) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "catalog" });
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  const instance = getPluginInstance(record);
  assert(instance, "Registered commands require their real plugin instance");
  instance.run(() => {
    for (const [index, commandOptions] of [options, options, ...siblings].entries()) {
      api.registerNodeHostCommand({
        apiVersion: 2,
        command: ["catalog.list", "catalog.read"][index] ?? `catalog.extra${index}`,
        ...commandOptions,
        handle: async () => "owned",
      });
    }
  });
  builder.registry.plugins.push(record);
  markPluginRegistryActive(builder.registry);
  setActivePluginRegistry(builder.registry);
  return { registry: builder.registry, record, instance };
}

it("runs registered disconnect cleanup after revocation and joins its scheduled work without reviving disposed code", async () => {
  vi.useFakeTimers();
  const root = createTestGatewayScheduler("fake-timers");
  const held = createDeferred<void>();
  const cleanup = vi.fn(async () => {
    await held.promise;
  });
  const ran = vi.fn();
  const prepare = ({ scheduler }: { scheduler: PluginServiceSchedulerV1 }) => {
    scheduler.schedule({
      id: "held",
      delayMs: 0,
      run: async () => {
        ran();
        await held.promise;
      },
    });
  };
  const { registry, record, instance } = registerOwnedCatalog({ prepare, onDisconnect: cleanup });
  const lifetime = await ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root });
  let retiring: Promise<void> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toHaveBeenCalledOnce();
    revokePluginRecord(registry, record);
    const registered = registry.nodeHostCommands[0]!.command;
    expect(() => registered.onDisconnect?.()).toThrow("reloaded or disabled");
    const retired = vi.fn();
    retiring = lifetime.disconnect().then(retired);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(retired).not.toHaveBeenCalled();
    held.resolve();
    await retiring;
    await lifetime.close();
    await instance.dispose();
    const callsBeforeDisposalCheck = cleanup.mock.calls.length;
    await expect(notifyRegisteredNodeHostCommandDisconnect(registry)).rejects.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(callsBeforeDisposalCheck);
  } finally {
    held.resolve();
    await retiring?.catch(() => undefined);
    await lifetime.close().catch(() => undefined);
    await root.stop();
    await instance.dispose();
  }
});

it("retains an idle registered instance until the node owner has run disconnect cleanup", async () => {
  vi.useFakeTimers();
  const root = createTestGatewayScheduler("fake-timers");
  const events: string[] = [];
  const { instance } = registerOwnedCatalog({
    prepare: () => {},
    onDisconnect: () => {
      events.push("disconnect");
    },
  });
  instance.lifecycle.onDispose(() => {
    events.push("disposed");
  });
  const lifetime = await ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root });
  const disposing = instance.dispose();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.lifecycle.signal.aborted).toBe(false);
    expect(events).toEqual([]);
    await lifetime.close();
    await disposing;
    expect(events).toEqual(["disconnect", "disposed"]);
  } finally {
    await lifetime.close().catch(() => undefined);
    await disposing;
    await root.stop();
  }
});

it("blocks preparation after failed disconnect until cleanup succeeds and a fresh scope is prepared", async () => {
  const root = createTestGatewayScheduler("fake-timers");
  const scopes = new Set<PluginServiceSchedulerV1>();
  const failure = new Error("catalog persistence drain failed");
  const cleanup = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  const successfulSibling = vi.fn();
  const prepare = vi.fn(({ scheduler }: { scheduler: PluginServiceSchedulerV1 }) => {
    scopes.add(scheduler);
  });
  const prepareSibling = vi.fn();
  const { instance } = registerOwnedCatalog({ prepare, onDisconnect: cleanup }, [
    { prepare: prepareSibling, onDisconnect: successfulSibling },
  ]);
  const lifetime = await ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root });
  try {
    expect(scopes.size).toBe(1);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepareSibling).toHaveBeenCalledOnce();
    const initial = [...scopes][0]!;
    const retirementError = await lifetime.disconnect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(retirementError).toBeInstanceOf(AggregateError);
    expect(retirementError).toMatchObject({ errors: [failure] });
    expect(initial.signal.aborted).toBe(true);
    expect(instance.hasRetainedConsumers).toBe(true);
    await expect(lifetime.prepare()).rejects.toBe(retirementError);
    expect(scopes.size).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(successfulSibling).toHaveBeenCalledOnce();

    await lifetime.disconnect();
    await lifetime.disconnect();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(successfulSibling).toHaveBeenCalledOnce();
    await lifetime.prepare();
    expect(scopes.size).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepareSibling).toHaveBeenCalledTimes(2);
    expect([...scopes][1]?.signal.aborted).toBe(false);
    await lifetime.disconnect();
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(successfulSibling).toHaveBeenCalledTimes(2);
    await lifetime.close();
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(successfulSibling).toHaveBeenCalledTimes(2);
  } finally {
    await lifetime.close();
    await root.stop();
    await instance.dispose();
  }
});

it.each(["disconnect", "availability"] as const)(
  "retains physical cleanup custody after %s failure and retries only unfinished cleanup",
  async (failingOwner) => {
    vi.useFakeTimers();
    const root = createTestGatewayScheduler("fake-timers");
    const failedCleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("catalog cleanup is unavailable"))
      .mockResolvedValue(undefined);
    const disconnect = failingOwner === "disconnect" ? failedCleanup : vi.fn();
    const watchAvailability = vi
      .fn<NonNullable<OpenClawPluginNodeHostCommandV2["watchAvailability"]>>()
      .mockReturnValueOnce(failingOwner === "availability" ? failedCleanup : undefined);
    const { instance } = registerOwnedCatalog({
      prepare: () => {},
      onDisconnect: disconnect,
      watchAvailability,
    });
    const disposed = vi.fn();
    instance.lifecycle.onDispose(disposed);
    const lifetime = await ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root });
    lifetime.watchAvailability(() => {});
    let disposing: ReturnType<typeof instance.dispose> | undefined;
    try {
      await expect(lifetime.close()).rejects.toThrow("node plugin owner close failed");
      disposing = instance.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(disposed).not.toHaveBeenCalled();
      expect(instance.lifecycle.signal.aborted).toBe(false);
      await expect(lifetime.prepare()).rejects.toThrow(
        failingOwner === "disconnect" ? "retry cleanup" : "owner is retired",
      );
      await lifetime.close();
      await disposing;
      expect(failedCleanup).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledTimes(failingOwner === "disconnect" ? 2 : 1);
      expect(disposed).toHaveBeenCalledOnce();
    } finally {
      await lifetime.close().catch(() => undefined);
      await disposing;
      await root.stop();
      await instance.dispose();
    }
  },
);

it("preserves preparation and cleanup failures while retaining the failed owner's physical custody", async () => {
  vi.useFakeTimers();
  const root = createTestGatewayScheduler("fake-timers");
  const preparationFailure = new Error("catalog admission failed");
  const cleanupFailure = new Error("catalog cleanup failed");
  const cleanup = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(cleanupFailure)
    .mockResolvedValue(undefined);
  const { instance } = registerOwnedCatalog({
    prepare: () => {
      throw preparationFailure;
    },
    onDisconnect: cleanup,
  });
  const disposed = vi.fn();
  instance.lifecycle.onDispose(disposed);
  let disposing: ReturnType<typeof instance.dispose> | undefined;
  try {
    await expect(
      ensureNodeHostPluginRegistry({ config: {}, scheduler: root }),
    ).rejects.toMatchObject({
      name: "SuppressedError",
      suppressed: preparationFailure,
      error: { errors: [{ errors: [cleanupFailure] }] },
    });
    expect(instance.hasRetainedConsumers).toBe(true);
    disposing = instance.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(disposed).not.toHaveBeenCalled();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const replacement = await ensureNodeHostPluginRegistry({ config: {}, scheduler: root });
    await replacement.close();
    await disposing;
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(disposed).toHaveBeenCalledOnce();
  } finally {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const replacement = await ensureNodeHostPluginRegistry({ config: {}, scheduler: root });
    await replacement.close();
    await disposing;
    await root.stop();
    await instance.dispose();
  }
});

it.each(["abortable", "late acquisition"] as const)(
  "settles %s preparation before final disconnect cleanup",
  async (preparationKind) => {
    vi.useFakeTimers();
    const root = createTestGatewayScheduler("fake-timers");
    const entered = createDeferred<void>();
    const canceled = createDeferred<void>();
    const release = createDeferred<void>();
    const events: string[] = [];
    let resourceOpen = false;
    const cleanup = vi.fn(() => {
      events.push("disconnect");
      resourceOpen = false;
    });
    const { instance } = registerOwnedCatalog({
      prepare: async ({ scheduler }) => {
        scheduler.signal.addEventListener("abort", () => canceled.resolve(), { once: true });
        entered.resolve();
        if (preparationKind === "abortable") {
          await canceled.promise;
          events.push("settled");
          scheduler.signal.throwIfAborted();
        } else {
          await release.promise;
          resourceOpen = true;
          events.push("settled");
        }
      },
      onDisconnect: cleanup,
    });
    const first = ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root });
    const firstOutcome = first.then(
      () => "started",
      () => "retired",
    );
    await entered.promise;
    setActivePluginRegistry(createEmptyPluginRegistry());
    let next: Awaited<ReturnType<typeof ensureNodeHostPluginRegistry>> | undefined;
    const replacing = ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root }).then(
      (owner) => {
        next = owner;
      },
    );
    try {
      await canceled.promise;
      if (preparationKind === "late acquisition") {
        await vi.advanceTimersByTimeAsync(0);
        expect(cleanup).not.toHaveBeenCalled();
        release.resolve();
      }
      await expect(firstOutcome).resolves.toBe("retired");
      await replacing;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(events).toEqual(["settled", "disconnect"]);
      expect(resourceOpen).toBe(false);
    } finally {
      release.resolve();
      await firstOutcome;
      await replacing.catch(() => undefined);
      await next?.close();
      await root.stop();
      await instance.dispose();
    }
  },
);

it("joins a retired plugin connection before preparing a fresh scope and preserves V1 preparation", async () => {
  vi.useFakeTimers();
  const root = createTestGatewayScheduler("fake-timers");
  const held = createDeferred<void>();
  const started = createDeferred<void>();
  const scopes: PluginServiceSchedulerV1[] = [];
  const prepare = vi.fn(({ scheduler }: { scheduler: PluginServiceSchedulerV1 }) => {
    scopes.push(scheduler);
    scheduler.schedule({
      id: "held",
      delayMs: 0,
      run: async () => {
        started.resolve();
        await held.promise;
      },
    });
  });
  const prepareV1 = vi.fn();
  const disconnect = vi.fn();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "catalog" }));
  registry.nodeHostCommands = [
    ...["catalog.list", "catalog.read"].map((command) => ({
      pluginId: "catalog",
      source: "test",
      command: {
        apiVersion: 2 as const,
        command,
        prepare,
        onDisconnect: disconnect,
        handle: async () => "catalog-response",
      },
    })),
    {
      pluginId: "catalog",
      source: "test",
      command: {
        command: "catalog.legacy",
        prepare: prepareV1,
        handle: async () => "legacy-response",
      },
    },
  ];
  setActivePluginRegistry(registry);
  const lifetime = await ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root });
  try {
    expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    await started.promise;
    const stopped = vi.fn();
    const retirement = lifetime.disconnect().then(stopped);
    const reprepare = lifetime.prepare();
    expect(scopes[0]?.signal.aborted).toBe(true);
    expect(() => scopes[0]?.schedule({ id: "late", delayMs: 0, run: () => {} })).toThrow("closed");
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();

    held.resolve();
    await retirement;
    await reprepare;
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepareV1).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(scopes[1]?.signal.aborted).toBe(false);
    await expect(invokeRegisteredNodeHostCommand("catalog.list")).resolves.toBe("catalog-response");
  } finally {
    held.resolve();
    await lifetime.close();
    await root.stop();
  }
});

it("joins the old registry before publishing a replacement node plugin owner", async () => {
  vi.useFakeTimers();
  const root = createTestGatewayScheduler("fake-timers");
  const held = createDeferred<void>();
  const first = createEmptyPluginRegistry();
  first.plugins.push(createPluginRecord({ id: "catalog" }));
  first.nodeHostCommands.push({
    pluginId: "catalog",
    source: "test",
    command: {
      apiVersion: 2,
      command: "catalog.list",
      prepare: ({ scheduler }) => {
        scheduler.schedule({ id: "held", delayMs: 0, run: () => held.promise });
      },
      handle: async () => "first",
    },
  });
  setActivePluginRegistry(first);
  const firstOwner = await ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root });
  let replacement: Awaited<ReturnType<typeof ensureNodeHostPluginRegistry>> | undefined;
  let replacing: Promise<Awaited<ReturnType<typeof ensureNodeHostPluginRegistry>>> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(0);
    const second = createEmptyPluginRegistry();
    second.plugins.push(createPluginRecord({ id: "catalog" }));
    second.nodeHostCommands.push({
      pluginId: "catalog",
      source: "test",
      command: {
        apiVersion: 2,
        command: "catalog.list",
        prepare: () => {},
        handle: async () => "second",
      },
    });
    setActivePluginRegistry(second);
    const published = vi.fn();
    replacing = ensureNodeHostPluginRegistry({ config: {}, env: {}, scheduler: root }).then(
      (owner) => {
        replacement = owner;
        published();
        return owner;
      },
    );
    await Promise.resolve();
    expect(published).not.toHaveBeenCalled();
    held.resolve();
    await replacing;
    await expect(firstOwner.prepare()).rejects.toThrow("retired");
    await expect(invokeRegisteredNodeHostCommand("catalog.list")).resolves.toBe("second");
  } finally {
    held.resolve();
    await replacing?.catch(() => undefined);
    await replacement?.close();
    await firstOwner.close();
    await root.stop();
  }
});
