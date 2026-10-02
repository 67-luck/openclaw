// Adapts server-local chat and terminal state to the shared activity inspector.
import { getActiveCronJobCount } from "../cron/active-jobs.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import {
  isRpcSourceQueued,
  listRpcSourceEntries,
} from "../sessions/session-controller.rpc-sources.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export function createGatewayServerActiveWorkInspectors(
  context: Pick<GatewayRequestContext, "cron" | "terminalSessions">,
): Partial<GatewayActiveWorkInspectors> {
  return {
    getCronRuns: () =>
      Math.max(getActiveCronJobCount(), getSuspensionVisibleCronTaskRunCount()) +
      (context.cron.getSuspensionBlockerCount?.() ?? 0),
    getChatRuns: () =>
      listRpcSourceEntries().filter(
        ([, entry]) =>
          !entry.input.abortSignal.aborted &&
          entry.input.phase !== "consumed" &&
          !isRpcSourceQueued(entry),
      ).length,
    getQueuedTurns: () =>
      listRpcSourceEntries().filter(([, entry]) => isRpcSourceQueued(entry)).length,
    getTerminalPersistence: () =>
      listRpcSourceEntries().filter(
        ([, entry]) =>
          entry.adapter.controlUiVisible !== false &&
          entry.adapter.projectSessionTerminalPersisted !== true &&
          (entry.adapter.projectSessionTerminalPending === true ||
            entry.adapter.projectSessionTerminalPersistence !== undefined),
      ).length,
    getTerminalSessions: () => context.terminalSessions?.size ?? 0,
  };
}
