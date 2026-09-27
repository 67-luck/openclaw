// Coordinates native approval delivery routing and notices.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelApprovalNativeDeliveryPlan,
  ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import {
  describeApprovalDeliveryDestination,
  resolveAmbiguousApprovalRouteNoticeText,
  resolveApprovalDeliveryFailedNoticeText,
  resolveApprovalRoutedElsewhereNoticeText,
} from "./approval-native-route-notice.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type { ApprovalRequestChannelRouteClass, ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";
import type { SystemAgentApprovalRequest } from "./system-agent-approvals.js";

type GatewayRequestFn = <T = unknown>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;

type ApprovalRouteRuntimeRecord = {
  runtimeId: string;
  handledKinds: ReadonlySet<ChannelApprovalKind>;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  requestGateway: GatewayRequestFn;
  shouldHandle: (request: ApprovalRequest) => boolean;
  classifyRoute: (request: ApprovalRequest) => ApprovalRequestChannelRouteClass;
};

type ApprovalRouteSkipReason = "ambiguous-owner" | "ineligible" | "owner-unavailable";

type ApprovalRouteReport = {
  runtimeId: string;
  request: ApprovalRequest;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  deliveryPlan: ChannelApprovalNativeDeliveryPlan;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  requestGateway: GatewayRequestFn;
  skipReason?: ApprovalRouteSkipReason;
};

type PendingApprovalRouteNotice = {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  reports: Map<string, ApprovalRouteReport>;
  cleanupTimeout: NodeJS.Timeout;
};

type ApprovalRouteSelectionVerdict =
  | { kind: "selected" }
  | { kind: ApprovalRouteSkipReason }
  | { kind: "selector-error"; error: unknown };

type ApprovalRouteSelection = {
  verdicts: Map<string, ApprovalRouteSelectionVerdict>;
  pluginResolvedWithoutNotice?: boolean;
  cleanupTimeout: NodeJS.Timeout;
};

type RouteNoticeTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

type PluginTerminalStatus = "allowed" | "denied" | "expired" | "cancelled";

type PluginTerminalNotice = {
  requestGateway?: GatewayRequestFn;
  target?: RouteNoticeTarget;
  initialNotice?: Promise<void>;
  status?: "denied" | "expired";
  sent: boolean;
  cleanupTimeout: NodeJS.Timeout;
};

type ApprovalNativeRouteCoordinatorState = {
  activeRuntimes: Map<string, ApprovalRouteRuntimeRecord>;
  pendingNotices: Map<string, PendingApprovalRouteNotice>;
  pluginTerminalNotices: Map<string, PluginTerminalNotice>;
  selections: Map<string, ApprovalRouteSelection>;
  runtimeSeq: number;
  closed: boolean;
};

function createApprovalNativeRouteCoordinatorState(): ApprovalNativeRouteCoordinatorState {
  return {
    activeRuntimes: new Map(),
    pendingNotices: new Map(),
    pluginTerminalNotices: new Map(),
    selections: new Map(),
    runtimeSeq: 0,
    closed: false,
  };
}

function clearApprovalRouteSelection(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const selection = state.selections.get(approvalId);
  if (!selection) {
    return;
  }
  state.selections.delete(approvalId);
  clearTimeout(selection.cleanupTimeout);
}

function routeGroupKey(runtime: ApprovalRouteRuntimeRecord): string {
  return normalizeChannel(runtime.channel) || runtime.runtimeId;
}

