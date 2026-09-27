// Coordinates native approval delivery routing and notices.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelApprovalNativeDeliveryPlan,
  ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import {
  isPluginDmOnlyRoute,
  normalizeChannel,
  resolveApprovalRouteNotice,
  type ApprovalRouteReport,
  type ApprovalRouteSkipReason,
  type GatewayRequestFn,
  type RouteNoticeTarget,
} from "./approval-native-route-notice.js";
import type {
  ApprovalRequestChannelRouteClass,
  ApprovalRequestInput as ApprovalRequest,
  ChannelApprovalKind,
} from "./approval-types.js";

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
    activeRuntimes: state.activeRuntimes,
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
      // Resolution can overtake this queued send; a retired route must not announce pending work.
      if (
        state.closed ||
        state.selections.get(approvalId) !== selection ||
        selection.pluginResolvedWithoutNotice
      ) {
        return;
      }
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
