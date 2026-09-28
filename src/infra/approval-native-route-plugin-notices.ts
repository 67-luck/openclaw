// Owns plugin approval origin bindings and requester notices across native runtimes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import {
  formatRemotePluginApprovalNotice,
  normalizeApprovalRouteChannel,
} from "./approval-native-route-notice.js";
import type {
  ApprovalNativeRouteCoordinatorState,
  ApprovalRouteRuntimeRecord,
  PluginOriginBinding,
  PluginTerminalNotice,
  PluginTerminalStatus,
  RemoteNativeApprovalDeliveryReport,
} from "./approval-native-route-types.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type { ApprovalRequestInput as ApprovalRequest } from "./approval-types.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

export const PLUGIN_TERMINAL_ROUTE_GRACE_MS = 60_000;

export function clearPluginOrigin(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const binding = state.pluginOrigins.get(approvalId);
  if (!binding) {
    return;
  }
  state.pluginOrigins.delete(approvalId);
  clearTimeout(binding.cleanupTimeout);
  binding.releaseApprovalBinding?.();
}

export function capturePluginOrigin(
  state: ApprovalNativeRouteCoordinatorState,
  request: PluginApprovalRequest,
  retainApprovalBinding?: () => (() => void) | null,
): void {
  const source = request.request;
  const channel = normalizeApprovalRouteChannel(source.turnSourceChannel);
  const accountId = normalizeOptionalString(source.turnSourceAccountId);
  const to = normalizeOptionalString(source.turnSourceTo);
  if (
    state.closed ||
    state.pluginOrigins.has(request.id) ||
    request.expiresAtMs <= Date.now() ||
    !source.approvalSource ||
    normalizeApprovalRouteChannel(source.approvalSource.channel) !== channel ||
    !channel ||
    !accountId ||
    !to
  ) {
    return;
  }
  const matches = Array.from(state.activeRuntimes.values()).filter(
    (runtime) =>
      runtime.handledKinds.has("plugin") &&
      normalizeApprovalRouteChannel(runtime.channel) === channel &&
      normalizeOptionalString(runtime.accountId) === accountId &&
      runtime.isOriginCurrent,
  );
  if (matches.length !== 1) {
    return;
  }
  const runtime = matches[0];
  try {
    if (!runtime?.isOriginCurrent?.(request)) {
      return;
    }
  } catch {
    return;
  }
  // The manager's resolved grace is shorter than a remote card handoff. Keep
  // the exact approval binding until this origin route is retired.
  const releaseApprovalBinding = retainApprovalBinding?.();
  if (retainApprovalBinding && !releaseApprovalBinding) {
    return;
  }
  let cleanupTimeout: NodeJS.Timeout | undefined;
  try {
    cleanupTimeout = setTimeout(
      () => clearPluginOrigin(state, request.id),
      Math.min(
        Math.max(0, request.expiresAtMs - Date.now() + PLUGIN_TERMINAL_ROUTE_GRACE_MS),
        0x7fffffff,
      ),
    );
    cleanupTimeout.unref?.();
    state.pluginOrigins.set(request.id, {
      request,
      runtime,
      target: {
        channel,
        to,
        accountId,
        threadId: source.turnSourceThreadId,
      },
      releaseApprovalBinding: releaseApprovalBinding ?? undefined,
      cleanupTimeout,
    });
  } catch (error) {
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
    }
    releaseApprovalBinding?.();
    throw error;
  }
}

function isPluginOriginCurrent(
  state: ApprovalNativeRouteCoordinatorState,
  binding: PluginOriginBinding,
  cfg?: OpenClawConfig,
): boolean {
  const runtime = binding.runtime;
  if (
    state.closed ||
    state.pluginOrigins.get(binding.request.id) !== binding ||
    state.activeRuntimes.get(runtime.runtimeId) !== runtime
  ) {
    return false;
  }
  try {
    return runtime.isOriginCurrent?.(binding.request, cfg) === true;
  } catch {
    return false;
  }
}

export function clearPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const entry = state.pluginTerminalNotices.get(approvalId);
  if (!entry) {
    return;
  }
  state.pluginTerminalNotices.delete(approvalId);
  clearTimeout(entry.cleanupTimeout);
}

export function getPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  request: ApprovalRequest,
): PluginTerminalNotice {
  const existing = state.pluginTerminalNotices.get(request.id);
  if (existing) {
    return existing;
  }
  // Retain the actual native route until the Gateway's expiry can publish its
  // terminal outcome, even if the channel's local card timer fires first.
  const timeoutMs = Math.min(
    Math.max(0, request.expiresAtMs - Date.now()) + PLUGIN_TERMINAL_ROUTE_GRACE_MS,
    0x7fffffff,
  );
  const cleanupTimeout = setTimeout(() => clearPluginTerminalNotice(state, request.id), timeoutMs);
  cleanupTimeout.unref?.();
  const entry: PluginTerminalNotice = { request, sent: false, cleanupTimeout };
  state.pluginTerminalNotices.set(request.id, entry);
  return entry;
}