function createApprovalRouteSelection(
  state: ApprovalNativeRouteCoordinatorState,
  params: { request: ApprovalRequest; approvalKind: ChannelApprovalKind },
): ApprovalRouteSelection {
  const runtimes = Array.from(state.activeRuntimes.values()).filter((runtime) =>
    runtime.handledKinds.has(params.approvalKind),
  );
  const verdicts = new Map<string, ApprovalRouteSelectionVerdict>();
  const groups = new Map<string, ApprovalRouteRuntimeRecord[]>();
  for (const runtime of runtimes) {
    const key = routeGroupKey(runtime);
    groups.set(key, [...(groups.get(key) ?? []), runtime]);
  }

  const selectedRuntimeIds = new Set<string>();
  for (const group of groups.values()) {
    const candidates: ApprovalRouteRuntimeRecord[] = [];
    for (const runtime of group) {
      try {
        if (runtime.shouldHandle(params.request)) {
          candidates.push(runtime);
        }
      } catch (error) {
        verdicts.set(runtime.runtimeId, { kind: "selector-error", error });
      }
    }
    let routeClass: ApprovalRequestChannelRouteClass;
    try {
      routeClass = group[0]?.classifyRoute(params.request) ?? "unbound";
    } catch (error) {
      for (const runtime of group) {
        verdicts.set(runtime.runtimeId, { kind: "selector-error", error });
      }
      continue;
    }
    if (routeClass === "bound-or-explicit") {
      if (candidates.length === 0) {
        for (const runtime of group) {
          if (!verdicts.has(runtime.runtimeId)) {
            verdicts.set(runtime.runtimeId, { kind: "owner-unavailable" });
          }
        }
        continue;
      }
      for (const runtime of candidates) {
        selectedRuntimeIds.add(runtime.runtimeId);
      }
    } else if (routeClass === "unbound" && candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate) {
        selectedRuntimeIds.add(candidate.runtimeId);
      }
    } else if (routeClass === "unbound" && candidates.length > 1) {
      for (const runtime of candidates) {
        verdicts.set(runtime.runtimeId, { kind: "ambiguous-owner" });
      }
    }
  }

  for (const runtime of runtimes) {
    if (selectedRuntimeIds.has(runtime.runtimeId)) {
      verdicts.set(runtime.runtimeId, { kind: "selected" });
    } else if (!verdicts.has(runtime.runtimeId)) {
      verdicts.set(runtime.runtimeId, { kind: "ineligible" });
    }
  }

  const timeoutMs = Math.min(Math.max(0, params.request.expiresAtMs - Date.now()), 0x7fffffff);
  const cleanupTimeout = setTimeout(() => {
    clearApprovalRouteSelection(state, params.request.id);
  }, timeoutMs);
  cleanupTimeout.unref?.();
  const selection: ApprovalRouteSelection = {
    verdicts,
    cleanupTimeout,
  };
  state.selections.set(params.request.id, selection);
  return selection;
}

function resolveApprovalRouteSelection(
  state: ApprovalNativeRouteCoordinatorState,
  params: { request: ApprovalRequest; approvalKind: ChannelApprovalKind },
): ApprovalRouteSelection {
  return state.selections.get(params.request.id) ?? createApprovalRouteSelection(state, params);
}

const defaultCoordinatorState = createApprovalNativeRouteCoordinatorState();
const MAX_APPROVAL_ROUTE_NOTICE_TTL_MS = 5 * 60_000;

function clearPluginTerminalNotice(
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

function getPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  request: ApprovalRequest,
): PluginTerminalNotice {
  const existing = state.pluginTerminalNotices.get(request.id);
  if (existing) {
    return existing;
  }
  // Retain the actual native route until the Gateway's expiry can publish its
  // terminal outcome, even if the channel's local card timer fires first.
  const timeoutMs = Math.min(Math.max(0, request.expiresAtMs - Date.now()) + 60_000, 0x7fffffff);
  const cleanupTimeout = setTimeout(() => clearPluginTerminalNotice(state, request.id), timeoutMs);
  cleanupTimeout.unref?.();
  const entry: PluginTerminalNotice = { sent: false, cleanupTimeout };
  state.pluginTerminalNotices.set(request.id, entry);
  return entry;
}

