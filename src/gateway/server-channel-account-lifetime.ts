import { resolveChannelAccount } from "../channels/account-resolution.js";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "../plugins/capability-lease.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import { getPluginValueInstance, runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { createPluginServiceSchedulerRunner } from "../plugins/service-scheduler-context.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import type { PluginServiceSchedulerV1 } from "../plugins/service-scheduler.types.js";

export type ChannelAccountLifetime = {
  plugin: ChannelPlugin;
  abort: AbortController;
  capabilityLease: PluginRuntimeCapabilityLease;
  scheduler: PluginServiceSchedulerV1;
  teardown?: {
    context: Omit<ChannelGatewayContextV2, "setStatus">;
    run: (context: ChannelGatewayContextV2) => Promise<void>;
  };
};

export type ChannelAccountStopOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown };

export function createChannelAccountLifetime(
  plugin: ChannelPlugin,
  registry: PluginRegistry,
  rootScheduler: GatewayScheduler,
): ChannelAccountLifetime {
  const abort = new AbortController();
  const capabilityLease = createPluginRuntimeCapabilityLease("channel account");
  const instance = getPluginValueInstance(plugin);
  const scheduler = createPluginServiceScheduler(
    rootScheduler,
    createPluginServiceSchedulerRunner({
      registry,
      record: instance?.owner?.record,
      instance,
      lease: capabilityLease,
    }),
  );
  abort.signal.addEventListener("abort", scheduler.beginClose, { once: true });
  return { plugin, abort, capabilityLease, scheduler };
}

export async function runChannelAccountStop(params: {
  registry: PluginRegistry;
  rootScheduler: GatewayScheduler;
  lease: PluginRuntimeCapabilityLease;
  teardown: ChannelAccountLifetime["teardown"];
  fallback?: {
    plugin: ChannelPlugin;
    gateway: NonNullable<ChannelPlugin["gateway"]>;
    stopAccount: NonNullable<NonNullable<ChannelPlugin["gateway"]>["stopAccount"]>;
    cfg: OpenClawConfig;
    accountId: string;
  };
  createFallbackContext: (
    account: unknown,
    scheduler: PluginServiceSchedulerV1,
  ) => Omit<ChannelGatewayContextV2, "setStatus">;
  setStatus: ChannelGatewayContextV2["setStatus"];
  onError: (error: unknown) => void;
}): Promise<ChannelAccountStopOutcome> {
  try {
    await withPluginHttpRouteRegistry(
      params.registry,
      async () => {
        let teardown = params.teardown;
        if (params.fallback) {
          const { plugin, gateway, stopAccount, cfg, accountId } = params.fallback;
          const account = await runPluginCleanup(plugin, () =>
            resolveChannelAccount({ plugin, cfg, accountId }),
          );
          params.lease.assertActive("account resolution");
          const scheduler = createPluginServiceScheduler(params.rootScheduler);
          await scheduler.stop();
          teardown = {
            context: params.createFallbackContext(account, scheduler),
            run: (context) =>
              runPluginCleanup(stopAccount, () => stopAccount.call(gateway, context)),
          };
        }
        if (!teardown) {
          return;
        }
        const { context, run } = teardown;
        params.lease.assertActive("account cleanup");
        // The owner cancels transport and flushes admitted delivery before its work can join.
        const cleanup = Promise.resolve().then(() =>
          run({ ...context, setStatus: params.setStatus }),
        );
        const settled = await Promise.allSettled([cleanup, context.scheduler.stop()]);
        for (const result of settled) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      },
      params.lease,
    );
    return { status: "fulfilled" };
  } catch (error) {
    params.onError(error);
    return { status: "rejected", error };
  }
}

export async function waitForDeferredAccountStart(
  deferred: Promise<void>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }
  await Promise.race([
    deferred,
    new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}
