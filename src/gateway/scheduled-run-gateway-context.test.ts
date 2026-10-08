import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { spawnWithFallback } from "../process/spawn-utils.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createScheduledGatewayRunner } from "./scheduled-run-gateway-context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

describe.skipIf(process.platform === "win32")("scheduled Gateway broker ownership", () => {
  const createBroker = useSpawnBrokerTestFixture(afterEach);
  it("preserves the lifecycle-owned plugin registry while dropping request context", async () => {
    const registry = createEmptyPluginRegistry();
    const requestContext = {} as GatewayRequestContext;
    const runScheduled = createScheduledGatewayRunner(
      () => undefined,
      () => registry,
    );

    await withPluginRuntimeGatewayRequestScope(
      { context: requestContext, isWebchatConnect: () => false, pluginRegistry: registry },
      () =>
        runInDetachedAsyncContext(() =>
          runScheduled(async () => {
            const scope = getPluginRuntimeGatewayRequestScope();
            expect(scope?.pluginRegistry).toBe(registry);
            expect(scope?.context).toBeUndefined();
            expect(scope?.resolveGatewayContext?.()).toBeUndefined();
          }),
        ),
    );
  });

  it("restores only its transport and never borrows another Gateway's broker", async () => {
    const firstBroker = expectDefined(await createBroker(), "first broker");
    const secondBroker = expectDefined(await createBroker(), "second broker");
    const runFirst = runWithSpawnBroker(firstBroker, () => createScheduledGatewayRunner());
    const runWithoutBroker = createScheduledGatewayRunner();
    const callbackContext = new AsyncLocalStorage<string>();
    await callbackContext.run("callback", () =>
      runWithSpawnBroker(secondBroker, () =>
        withGatewayToolCallerIdentity({ agentId: "main", sessionKey: "request" }, async () => {
          await runFirst(async () => {
            await Promise.resolve();
            expect(getSpawnBroker()).toBe(firstBroker);
            expect(getGatewayToolCallerIdentity()).toBeUndefined();
            expect(callbackContext.getStore()).toBe("callback");
          });
          expect(getSpawnBroker()).toBe(secondBroker);
          expect(getGatewayToolCallerIdentity()?.sessionKey).toBe("request");
          await runWithoutBroker(async () => {
            expect(getSpawnBroker()).toBeUndefined();
          });
        }),
      ),
    );

    await firstBroker.close();
    await expect(
      runWithSpawnBroker(secondBroker, () =>
        runFirst(() =>
          spawnWithFallback({
            argv: [process.execPath, "-e", "process.exit(0)"],
            options: { stdio: "ignore" },
          }),
        ),
      ),
    ).rejects.toThrow("Spawn broker is unavailable");
  });
});