async function maybeSendPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): Promise<void> {
  const notice = state.pluginTerminalNotices.get(approvalId);
  if (state.closed || !notice?.status || !notice.requestGateway || !notice.target || notice.sent) {
    return;
  }
  notice.sent = true;
  const { target } = notice;
  const requestGateway = notice.requestGateway;
  try {
    await notice.initialNotice;
    if (state.closed || state.pluginTerminalNotices.get(approvalId) !== notice) {
      return;
    }
    await requestGateway("send", {
      channel: target.channel,
      to: target.to,
      accountId: target.accountId ?? undefined,
      threadId: target.threadId ?? undefined,
      message:
        notice.status === "expired"
          ? `Approval ${approvalId} timed out. The requested action did not run.`
          : `Approval ${approvalId} was denied. The requested action did not run.`,
      idempotencyKey: `approval-terminal-notice:${approvalId}`,
    });
  } catch (error) {
    notice.sent = false;
    throw error;
  }
}

function normalizeChannel(value?: string | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function clearPendingApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const entry = state.pendingNotices.get(approvalId);
  if (!entry) {
    return;
  }
  state.pendingNotices.delete(approvalId);
  clearTimeout(entry.cleanupTimeout);
}

function createPendingApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  params: {
    request: ApprovalRequest;
    approvalKind: ChannelApprovalKind;
  },
): PendingApprovalRouteNotice {
  const timeoutMs = Math.min(
    Math.max(0, params.request.expiresAtMs - Date.now()),
    MAX_APPROVAL_ROUTE_NOTICE_TTL_MS,
  );
  const cleanupTimeout = setTimeout(() => {
    void maybeFinalizeApprovalRouteNotice(state, params.request.id, { force: true });
  }, timeoutMs);
  cleanupTimeout.unref?.();
  return {
    request: params.request,
    approvalKind: params.approvalKind,
    reports: new Map(),
    cleanupTimeout,
  };
}

function resolveRouteNoticeTargetFromRequest(request: ApprovalRequest): RouteNoticeTarget | null {
  const channel = request.request.turnSourceChannel?.trim();
  const to = request.request.turnSourceTo?.trim();
  if (!channel || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: request.request.turnSourceAccountId ?? undefined,
    threadId: request.request.turnSourceThreadId ?? undefined,
  };
}

function resolveFallbackRouteNoticeTarget(report: ApprovalRouteReport): RouteNoticeTarget | null {
  const channel = report.channel?.trim();
  const to = report.deliveryPlan.originTarget?.to?.trim();
  if (!channel || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: report.accountId ?? undefined,
    threadId: report.deliveryPlan.originTarget?.threadId ?? undefined,
  };
}

function didReportDeliverToOrigin(report: ApprovalRouteReport, originAccountId?: string): boolean {
  const originTarget = report.deliveryPlan.originTarget;
  if (!originTarget) {
    return false;
  }
  const reportAccountId = normalizeOptionalString(report.accountId);
  if (
    originAccountId !== undefined &&
    reportAccountId !== undefined &&
    reportAccountId !== originAccountId
  ) {
    return false;
  }
  const originKey = buildChannelApprovalNativeTargetKey(originTarget);
  return report.deliveredTargets.some(
    (plannedTarget) => buildChannelApprovalNativeTargetKey(plannedTarget.target) === originKey,
  );
}

function hasPlannedNativeTargets(report: ApprovalRouteReport): boolean {
  return report.deliveryPlan.targets.length > 0;
}

function readAllowedDecisionStrings(request: ApprovalRequest): string[] | undefined {
  const allowedDecisions =
    "allowedDecisions" in request.request ? request.request.allowedDecisions : undefined;
  if (!Array.isArray(allowedDecisions)) {
    return undefined;
  }
  return allowedDecisions.filter((value): value is string => typeof value === "string");
}