export async function maybeSendPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): Promise<void> {
  const notice = state.pluginTerminalNotices.get(approvalId);
  if (state.pluginOrigins.get(approvalId)?.originDelivered) {
    clearPluginTerminalNotice(state, approvalId);
    return;
  }
  if (state.closed || !notice?.status || !notice.requestGateway || !notice.target || notice.sent) {
    return;
  }
  if (notice.sending) {
    await notice.sending;
    return;
  }
  const { target } = notice;
  const requestGateway = notice.requestGateway;
  const sending = (async () => {
    await notice.initialNotice?.catch(() => {});
    if (state.closed || state.pluginTerminalNotices.get(approvalId) !== notice) {
      return;
    }
    await requestGateway(
      "send",
      {
        channel: target.channel,
        to: target.to,
        accountId: target.accountId ?? undefined,
        threadId: target.threadId ?? undefined,
        message:
          notice.status === "expired"
            ? `Approval ${approvalId} timed out. The requested action did not run.`
            : `Approval ${approvalId} was denied. The requested action did not run.`,
        idempotencyKey: `approval-terminal-notice:${approvalId}`,
      },
      {
        // Origin status must not survive its reporter or account. A durable
        // queue replay cannot recover the original account's send authority.
        approvalRequest: notice.request,
        liveOnlyWhenCurrent: (cfg) =>
          !state.closed &&
          state.pluginTerminalNotices.get(approvalId) === notice &&
          !state.pluginOrigins.get(approvalId)?.originDelivered &&
          notice.isOriginCurrent?.(cfg) === true,
      },
    );
    notice.sent = true;
  })();
  notice.sending = sending;
  try {
    await sending;
  } finally {
    if (notice.sending === sending) {
      notice.sending = undefined;
    }
  }
}

export async function reportRemoteNativeDelivery(
  state: ApprovalNativeRouteCoordinatorState,
  report: RemoteNativeApprovalDeliveryReport,
  assertReporterCurrent: () => void,
): Promise<void> {
  const binding = state.pluginOrigins.get(report.id);
  if (!binding || !isPluginOriginCurrent(state, binding)) {
    throw new Error("the originating approval account is no longer active");
  }
  assertReporterCurrent();
  if (binding.reported === "delivered" || (binding.reported === "failed" && !report.deliveredAny)) {
    return;
  }
  if (binding.originDelivered) {
    return;
  }
  if (
    normalizeApprovalRouteChannel(report.channel) === binding.target.channel &&
    normalizeOptionalString(report.accountId) &&
    normalizeOptionalString(report.accountId) !== binding.target.accountId
  ) {
    return;
  }
  const runtime = binding.runtime;
  const current = (cfg?: OpenClawConfig) => isPluginOriginCurrent(state, binding, cfg);
  const reportOutcome = report.deliveredAny ? "delivered" : "failed";
  binding.reported = reportOutcome;
  if (binding.terminalStatus === "allowed" || binding.terminalStatus === "cancelled") {
    return;
  }
  const terminalNotice = getPluginTerminalNotice(state, binding.request);
  terminalNotice.requestGateway = runtime.requestGateway;
  terminalNotice.target = binding.target;
  terminalNotice.isOriginCurrent = current;
  if (binding.terminalStatus === "denied" || binding.terminalStatus === "expired") {
    terminalNotice.status = binding.terminalStatus;
  }
  if (!binding.terminalStatus && binding.request.expiresAtMs > Date.now()) {
    const reporterCurrent = () => {
      try {
        assertReporterCurrent();
        return true;
      } catch {
        return false;
      }
    };
    const previousNotice = terminalNotice.initialNotice;
    terminalNotice.initialNotice = Promise.resolve(previousNotice)
      .catch(() => {})
      .then(
        async () =>
          await runtime.requestGateway(
            "send",
            {
              channel: binding.target.channel,
              to: binding.target.to,
              accountId: binding.target.accountId ?? undefined,
              threadId: binding.target.threadId ?? undefined,
              message: formatRemotePluginApprovalNotice({
                approvalId: report.id,
                channelLabel: report.channelLabel || report.channel,
                deliveredAny: report.deliveredAny,
                deliveredOnlyToApproverDms: report.deliveredOnlyToApproverDms,
              }),
              idempotencyKey: `approval-remote-route-notice:${report.id}:${reportOutcome}`,
            },
            {
              approvalRequest: binding.request,
              liveOnlyWhenCurrent: (cfg) =>
                reporterCurrent() &&
                current(cfg) &&
                !binding.terminalStatus &&
                binding.request.expiresAtMs > Date.now(),
            },
          ),
      );
    try {
      await terminalNotice.initialNotice;
    } catch (error) {
      // A refused or uncertain pending send must not block a later denial notice.
      terminalNotice.initialNotice = undefined;
      await maybeSendPluginTerminalNotice(state, report.id);
      throw error;
    }
  }
  await maybeSendPluginTerminalNotice(state, report.id);
}

export function markPluginOriginDelivered(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
  runtime: ApprovalRouteRuntimeRecord | undefined,
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[],
): void {
  const origin = state.pluginOrigins.get(approvalId);
  if (
    origin &&
    origin.runtime === runtime &&
    deliveredTargets.some(
      (target) =>
        target.surface === "origin" &&
        buildChannelApprovalNativeTargetKey(target.target) ===
          buildChannelApprovalNativeTargetKey(origin.target),
    )
  ) {
    origin.originDelivered = true;
    clearPluginTerminalNotice(state, approvalId);
  }
}

export async function publishPluginTerminalForState(
  state: ApprovalNativeRouteCoordinatorState,
  { approvalId, status }: { approvalId: string; status: PluginTerminalStatus },
): Promise<void> {
  if (state.closed) {
    return;
  }
  const selection = state.selections.get(approvalId);
  if (selection) {
    selection.pluginTerminalStatus = status;
  }
  const origin = state.pluginOrigins.get(approvalId);
  if (origin) {
    origin.terminalStatus = status;
  }
  if (status === "allowed" || status === "cancelled") {
    clearPluginTerminalNotice(state, approvalId);
    return;
  }
  const pending = state.pendingNotices.get(approvalId);
  const notice =
    state.pluginTerminalNotices.get(approvalId) ??
    (pending?.approvalKind === "plugin"
      ? getPluginTerminalNotice(state, pending.request)
      : undefined);
  if (!notice || notice.sent) {
    return;
  }
  notice.status = status;
  await maybeSendPluginTerminalNotice(state, approvalId);
}
