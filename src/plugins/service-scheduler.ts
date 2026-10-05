import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";

/** A plugin reports deadlines; the existing Gateway scheduler owns every wake. */
export function createPluginServiceScheduler(params: {
  scheduler: GatewayScheduler;
  pluginId: string;
  serviceId: string;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  const scope = params.scheduler.scope();
  params.lease.retain(() => scope.beginClose());
  const runScheduled = createScheduledGatewayRunner(params.resolveGatewayContext);
  const assertActive = () => {
    params.lease.assertActive("scheduled service work");
    scope.signal.throwIfAborted();
    if (params.isStopping()) {
      throw new Error("Plugin service scheduler is stopping");
    }
  };
  const capability: NonNullable<OpenClawPluginServiceContext["scheduler"]> = {
    signal: scope.signal,
    // Cleanup may still timestamp accepted ingress settlement after scheduling closes.
    // Reading the clock grants no authority to schedule or execute another callback.
    now: scope.now,
    schedule: ({ id, atMs, mode, run }) => {
      assertActive();
      if (!id.trim()) {
        throw new Error("Plugin service deadline requires an id");
      }
      const key = JSON.stringify(["plugin-service", params.pluginId, params.serviceId, id]);
      return scope.schedule({
        id: key,
        atMs,
        mode,
        run: () =>
          runScheduled(() =>
            runWithGatewayIndependentRootWorkAdmission(
              async () => {
                assertActive();
                return await run();
              },
              "plugin-service:deadline",
              scope.signal,
            ),
          ),
      });
    },
  };
  return { capability, beginClose: scope.beginClose, stop: scope.stop };
}

/** Service cleanup and already admitted deadlines must both settle before retirement. */
export function stopPluginServiceScheduledWork(
  stop: (() => unknown) | undefined,
  scheduler: Pick<ReturnType<typeof createPluginServiceScheduler>, "stop"> | undefined,
): unknown {
  if (!scheduler) {
    return stop?.();
  }
  return Promise.allSettled([Promise.resolve().then(() => stop?.()), scheduler.stop()]).then(
    (results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Plugin service cleanup failed");
      }
    },
  );
}