function resolveApprovalRouteNotice(params: {
  state: ApprovalNativeRouteCoordinatorState;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
  reports: readonly ApprovalRouteReport[];
  missingSelectedRuntime: boolean;
}): { requestGateway: GatewayRequestFn; target: RouteNoticeTarget; text: string } | null {
  const explicitTarget = resolveRouteNoticeTargetFromRequest(params.request);
  const originChannel = normalizeChannel(
    explicitTarget?.channel ?? params.request.request.turnSourceChannel,
  );
  const fallbackTarget =
    params.reports
      .filter((report) => normalizeChannel(report.channel) === originChannel || !originChannel)
      .map(resolveFallbackRouteNoticeTarget)
      .find((target) => target !== null) ?? null;
  const target = explicitTarget
    ? {
        ...fallbackTarget,
        ...explicitTarget,
        accountId: explicitTarget.accountId ?? fallbackTarget?.accountId,
        threadId: explicitTarget.threadId ?? fallbackTarget?.threadId,
      }
    : fallbackTarget;
  if (!target) {
    return null;
  }
  const originAccountId = normalizeOptionalString(target.accountId);
  const deliveredAnyTarget = params.reports.some((report) => report.deliveredTargets.length > 0);
  const ambiguousOwner = params.reports.some((report) => report.skipReason === "ambiguous-owner");
  const requiresManualFallback =
    ambiguousOwner || params.reports.some((report) => report.skipReason === "owner-unavailable");
  if (
    !deliveredAnyTarget &&
    (params.reports.some(hasPlannedNativeTargets) ||
      requiresManualFallback ||
      params.missingSelectedRuntime)
  ) {
    const requestGateway =
      params.reports.find((report) => params.state.activeRuntimes.has(report.runtimeId))
        ?.requestGateway ??
      params.reports[0]?.requestGateway ??
      Array.from(params.state.activeRuntimes.values())[0]?.requestGateway;
    if (!requestGateway) {
      return null;
    }
    return {
      requestGateway,
      target,
      text: ambiguousOwner
        ? resolveAmbiguousApprovalRouteNoticeText(params.approvalKind)
        : resolveApprovalDeliveryFailedNoticeText({
            approvalId: params.request.id,
            approvalKind: params.approvalKind,
            allowedDecisions: readAllowedDecisionStrings(params.request),
          }),
    };
  }

  // If any same-channel runtime already delivered into the origin chat, every
  // other fallback delivery becomes supplemental and should not trigger a notice.
  const originDelivered = params.reports.some((report) => {
    if (originChannel && normalizeChannel(report.channel) !== originChannel) {
      return false;
    }
    return didReportDeliverToOrigin(report, originAccountId);
  });
  if (originDelivered) {
    return null;
  }

  const destinations = params.reports.flatMap((report) => {
    if (!report.channelLabel || report.deliveredTargets.length === 0) {
      return [];
    }
    const reportChannel = normalizeChannel(report.channel);
    if (
      originChannel &&
      reportChannel === originChannel &&
      !report.deliveryPlan.notifyOriginWhenDmOnly
    ) {
      return [];
    }
    const reportAccountId = normalizeOptionalString(report.accountId);
    if (
      originChannel &&
      reportChannel === originChannel &&
      originAccountId !== undefined &&
      reportAccountId !== undefined &&
      reportAccountId !== originAccountId
    ) {
      return [];
    }
    return [
      describeApprovalDeliveryDestination({
        channelLabel: report.channelLabel,
        deliveredTargets: report.deliveredTargets,
      }),
    ];
  });
  const text = resolveApprovalRoutedElsewhereNoticeText(
    destinations,
    params.approvalKind === "plugin" ? params.request.id : undefined,
  );
  if (!text) {
    return null;
  }

  const requestGateway =
    params.reports.find((report) => params.state.activeRuntimes.has(report.runtimeId))
      ?.requestGateway ?? params.reports[0]?.requestGateway;
  if (!requestGateway) {
    return null;
  }

  return {
    requestGateway,
    target,
    text,
  };
}

