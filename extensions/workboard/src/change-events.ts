import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginServiceV2 } from "../api.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 1000;

export function createWorkboardChangeEventService(
  store: Pick<
    WorkboardStore,
    "ready" | "subscribeChanges" | "announceChangeEpoch" | "reconcileExternalChanges"
  >,
): OpenClawPluginServiceV2 & { stop: () => Promise<void> } {
  let unsubscribe: (() => void) | undefined;
  let scheduler: PluginServiceSchedulerV1 | undefined;
  let generation = 0;
  let starting: { generation: number; promise: Promise<void> } | undefined;

  return {
    id: "workboard-change-events",
    apiVersion: 2,
    start(ctx) {
      const gatewayEvents = ctx.gatewayEvents;
      if (!gatewayEvents || unsubscribe) {
        return Promise.resolve();
      }
      if (starting?.generation === generation) {
        return starting.promise;
      }
      const currentGeneration = generation;
      const previous = starting?.promise;
      const pending = (async () => {
        await previous?.catch(() => undefined);
        await store.ready();
        if (currentGeneration !== generation || ctx.scheduler.signal.aborted) {
          return;
        }
        const emit = (change: WorkboardChange) => {
          gatewayEvents.emit("changed", change, {
            scope: "operator.read",
          });
        };
        unsubscribe = store.subscribeChanges(emit);
        store.announceChangeEpoch();
        scheduler = ctx.scheduler.scope();
        scheduler.schedule({
          id: "external-change-check",
          delayMs: WORKBOARD_EXTERNAL_CHANGE_CHECK_MS,
          everyMs: WORKBOARD_EXTERNAL_CHANGE_CHECK_MS,
          run: async () => {
            try {
              await store.reconcileExternalChanges();
            } catch (error) {
              ctx.logger.warn(`workboard external change check failed: ${String(error)}`);
            }
          },
        });
      })().finally(() => {
        if (starting?.promise === pending) {
          starting = undefined;
        }
      });
      starting = { generation: currentGeneration, promise: pending };
      return pending;
    },
    stop() {
      generation += 1;
      unsubscribe?.();
      unsubscribe = undefined;
      return Promise.allSettled([starting?.promise, scheduler?.stop()]).then(() => undefined);
    },
  };
}
