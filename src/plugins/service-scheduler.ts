import { randomUUID } from "node:crypto";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";

export function createPluginServiceScheduler(
  scheduler: GatewayScheduler,
  runOwned?: (run: () => void | Promise<unknown>) => void | Promise<unknown>,
): PluginServiceSchedulerV1 {
  const createScope = (parent?: Set<PluginServiceSchedulerV1>): PluginServiceSchedulerV1 => {
    const owner = scheduler.scope();
    const prefix = `plugin-service:${randomUUID()}:`;
    const children = new Set<PluginServiceSchedulerV1>();
    let stopping: Promise<void> | undefined;
    const assertOpen = () => {
      if (owner.signal.aborted) {
        throw new Error("Plugin service scheduler is closed");
      }
    };
    const beginClose = () => {
      owner.beginClose();
      for (const child of children) {
        child.beginClose();
      }
    };
    const scope: PluginServiceSchedulerV1 = {
      version: 1,
      signal: owner.signal,
      now: owner.now,
      schedule: (params) => {
        assertOpen();
        const schedule = () =>
          owner.schedule({
            ...params,
            id: `${prefix}${params.id}`,
            run: runOwned ? () => runOwned(params.run) : params.run,
          });
        return runOwned ? runInDetachedAsyncContext(schedule) : schedule();
      },
      scope: () => {
        assertOpen();
        const child = createScope(children);
        children.add(child);
        return child;
      },
      beginClose,
      stop: () => {
        beginClose();
        stopping ??= Promise.all([owner.stop(), ...Array.from(children, (child) => child.stop())])
          .then(() => undefined)
          .finally(() => parent?.delete(scope));
        return stopping;
      },
    };
    return scope;
  };
  return createScope();
}
