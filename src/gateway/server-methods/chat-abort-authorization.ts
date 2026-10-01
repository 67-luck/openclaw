import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Authorization and pending-run state transitions for chat cancellation.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listRpcSourcesForSession,
  isRpcSourceQueued,
  type RpcSourceRef,
  type RpcSourceAdapter,
} from "../../sessions/session-controller.rpc-sources.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { chatRunBelongsToAgent, resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { createChatAbortMarker } from "../server-chat-state.js";
import { pendingChatSendDedupeKey, PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "./types.js";

export type ChatAbortRequester = {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
  /** Host-only tool authority for the exact session admitted by the router. */
  sessionAuthority?: {
    target: NonNullable<SessionMutationAuthorization["admittedTarget"]>;
    assertCurrent: () => void;
  };
};

type PreRegisteredAgentDedupePayload = {
  goalFingerprint?: unknown;
  agentId?: unknown;
  attemptId?: unknown;
  controlUiVisible?: unknown;
  dedupeKeys?: unknown;
  expiresAtMs?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
  sessionKeyAliases?: unknown;
  status?: unknown;
  turnKind?: unknown;
};

type PreRegisteredAgentRun = {
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
};

export function buildAbortedChatSendPayload(params: {
  runId: string;
  endedAt: number;
  stopReason?: string;
}) {
  return {
    runId: params.runId,
    status: "timeout" as const,
    summary: "aborted",
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    endedAt: params.endedAt,
  };
}

export function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
  authorization?: SessionMutationAuthorization,
): ChatAbortRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const caller = client?.internal?.syntheticClient ? client.internal.agentToolCaller : undefined;
  const assertCallerCurrent = caller?.assertCurrent;
  const sessionTarget = authorization?.admittedTarget;
  const assertCurrent =
    assertCallerCurrent && authorization && sessionTarget
      ? () => {
          assertCallerCurrent();
          authorization.assertCurrent();
        }
      : undefined;
  assertCurrent?.();
  return {
    connId: normalizeOptionalString(client?.connId),
    deviceId: normalizeOptionalString(client?.connect?.device?.id),
    isAdmin: scopes.includes(ADMIN_SCOPE),
    ...(assertCurrent && sessionTarget
      ? { sessionAuthority: { target: sessionTarget, assertCurrent } }
      : {}),
  };
}