function isPluginDmOnlyRoute(params: {
  approvalKind: ChannelApprovalKind;
  reports: readonly ApprovalRouteReport[];
  missingSelectedRuntime: boolean;
  target: RouteNoticeTarget;
}): boolean {
  if (params.approvalKind !== "plugin" || params.missingSelectedRuntime) {
    return false;
  }
  const originChannel = normalizeChannel(params.target.channel);
  const originAccountId = normalizeOptionalString(params.target.accountId);
  const matchingReports = params.reports.filter((report) => {
    if (normalizeChannel(report.channel) !== originChannel) {
      return false;
    }
    const reportAccountId = normalizeOptionalString(report.accountId);
    return (
      originAccountId === undefined ||
      reportAccountId === undefined ||
      originAccountId === reportAccountId
    );
  });
  return (
    !matchingReports.some((report) => didReportDeliverToOrigin(report, originAccountId)) &&
    matchingReports.some(
      (report) =>
        report.deliveryPlan.notifyOriginWhenDmOnly &&
        report.deliveredTargets.some((target) => target.surface === "approver-dm"),
    )
  );
}

/** Returns whether a native approval runtime is active for the requested channel/account scope. */
export function hasActiveApprovalNativeRouteRuntime(params: {
  approvalKind: ChannelApprovalKind;
  channel?: string | null;
  accountId?: string | null;
}): boolean {
  return hasActiveApprovalNativeRouteRuntimeForState(defaultCoordinatorState, params);
}

function hasActiveApprovalNativeRouteRuntimeForState(
  state: ApprovalNativeRouteCoordinatorState,
  params: {
    approvalKind: ChannelApprovalKind;
    channel?: string | null;
    accountId?: string | null;
  },
): boolean {
  const channel = normalizeChannel(params.channel);
  const accountId = normalizeOptionalString(params.accountId);
  const matchingRuntimes = Array.from(state.activeRuntimes.values()).filter((runtime) => {
    if (!runtime.handledKinds.has(params.approvalKind)) {
      return false;
    }
    if (channel && normalizeChannel(runtime.channel) !== channel) {
      return false;
    }
    const runtimeAccountId = normalizeOptionalString(runtime.accountId);
    return (
      accountId === undefined || runtimeAccountId === undefined || runtimeAccountId === accountId
    );
  });
  return accountId === undefined ? matchingRuntimes.length === 1 : matchingRuntimes.length > 0;
}

async function maybeFinalizeApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
  options?: { force?: boolean },
): Promise<void> {
  const entry = state.pendingNotices.get(approvalId);
  if (!entry) {
    return;
  }
  const selection = state.selections.get(approvalId);
  if (!selection) {
    return;
  }
  if (!options?.force) {
    for (const runtimeId of selection.verdicts.keys()) {
      if (!entry.reports.has(runtimeId)) {
        return;
      }
    }
  }
  const missingSelectedRuntime = Array.from(selection.verdicts).some(
    ([runtimeId, verdict]) => verdict.kind === "selected" && !entry.reports.has(runtimeId),
  );
  if (!options?.force && missingSelectedRuntime) {
    return;
  }
  if (selection.pluginResolvedWithoutNotice) {
    clearPendingApprovalRouteNotice(state, approvalId);
    return;
  }

  const reports = Array.from(entry.reports.values());
  const notice = resolveApprovalRouteNotice({
    state,
    approvalKind: entry.approvalKind,
    request: entry.request,
    reports,
    missingSelectedRuntime,
  });
  const terminalNotice =
    notice &&
    isPluginDmOnlyRoute({
      approvalKind: entry.approvalKind,
      reports,
      missingSelectedRuntime,
      target: notice.target,
    })
      ? getPluginTerminalNotice(state, entry.request)
      : undefined;
  if (terminalNotice && notice) {
    terminalNotice.requestGateway = notice.requestGateway;
    terminalNotice.target = notice.target;
  }
  clearPendingApprovalRouteNotice(state, approvalId);
  if (!notice) {
    return;
  }
  const initialNotice = Promise.resolve().then(async () => {
    try {
      await notice.requestGateway("send", {
        channel: notice.target.channel,
        to: notice.target.to,
        accountId: notice.target.accountId ?? undefined,
        threadId: notice.target.threadId ?? undefined,
        message: notice.text,
        idempotencyKey: `approval-route-notice:${approvalId}`,
      });
    } catch {
      // The approval delivery already succeeded; the follow-up notice is best-effort.
    }
  });
  if (terminalNotice) {
    terminalNotice.initialNotice = initialNotice;
  }
  await initialNotice;
  if (terminalNotice) {
    try {
      await maybeSendPluginTerminalNotice(state, approvalId);
    } catch {
      // The card was delivered; a failed origin follow-up cannot undo it.
    }
  }
}

