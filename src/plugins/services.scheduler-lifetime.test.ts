import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";
import { startPluginServices } from "./services.js";

it("starts service stop before joining scheduled work and preserves sibling scheduling", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const entered = createDeferredCore();
  const stopCalled = createDeferredCore();
  const physicalWork = createDeferredCore();
  const stopFlush = createDeferredCore();
  const admitted = createDeferredCore<PluginServiceSchedulerV1>();
  let siblingTicks = 0;
  const registry = createEmptyPluginRegistry();
  registry.services.push(
    {
      pluginId: "first",
      id: "first",
      source: "synthetic",
      origin: "workspace",
      service: {
        apiVersion: 2,
        id: "first",
        start(context) {
          admitted.resolve(context.scheduler);
          context.scheduler.schedule({
            id: "tick",
            delayMs: 1,
            everyMs: 1,
            run: async () => {
              entered.resolve();
              await stopCalled.promise;
              await physicalWork.promise;
            },
          });
        },
        async stop() {
          stopCalled.resolve();
          await stopFlush.promise;
        },
      },
    },
    {
      pluginId: "second",
      id: "second",
      source: "synthetic",
      origin: "workspace",
      service: {
        apiVersion: 2,
        id: "second",
        start(context) {
          context.scheduler.schedule({
            id: "tick",
            delayMs: 1,
            everyMs: 1,
            run: () => {
              siblingTicks += 1;
            },
          });
        },
      },
    },
  );
  const services = await startPluginServices({ registry, config: {}, scheduler });
  const retained = await admitted.promise;
  const running = clock.advanceBy(1);
  let retired = false;
  const stopping = services.stop({ strict: true, pluginIds: new Set(["first"]) }).then(() => {
    retired = true;
  });
  try {
    await entered.promise;
    await stopCalled.promise;
    expect(retired).toBe(false);
    expect(retained.signal.aborted).toBe(true);
    expect(() => retained.schedule({ id: "late", delayMs: 0, run() {} })).toThrow("closed");
    await clock.advanceBy(1);
    expect(siblingTicks).toBe(2);
    physicalWork.resolve();
    await running;
    expect(retired).toBe(false);
    stopFlush.resolve();
    await stopping;
    await clock.advanceBy(1);
    expect(siblingTicks).toBe(3);
  } finally {
    physicalWork.resolve();
    stopFlush.resolve();
    await Promise.allSettled([running, stopping]);
    await services.stop();
    await scheduler.stop();
  }
});
