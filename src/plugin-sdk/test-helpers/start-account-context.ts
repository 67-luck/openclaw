/**
 * Test helper for constructing a channel account startup context.
 */
import { vi } from "vitest";
import type { ChannelGatewayContextV2 } from "../../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginServiceScheduler } from "../../plugins/service-scheduler.js";
import type { PluginServiceSchedulerV1 } from "../../plugins/service-scheduler.types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";

/** Creates a minimal ChannelGatewayContextV2 with mutable status for startAccount tests. */
export function createStartAccountContext<TAccount extends { accountId: string }>(params: {
  account: TAccount;
  scheduler?: PluginServiceSchedulerV1;
  abortSignal?: AbortSignal;
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  statusPatchSink?: (next: ChannelAccountSnapshot) => void;
}): ChannelGatewayContextV2<TAccount> {
  const snapshot: ChannelAccountSnapshot = {
    accountId: params.account.accountId,
    configured: true,
    enabled: true,
    running: false,
  };
  return {
    scheduler:
      params.scheduler ?? createPluginServiceScheduler(createTestGatewayScheduler("fake-timers")),
    accountId: params.account.accountId,
    account: params.account,
    cfg: params.cfg ?? ({} as OpenClawConfig),
    runtime: params.runtime ?? createRuntimeEnv(),
    abortSignal: params.abortSignal ?? new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: (next) => {
      Object.assign(snapshot, next);
      params.statusPatchSink?.(snapshot);
    },
  };
}