/** Tracks native approval deliveries and sends origin-chat notices after all observed runtimes report. */
export function createApprovalNativeRouteReporter(
  params: Omit<ApprovalRouteRuntimeRecord, "runtimeId">,
) {
  return createApprovalNativeRouteReporterForState(defaultCoordinatorState, params);
}

function createApprovalNativeRouteReporterForState(
  state: ApprovalNativeRouteCoordinatorState,
  params: Omit<ApprovalRouteRuntimeRecord, "runtimeId">,
) {
  const runtimeId = `native-approval-route:${++state.runtimeSeq}`;
  let registered = false;

  const report = async (payload: {
    approvalKind: ChannelApprovalKind;
    request: ApprovalRequest;
    deliveryPlan: ChannelApprovalNativeDeliveryPlan;
    deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
    skipReason?: ApprovalRouteSkipReason;
  }): Promise<void> => {
    if (state.closed || !registered || !params.handledKinds.has(payload.approvalKind)) {
      return;
    }
    const selection = resolveApprovalRouteSelection(state, payload);
    if (!selection.verdicts.has(runtimeId)) {
      return;
    }
    const entry =
      state.pendingNotices.get(payload.request.id) ??
      createPendingApprovalRouteNotice(state, {
        request: payload.request,
        approvalKind: payload.approvalKind,
      });
    entry.reports.set(runtimeId, {
      runtimeId,
      request: payload.request,
      channel: params.channel,
      channelLabel: params.channelLabel,
      accountId: params.accountId,
      deliveryPlan: payload.deliveryPlan,
      deliveredTargets: payload.deliveredTargets,
      requestGateway: params.requestGateway,
      skipReason: payload.skipReason,
    });
    state.pendingNotices.set(payload.request.id, entry);
    await maybeFinalizeApprovalRouteNotice(state, payload.request.id);
  };

  return {
    selectRequest(payload: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
    }): ApprovalRouteSelectionVerdict {
      if (state.closed || !params.handledKinds.has(payload.approvalKind)) {
        return { kind: "ineligible" };
      }
      if (!registered) {
        try {
          return params.shouldHandle(payload.request)
            ? { kind: "selected" }
            : { kind: "ineligible" };
        } catch (error) {
          return { kind: "selector-error", error };
        }
      }
      const selection = resolveApprovalRouteSelection(state, payload);
      const entry =
        state.pendingNotices.get(payload.request.id) ??
        createPendingApprovalRouteNotice(state, {
          request: payload.request,
          approvalKind: payload.approvalKind,
        });
      state.pendingNotices.set(payload.request.id, entry);
      return selection.verdicts.get(runtimeId) ?? { kind: "ineligible" };
    },
    start(): void {
      if (state.closed || registered) {
        return;
      }
      state.activeRuntimes.set(runtimeId, {
        runtimeId,
        handledKinds: params.handledKinds,
        channel: params.channel,
        channelLabel: params.channelLabel,
        accountId: params.accountId,
        requestGateway: params.requestGateway,
        shouldHandle: params.shouldHandle,
        classifyRoute: params.classifyRoute,
      });
      registered = true;
    },
    async reportSkipped(paramsValue: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
      reason: ApprovalRouteSkipReason;
    }): Promise<void> {
      await report({
        approvalKind: paramsValue.approvalKind,
        request: paramsValue.request,
        deliveryPlan: {
          targets: [],
          originTarget: null,
          notifyOriginWhenDmOnly: false,
        },
        deliveredTargets: [],
        skipReason: paramsValue.reason,
      });
    },
    async reportDelivery(paramsLocal: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
      deliveryPlan: ChannelApprovalNativeDeliveryPlan;
      deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
    }): Promise<void> {
      await report(paramsLocal);
    },
    completeRequest(approvalId: string): void {
      // A Gateway terminal can overtake delivery reporting. Keep the selection
      // until its route is known so the durable outcome reaches the origin.
      const terminalNotice = state.pluginTerminalNotices.get(approvalId);
      if (terminalNotice?.status && !terminalNotice.target) {
        return;
      }
      clearApprovalRouteSelection(state, approvalId);
      clearPendingApprovalRouteNotice(state, approvalId);
    },
    async stop(): Promise<void> {
      if (!registered) {
        return;
      }
      for (const entry of Array.from(state.pendingNotices.values())) {
        const selection = state.selections.get(entry.request.id);
        if (selection?.verdicts.has(runtimeId) && !entry.reports.has(runtimeId)) {
          await report({
            request: entry.request,
            approvalKind: entry.approvalKind,
            deliveryPlan: { targets: [], originTarget: null, notifyOriginWhenDmOnly: false },
            deliveredTargets: [],
            skipReason:
              selection.verdicts.get(runtimeId)?.kind === "selected"
                ? "owner-unavailable"
                : "ineligible",
          });
        }
      }
      registered = false;
      state.activeRuntimes.delete(runtimeId);
    },
  };
}