export function canRequesterAbortChatRun(
  entry: Pick<RpcSourceAdapter, "ownerDeviceId" | "ownerConnId"> &
    Partial<Pick<RpcSourceAdapter, "agentId" | "sessionKey" | "sessionId">>,
  requester: ChatAbortRequester,
  options: { requireOwnerMatch?: boolean } = {},
): boolean {
  if (requester.sessionAuthority) {
    requester.sessionAuthority.assertCurrent();
    const { target } = requester.sessionAuthority;
    return (
      entry.sessionKey === target.sessionKey &&
      entry.sessionId === target.sessionId &&
      resolveChatRunOwnerAgentId(entry) === target.agentId
    );
  }
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalString(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalString(entry.ownerConnId);
  return Boolean(
    (!options.requireOwnerMatch && !ownerDeviceId && !ownerConnId) ||
    (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) ||
    (ownerConnId && requester.connId && ownerConnId === requester.connId),
  );
}

export function readPreRegisteredAgentDedupePayloadForSession(params: {
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
  runId: string;
  sessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
  includeHidden?: boolean;
  requiredSessionId?: string;
}): PreRegisteredAgentDedupePayload | undefined {
  if (!params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (!params.includeHidden && payload.controlUiVisible === false) {
    return undefined;
  }
  const payloadRunId = typeof payload.runId === "string" ? payload.runId : undefined;
  if (payloadRunId && payloadRunId !== params.runId) {
    return undefined;
  }
  const payloadSessionKeys = new Set([
    normalizeOptionalString(payload.sessionKey),
    ...(Array.isArray(payload.sessionKeyAliases)
      ? payload.sessionKeyAliases.map(normalizeOptionalString)
      : []),
  ]);
  const hasPayloadSessionKey = [...payloadSessionKeys].some(Boolean);
  if (
    params.requiredSessionId !== undefined &&
    (!payloadSessionKeys.has(params.sessionKey) ||
      normalizeOptionalString(payload.sessionId) !== params.requiredSessionId)
  ) {
    return undefined;
  }
  if (
    (hasPayloadSessionKey && !payloadSessionKeys.has(params.sessionKey)) ||
    (!hasPayloadSessionKey && payloadRunId !== params.runId)
  ) {
    return undefined;
  }
  const agentId = normalizeOptionalString(params.agentId)?.toLowerCase();
  if (agentId) {
    const sessionAgentId = resolveChatRunOwnerAgentId({
      agentId: normalizeOptionalString(payload.agentId),
      sessionKey: params.sessionKey,
      defaultAgentId: params.defaultAgentId,
    });
    if (sessionAgentId !== agentId) {
      return undefined;
    }
  }
  return payload;
}

export function readPreRegisteredRun(params: {
  key: string;
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
  keyPrefix: string;
  includeHidden?: boolean;
}): PreRegisteredAgentRun | undefined {
  if (!params.key.startsWith(params.keyPrefix) || !params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (!params.includeHidden && payload.controlUiVisible === false) {
    return undefined;
  }
  const runId =
    (typeof payload.runId === "string" ? payload.runId : undefined) ??
    params.key.slice(params.keyPrefix.length);
  const sessionKey = normalizeOptionalString(payload.sessionKey);
  if (!runId || !sessionKey) {
    return undefined;
  }
  return { runId, sessionKey, payload };
}

export function canRequesterAbortPreRegisteredRun(
  payload: PreRegisteredAgentDedupePayload,
  requester: ChatAbortRequester,
): boolean {
  return canRequesterAbortChatRun(
    {
      ownerConnId: normalizeOptionalString(payload.ownerConnId),
      ownerDeviceId: normalizeOptionalString(payload.ownerDeviceId),
      agentId: normalizeOptionalString(payload.agentId),
      sessionKey: normalizeOptionalString(payload.sessionKey),
      sessionId: normalizeOptionalString(payload.sessionId),
    },
    requester,
  );
}

function resolvePreRegisteredAgentDedupeKeys(
  payload: PreRegisteredAgentDedupePayload,
  runId: string,
): string[] {
  const keys = [`agent:${runId}`];
  const payloadKeys = Array.isArray(payload.dedupeKeys) ? payload.dedupeKeys : [];
  for (const key of payloadKeys) {
    const normalized = normalizeOptionalString(key);
    if (normalized?.startsWith("agent:")) {
      keys.push(normalized);
    }
  }
  return uniqueStrings(keys);
}

export function writePreRegisteredAgentAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  sessionKey?: string;
  payload: PreRegisteredAgentDedupePayload;
  stopReason: string;
  endedAt?: number;
  expectedPayload?: PreRegisteredAgentDedupePayload;
}) {
  if (
    params.expectedPayload &&
    params.context.dedupe.get(`agent:${params.runId}`)?.payload !== params.expectedPayload
  ) {
    return false;
  }
  const endedAt = params.endedAt ?? Date.now();
  const payloadAgentId = normalizeOptionalString(params.payload.agentId);
  for (const key of resolvePreRegisteredAgentDedupeKeys(params.payload, params.runId)) {
    if (
      params.expectedPayload &&
      params.context.dedupe.get(key)?.payload !== params.expectedPayload
    ) {
      continue;
    }
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key,
      entry: {
        ts: endedAt,
        ok: true,
        payload: {
          runId: params.runId,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
          ...(params.payload.controlUiVisible === false ? { controlUiVisible: false } : {}),
          status: "timeout" as const,
          summary: "aborted",
          stopReason: params.stopReason,
          endedAt,
        },
      },
    });
  }
  return true;
}

