import { expect, it } from "vitest";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../gateway/operator-tool-gateway-authority.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { createLegacyPluginServiceScheduler } from "../plugin-sdk/channel-outbound.js";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createAuthRateLimiter } from "../plugin-sdk/webhook-ingress.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "./legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { createPluginRegistry } from "./registry.js";
import {
  bindGatewayContextResolver,
  getInProcessGatewayRequestContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";
import { getPluginServiceCleanupSettlement, startPluginServices } from "./services.js";
import { createPluginRecord } from "./status.test-helpers.js";

it("owns service callbacks after startup and reload callers finish", async () => {
  const context = createGatewayRequestContext(makeContextParams());
  const runtime = createPluginRuntime();
  bindGatewayContextResolver(runtime, () => context);
  const registry = createEmptyPluginRegistry();
  bindPluginRegistryRuntime(registry, runtime);
  const record = createPluginRecord({ id: "scheduled-context", origin: "bundled" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const clock = createGatewaySchedulerClock();
  const gatewayScheduler = createTestGatewayScheduler(clock.clock);
  const scopes: PluginServiceSchedulerV1[] = [];
  const observations: Array<{
    liveInstance: boolean;
    gateway: boolean;
    request: boolean;
    operator: boolean;
  }> = [];
  const observe = async () => {
    await Promise.resolve();
    observations.push({
      liveInstance:
        pluginInstanceInvocation.getStore()?.instance === instance && instance.hasActiveCall,
      gateway: getInProcessGatewayRequestContext() === context,
      request: getPluginRuntimeGatewayRequestScope()?.client !== undefined,
      operator: readOperatorToolGatewayAuthority() !== undefined,
    });
    registerPluginHttpRoute({
      path: `/scheduled-context/${observations.length}`,
      auth: "plugin",
      handler: async () => true,
      pluginId: record.id,
      throwOnFailure: true,
    });
  };
  registry.services.push({
    id: "scheduled-context",
    pluginId: record.id,
    source: record.source,
    origin: record.origin,
    service: {
      apiVersion: 2,
      id: "scheduled-context",
      start({ scheduler }) {
        scopes.push(scheduler);
        scheduler.schedule({ id: "startup", delayMs: 1, run: observe });
      },
    },
  });
  const runFromRequest = async <T>(run: () => T | Promise<T>): Promise<T> => {
    const caller = new AbortController();
    try {
      return await runWithOperatorToolGatewayAuthority(
        { signal: caller.signal, scopes: ["operator.read"], operatorRoleActor: { kind: "system" } },
        () =>
          withPluginRuntimeGatewayRequestScope(
            {
              context,
              client: createSyntheticPluginRuntimeClient({ scopes: ["operator.read"] }),
              signal: caller.signal,
              isWebchatConnect: () => false,
            },
            run,
          ),
      );
    } finally {
      caller.abort(new Error("Caller completed"));
    }
  };
  const services = await runFromRequest(() =>
    startPluginServices({ registry, config: {}, scheduler: gatewayScheduler }),
  );
  try {
    await clock.advanceBy(1);
    await runFromRequest(() =>
      scopes[0]!.schedule({ id: "later-request", delayMs: 1, run: observe }),
    );
    await clock.advanceBy(1);
    expect(registry.httpRoutes.map((route) => route.path)).toEqual([
      "/scheduled-context/1",
      "/scheduled-context/2",
    ]);
    await runFromRequest(() => services.reload({}, new Set(["scheduled-context"])));
    await clock.advanceBy(1);
    expect(observations).toEqual([
      { liveInstance: true, gateway: true, request: false, operator: false },
      { liveInstance: true, gateway: true, request: false, operator: false },
      { liveInstance: true, gateway: true, request: false, operator: false },
    ]);
    expect(scopes[0]!.signal.aborted).toBe(true);
    expect(scopes[1]!.signal.aborted).toBe(false);
    expect(() => scopes[0]!.schedule({ id: "retired", delayMs: 0, run: observe })).toThrow(
      "closed",
    );
    expect(registry.httpRoutes.map((route) => route.path)).toEqual(["/scheduled-context/3"]);
    await services.stop();
    expect(registry.httpRoutes).toHaveLength(0);
  } finally {
    await services.stop();
    await gatewayScheduler.stop();
    await instance.dispose();
  }
});

it("keeps standalone scheduled services free of an unbound Gateway resolver", async () => {
  const registry = createEmptyPluginRegistry();
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  let opened = false;
  registry.services.push({
    id: "standalone",
    pluginId: "standalone",
    source: "synthetic",
    origin: "workspace",
    service: {
      apiVersion: 2,
      id: "standalone",
      start({ scheduler }) {
        scheduler.schedule({
          id: "legacy-resource",
          delayMs: 1,
          run: () => {
            const limiter = createAuthRateLimiter();
            limiter.dispose();
            opened = true;
          },
        });
      },
    },
  });
  const services = await startPluginServices({ registry, config: {}, scheduler });
  try {
    await clock.advanceBy(1);
    expect(opened).toBe(true);
  } finally {
    await services.stop();
    await scheduler.stop();
  }
});

it("settles scheduled callbacks before the disposal that stops their service", async () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "scheduled-disposal", origin: "bundled" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const events: string[] = [];
  instance.lifecycle.onDispose(() => {
    events.push("disposed");
  });
  registry.services.push({
    id: record.id,
    pluginId: record.id,
    source: record.source,
    origin: record.origin,
    service: {
      apiVersion: 2,
      id: record.id,
      start({ scheduler }) {
        scheduler.schedule({
          id: "held",
          delayMs: 1,
          run: async () => {
            entered.resolve();
            await release.promise;
            events.push("callback");
          },
        });
      },
      stop() {
        events.push("stopped");
      },
    },
  });
  const services = await startPluginServices({ registry, config: {}, scheduler });
  const tick = clock.advanceBy(1);
  await entered.promise;
  const disposal = instance.dispose(async () => {
    await services.stop();
  });
  try {
    expect(instance.acceptingCalls).toBe(false);
    release.resolve();
    const [result] = await Promise.all([disposal, tick]);
    expect(result.errors).toEqual([]);
    expect(events).toEqual(["callback", "stopped", "disposed"]);
  } finally {
    release.resolve();
    await Promise.allSettled([tick, disposal, services.stop(), scheduler.stop()]);
  }
});

it("keeps registered V1 runtime slots and HTTP leases without retaining requester authority", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const host = new LegacyPluginSdkResourceHost();
  host.bindScheduler(scheduler);
  const context = createGatewayRequestContext(makeContextParams());
  const resolveGatewayContext = () => context;
  bindLegacyPluginSdkResourceHost(resolveGatewayContext, host);
  const runtime = createPluginRuntime();
  bindGatewayContextResolver(runtime, resolveGatewayContext);
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
  const registry = builder.registry;
  const record = createPluginRecord({ id: "legacy-scheduled-context", origin: "bundled" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const store = createPluginRuntimeStore<string>("Registered V1 runtime is missing");
  const httpLease = createPluginRuntimeCapabilityLease("legacy service HTTP owner");
  const routeErrors: unknown[] = [];
  let legacyScheduler: PluginServiceSchedulerV1 | undefined;
  const observations: Array<{
    runtime: string;
    liveInstance: boolean;
    gateway: boolean;
    requester: boolean;
    operator: boolean;
  }> = [];
  const expectedContext = {
    runtime: "registered-runtime",
    liveInstance: true,
    gateway: true,
    requester: false,
    operator: false,
  };
  instance.run(() => {
    store.setRuntime("registered-runtime");
    builder.createApi(record, { config: {} }).registerService({
      id: record.id,
      start() {
        legacyScheduler = createLegacyPluginServiceScheduler();
        legacyScheduler.schedule({
          id: "legacy-poll",
          delayMs: 1,
          everyMs: 1,
          run: async () => {
            await Promise.resolve();
            observations.push({
              runtime: store.getRuntime(),
              liveInstance:
                pluginInstanceInvocation.getStore()?.instance === instance &&
                instance.hasActiveCall,
              gateway: getInProcessGatewayRequestContext() === context,
              requester: getPluginRuntimeGatewayRequestScope()?.client !== undefined,
              operator: readOperatorToolGatewayAuthority() !== undefined,
            });
            try {
              registerPluginHttpRoute({
                path: `/legacy-scheduled-context/${observations.length}`,
                auth: "plugin",
                handler: async () => true,
                pluginId: record.id,
                throwOnFailure: true,
              });
            } catch (error) {
              routeErrors.push(error);
            }
          },
        });
      },
      stop: () => legacyScheduler?.stop(),
    });
  });
  const caller = new AbortController();
  const services = await runWithOperatorToolGatewayAuthority(
    { signal: caller.signal, scopes: ["operator.read"], operatorRoleActor: { kind: "system" } },
    () =>
      withPluginRuntimeGatewayRequestScope(
        {
          resolveGatewayContext,
          client: createSyntheticPluginRuntimeClient({ scopes: ["operator.read"] }),
          signal: caller.signal,
          isWebchatConnect: () => false,
        },
        () =>
          withPluginHttpRouteRegistry(
            registry,
            () => startPluginServices({ registry, config: {}, scheduler }),
            httpLease,
          ),
      ),
  );
  caller.abort(new Error("Initiating request completed"));
  try {
    expect(instance.hasRetainedConsumers).toBe(false);
    await clock.advanceBy(1);
    expect(observations).toEqual([expectedContext]);
    expect(routeErrors).toEqual([]);
    expect(registry.httpRoutes.map((route) => route.path)).toEqual(["/legacy-scheduled-context/1"]);
    httpLease.revoke();
    expect(registry.httpRoutes).toEqual([]);
    await clock.advanceBy(1);
    expect(observations).toEqual([expectedContext, expectedContext]);
    expect(routeErrors).toEqual([new Error("plugin runtime HTTP route lease is no longer active")]);
    expect(registry.httpRoutes).toEqual([]);
    await services.stop();
    expect(legacyScheduler?.signal.aborted).toBe(true);
    expect(() => legacyScheduler?.schedule({ id: "retired", delayMs: 0, run() {} })).toThrow(
      "closed",
    );
  } finally {
    httpLease.revoke();
    await services.stop();
    await scheduler.stop();
    await host.close();
    await instance.dispose();
  }
});

it("rejects new V1 scheduling from cleanup after its service deadline revoked admission", async () => {
  const scheduler = createTestGatewayScheduler();
  const host = new LegacyPluginSdkResourceHost();
  host.bindScheduler(scheduler);
  const context = createGatewayRequestContext(makeContextParams());
  const resolveGatewayContext = () => context;
  bindLegacyPluginSdkResourceHost(resolveGatewayContext, host);
  const runtime = createPluginRuntime();
  bindGatewayContextResolver(runtime, resolveGatewayContext);
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
  const registry = builder.registry;
  const record = createPluginRecord({ id: "expired-legacy-service", origin: "bundled" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const stopEntered = createDeferredCore();
  const resumeStop = createDeferredCore();
  let activeCleanup = false;
  let admissionError: unknown;
  let legacyScheduler: PluginServiceSchedulerV1 | undefined;
  instance.run(() => {
    builder.createApi(record, { config: {} }).registerService({
      id: record.id,
      start() {
        legacyScheduler = createLegacyPluginServiceScheduler();
      },
      async stop() {
        stopEntered.resolve();
        await resumeStop.promise;
        activeCleanup = instance.hasActiveCall && instance.acceptingCalls;
        let lateScheduler: PluginServiceSchedulerV1 | undefined;
        try {
          lateScheduler = createLegacyPluginServiceScheduler();
        } catch (error) {
          admissionError = error;
        } finally {
          await lateScheduler?.stop();
          await legacyScheduler?.stop();
        }
      },
    });
  });
  const services = await startPluginServices({ registry, config: {}, scheduler });
  let settlement: Promise<void> | undefined;
  try {
    const failedStop = services
      .stop({ strict: true, deadlineAtMs: Date.now() })
      .catch((error: unknown) => error);
    await stopEntered.promise;
    const failure = await failedStop;
    const pending = getPluginServiceCleanupSettlement(failure);
    expect(pending).toBeDefined();
    settlement = pending?.settled;
    expect(instance.acceptingCalls).toBe(true);
    expect(legacyScheduler?.signal.aborted).toBe(false);
    resumeStop.resolve();
    await settlement;
    expect(activeCleanup).toBe(true);
    expect(admissionError).toEqual(
      new Error("plugin runtime HTTP route lease is no longer active"),
    );
    expect(legacyScheduler?.signal.aborted).toBe(true);
  } finally {
    resumeStop.resolve();
    await settlement;
    await services.stop();
    await scheduler.stop();
    await host.close();
    await instance.dispose();
  }
});