export type ApprovalNativeRouteCoordinator = {
  createReporter: typeof createApprovalNativeRouteReporter;
  hasActiveRuntime: typeof hasActiveApprovalNativeRouteRuntime;
  publishPluginTerminal: (params: {
    approvalId: string;
    status: PluginTerminalStatus;
  }) => Promise<void>;
  close: () => void;
};

/** Reads native route activity from the owning Gateway coordinator, else the process default. */
export function hasActiveNativeApprovalRoute(
  coordinator: ApprovalNativeRouteCoordinator | undefined,
  params: Parameters<typeof hasActiveApprovalNativeRouteRuntime>[0],
): boolean {
  return coordinator?.hasActiveRuntime(params) ?? hasActiveApprovalNativeRouteRuntime(params);
}

/** Creates an instance-local route coordinator so Gateway runtimes cannot share account state. */
export function createApprovalNativeRouteCoordinator(): ApprovalNativeRouteCoordinator {
  const state = createApprovalNativeRouteCoordinatorState();
  return {
    createReporter: (params) => createApprovalNativeRouteReporterForState(state, params),
    hasActiveRuntime: (params) => hasActiveApprovalNativeRouteRuntimeForState(state, params),
    publishPluginTerminal: async ({ approvalId, status }) => {
      if (state.closed) {
        return;
      }
      if (status === "allowed" || status === "cancelled") {
        const selection = state.selections.get(approvalId);
        if (selection) {
          // Delivery can finish after the Gateway resolves the request. Keep the
          // outcome on the route so a late report cannot announce stale pending work.
          selection.pluginResolvedWithoutNotice = true;
        }
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
    },
    close: () => {
      // Closing retires this Gateway-owned coordinator permanently. Delayed channel
      // startup must not repopulate routes belonging to the retired instance.
      state.closed = true;
      for (const approvalId of Array.from(state.pendingNotices.keys())) {
        clearPendingApprovalRouteNotice(state, approvalId);
      }
      for (const approvalId of Array.from(state.selections.keys())) {
        clearApprovalRouteSelection(state, approvalId);
      }
      for (const approvalId of Array.from(state.pluginTerminalNotices.keys())) {
        clearPluginTerminalNotice(state, approvalId);
      }
      state.activeRuntimes.clear();
    },
  };
}