export function writePreRegisteredChatAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  stopReason: string;
  endedAt?: number;
  attemptId?: string;
  expectedPayload?: PreRegisteredAgentDedupePayload;
}) {
  if (
    params.expectedPayload &&
    params.context.dedupe.get(pendingChatSendDedupeKey(params.runId))?.payload !==
      params.expectedPayload
  ) {
    return false;
  }
  const endedAt = params.endedAt ?? Date.now();
  const payload = buildAbortedChatSendPayload({
    runId: params.runId,
    stopReason: params.stopReason,
    endedAt,
  });
  params.context.chatRunState.getOrCreate(params.runId).abortMarker =
    createChatAbortMarker(endedAt);
  const pendingKey = pendingChatSendDedupeKey(params.runId);
  const pendingEntry = params.context.dedupe.get(pendingKey);
  const pendingAttemptId = normalizeOptionalString(
    (pendingEntry?.payload as PreRegisteredAgentDedupePayload | undefined)?.attemptId,
  );
  const ownsPendingAttempt = !params.attemptId || pendingAttemptId === params.attemptId;
  if (ownsPendingAttempt) {
    params.context.dedupe.delete(pendingKey);
  }
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    entry: {
      ts: endedAt,
      ok: true,
      payload,
      ...(ownsPendingAttempt && pendingEntry?.requestIdentity
        ? { requestIdentity: pendingEntry.requestIdentity }
        : {}),
    },
  });
  return true;
}

function createChatAbortRunSelection<T extends { runId: string }>() {
  const authorizedByRunId = new Map<string, T>();
  const matchedRunIds = new Set<string>();
  const authorization = {
    hasUnauthorizedRuns: false,
    hasUnauthorizedProtectedRuns: false,
    hasProtectedRuns: false,
  };
  return {
    add(run: T, requesterCanAbort: boolean, isProtected: boolean | undefined) {
      matchedRunIds.add(run.runId);
      if (isProtected) {
        // Lifecycle cleanup still checks ownership of hidden and preserved work.
        authorization.hasProtectedRuns = true;
        authorization.hasUnauthorizedProtectedRuns ||= !requesterCanAbort;
      } else if (requesterCanAbort) {
        authorizedByRunId.set(run.runId, run);
      } else {
        authorization.hasUnauthorizedRuns = true;
      }
    },
    result: () => ({
      authorizedRuns: [...authorizedByRunId.values()],
      matchedRunIds: [...matchedRunIds],
      ...authorization,
    }),
  };
}

export function resolveAuthorizedPreRegisteredRunsForSessionKeys(params: {
  context: GatewayRequestContext;
  sessionKeys: Iterable<string>;
  agentId?: string;
  requiredSessionId?: string;
  defaultAgentId?: string;
  requester: ChatAbortRequester;
  keyPrefix: string;
  preserveSideRuns?: boolean;
  includeProtectedRuns?: boolean;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalString(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const selection = createChatAbortRunSelection<PreRegisteredAgentRun>();
  for (const [key, entry] of params.context.dedupe) {
    const run = readPreRegisteredRun({
      key,
      entry,
      keyPrefix: params.keyPrefix,
      includeHidden: true,
    });
    if (!run) {
      continue;
    }
    if (
      params.requiredSessionId !== undefined &&
      normalizeOptionalString(run.payload.sessionId) !== params.requiredSessionId
    ) {
      continue;
    }
    const runSessionKeys = [
      run.sessionKey,
      ...(Array.isArray(run.payload.sessionKeyAliases)
        ? run.payload.sessionKeyAliases.map(normalizeOptionalString)
        : []),
    ];
    if (!runSessionKeys.some((sessionKey) => Boolean(sessionKey && sessionKeys.has(sessionKey)))) {
      continue;
    }
    if (params.context.rpcSources.has(run.runId)) {
      continue;
    }
    const agentId = normalizeOptionalString(params.agentId)?.toLowerCase();
    if (
      agentId &&
      !chatRunBelongsToAgent(
        {
          agentId: normalizeOptionalString(run.payload.agentId),
          sessionKey: run.sessionKey,
          defaultAgentId: params.defaultAgentId,
        },
        agentId,
      )
    ) {
      continue;
    }
    const requesterCanAbort = canRequesterAbortPreRegisteredRun(run.payload, params.requester);
    const isProtected =
      params.includeProtectedRuns !== true &&
      (run.payload.controlUiVisible === false ||
        (params.preserveSideRuns && normalizeOptionalString(run.payload.turnKind) === "btw"));
    selection.add(run, requesterCanAbort, isProtected);
  }
  return selection.result();
}

export function resolveAuthorizedRunsForSessionKeys(params: {
  rpcSources: Map<string, RpcSourceRef>;
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  requiredSessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
  includeProtectedRuns?: boolean;
}) {
  const selection = createChatAbortRunSelection<{
    runId: string;
    sessionKey: string;
    sessionId: string;
    agentId?: string;
    entry: RpcSourceRef;
  }>();
  for (const { runId, entry } of listRpcSourcesForSession(params)) {
    if (isRpcSourceQueued(entry)) {
      continue;
    }
    const adapter = entry.adapter;
    const requesterCanAbort = canRequesterAbortChatRun(adapter, params.requester);
    const isProtected =
      params.includeProtectedRuns !== true &&
      (adapter.controlUiVisible === false ||
        (params.preserveSideRuns && adapter.turnKind === "btw"));
    selection.add(
      {
        runId,
        sessionKey: adapter.sessionKey,
        sessionId: adapter.sessionId,
        agentId: adapter.agentId,
        entry,
      },
      requesterCanAbort,
      isProtected,
    );
  }
  return selection.result();
}

const SESSION_LIFECYCLE_ABORT_REQUESTER: ChatAbortRequester = { isAdmin: true };

export function resolveAuthorizedQueuedTurnsForSession(params: {
  context: GatewayRequestContext;
  sessionKeys: string[];
  sessionId?: string;
  requiredSessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
  includeProtectedRuns?: boolean;
}) {
  const matches = listRpcSourcesForSession({
    rpcSources: params.context.rpcSources,
    queuedOnly: true,
    sessionKeys: params.sessionKeys,
    sessionIds: [params.sessionId],
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
  });
  const selection = createChatAbortRunSelection<{
    runId: string;
    entry: RpcSourceRef;
    sessionKey: string;
    sessionId: string;
    agentId?: string;
  }>();
  for (const { runId, entry } of matches) {
    const adapter = entry.adapter;
    selection.add(
      {
        runId,
        entry,
        sessionKey: adapter.sessionKey,
        sessionId: adapter.sessionId,
        agentId: adapter.agentId,
      },
      canRequesterAbortChatRun(adapter, params.requester),
      params.includeProtectedRuns !== true &&
        (adapter.controlUiVisible === false ||
          (params.preserveSideRuns && adapter.turnKind === "btw")),
    );
  }
  const { authorizedRuns, ...result } = selection.result();
  return { authorized: authorizedRuns, ...result };
}

type SessionAbortOwnerParams = {
  context: GatewayRequestContext;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
};

/** Authoritative active, pending, or queued Gateway owner for an exact session. */
export function hasGatewaySessionAbortOwner(params: SessionAbortOwnerParams): boolean {
  const ownerScope = {
    sessionKeys: params.sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: SESSION_LIFECYCLE_ABORT_REQUESTER,
  };
  return (
    resolveAuthorizedRunsForSessionKeys({
      rpcSources: params.context.rpcSources,
      sessionIds: [params.sessionId],
      ...ownerScope,
      includeProtectedRuns: true,
    }).authorizedRuns.length > 0 ||
    resolveAuthorizedQueuedTurnsForSession({
      context: params.context,
      sessionId: params.sessionId,
      includeProtectedRuns: true,
      ...ownerScope,
    }).authorized.length > 0 ||
    ["agent:", PENDING_CHAT_SEND_DEDUPE_PREFIX].some(
      (keyPrefix) =>
        resolveAuthorizedPreRegisteredRunsForSessionKeys({
          context: params.context,
          ...ownerScope,
          keyPrefix,
          includeProtectedRuns: true,
        }).authorizedRuns.length > 0,
    )
  );
}
