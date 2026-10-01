import {
  addTimerTimeoutGraceMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveSessionConversation,
  serializeSessionConversationTarget,
} from "../channels/plugins/session-conversation.js";
import {
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
} from "../infra/outbound/channel-target-prefix.js";
import { DEFAULT_ACCOUNT_ID, normalizeOptionalAccountId } from "../routing/account-id.js";
import { parseSessionDeliveryRoute } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { PendingSystemRunEvent } from "./node-registry.invoke-stream.js";

const AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS = 5 * 60 * 1000;
const TELEGRAM_ROUTE_MISMATCH_WARNING =
  "node exec completion withheld: saved Telegram route does not match the invoking session";

type AuthorizedSystemRunEvent = PendingSystemRunEvent & {
  nodeId: string;
  connId: string;
  expiresAtMs: number | null;
  invokeResultReceived: boolean;
};

type SystemRunEventIdentity = Omit<
  AuthorizedSystemRunEvent,
  "expiresAtMs" | "invokeResultReceived"
>;

export type SystemRunEventAuthorization = {
  invokeResultReceived: boolean;
  /** The session actually dispatched by the invocation owner, never the terminal payload. */
  invocationSessionKey?: string;
  event?: "exec.started" | "exec.finished" | "exec.denied";
  turnSourceAccountId?: string;
  onTelegramRouteMismatch?: (message: string) => void;
};

export class NodeSystemRunEventAuthority {
  private events = new Map<string, AuthorizedSystemRunEvent>();

  remember(event: SystemRunEventIdentity): void {
    this.prune();
    this.events.set(this.key(event), {
      ...event,
      expiresAtMs: this.expiresAt(event.timeoutMs),
      invokeResultReceived: false,
    });
  }

  forget(event: SystemRunEventIdentity): void {
    this.events.delete(this.key(event));
  }

  clearConnection(connId: string): void {
    for (const [key, event] of this.events) {
      if (event.connId === connId) {
        this.events.delete(key);
      }
    }
  }

  markInvokeResultReceived(event: SystemRunEventIdentity): void {
    const authorized = this.events.get(this.key(event));
    if (authorized) {
      authorized.invokeResultReceived = true;
    }
  }

  // Match the exact session key dispatched in system.run; canonical keys are routing-only.
  authorize(params: {
    nodeId: string;
    connId?: string;
    runId?: string;
    sessionKey: string;
    terminal: boolean;
    allowLegacyRunIdFallback: boolean;
  }): SystemRunEventAuthorization | null {
    if (!params.connId || !params.sessionKey) {
      return null;
    }
    this.prune();
    let match = params.runId
      ? this.match({
          nodeId: params.nodeId,
          connId: params.connId,
          runId: params.runId,
          sessionKey: params.sessionKey,
        })
      : null;
    if (match === null && params.allowLegacyRunIdFallback) {
      match = this.match({
        nodeId: params.nodeId,
        connId: params.connId,
        sessionKey: params.sessionKey,
      });
    }
    if (match === null) {
      return null;
    }
    const authorized = this.events.get(match);
    if (!authorized) {
      return null;
    }
    if (params.terminal) {
      this.events.delete(match);
    }
    return {
      invokeResultReceived: authorized.invokeResultReceived,
      ...(authorized.sessionKey ? { invocationSessionKey: authorized.sessionKey } : {}),
      ...(authorized.turnSourceAccountId
        ? { turnSourceAccountId: authorized.turnSourceAccountId }
        : {}),
    };
  }

  private expiresAt(timeoutMs: number | null | undefined): number | null {
    if (typeof timeoutMs !== "number") {
      return null;
    }
    const durationMs = addTimerTimeoutGraceMs(timeoutMs, AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS);
    return resolveExpiresAtMsFromDurationMs(durationMs) ?? 0;
  }

  private match(params: {
    nodeId: string;
    connId: string;
    runId?: string;
    sessionKey: string;
  }): string | null {
    let match: string | null = null;
    for (const [key, event] of this.events) {
      if (
        event.nodeId !== params.nodeId ||
        event.connId !== params.connId ||
        (params.runId !== undefined && event.runId !== params.runId) ||
        (event.sessionKey && event.sessionKey !== params.sessionKey)
      ) {
        continue;
      }
      if (params.runId !== undefined) {
        return key;
      }
      if (match !== null) {
        return null;
      }
      match = key;
    }
    return match;
  }

  private prune(now = Date.now()): void {
    for (const [key, event] of this.events) {
      if (
        event.expiresAtMs !== null &&
        !isFutureDateTimestampMs(event.expiresAtMs, { nowMs: now })
      ) {
        this.events.delete(key);
      }
    }
  }

  private key(params: {
    nodeId: string;
    connId: string;
    runId: string;
    sessionKey?: string;
  }): string {
    return `${params.nodeId}\0${params.connId}\0${params.sessionKey ?? ""}\0${params.runId}`;
  }
}

export function shouldSuppressRun(
  payload: {
    suppressNotifyOnExit?: boolean;
    notifyOnExit?: boolean;
    invokeResultSentFirst?: boolean;
  },
  authorization: unknown,
  deliveryContext: DeliveryContext | undefined,
  globallyEnabled: boolean | undefined,
): boolean {
  const eventAuthorization = asOptionalRecord(authorization);
  const invokeResultReceived = eventAuthorization?.invokeResultReceived === true;
  const turnSourceAccountId =
    typeof eventAuthorization?.turnSourceAccountId === "string"
      ? eventAuthorization.turnSourceAccountId
      : undefined;
  const invocationSessionKey =
    typeof eventAuthorization?.invocationSessionKey === "string"
      ? eventAuthorization.invocationSessionKey
      : undefined;
  const telegramRouteMismatch = invocationSessionKey
    ? resolveTelegramRouteMismatch(invocationSessionKey, deliveryContext, {
        turnSourceAccountId,
        requireAccount:
          payload.suppressNotifyOnExit === true && payload.invokeResultSentFirst === true,
      })
    : null;
  if (globallyEnabled === false || payload.notifyOnExit === false) {
    return true;
  }
  if (telegramRouteMismatch === true) {
    if (
      !invokeResultReceived &&
      eventAuthorization?.event === "exec.finished" &&
      typeof eventAuthorization.onTelegramRouteMismatch === "function"
    ) {
      eventAuthorization.onTelegramRouteMismatch(TELEGRAM_ROUTE_MISMATCH_WARNING);
    }
    return true;
  }
  return (
    payload.suppressNotifyOnExit === true &&
    (payload.invokeResultSentFirst !== true ||
      invokeResultReceived ||
      !deliveryContext ||
      telegramRouteMismatch === null)
  );
}

const TELEGRAM_TOPIC_SUFFIX = /^(.*):(direct-topic|topic):(\d+)$/i;

function resolveTelegramRouteMismatch(
  sessionKey: string,
  deliveryContext: DeliveryContext | undefined,
  options: { turnSourceAccountId?: string; requireAccount: boolean },
): boolean | null {
  const origin = parseSessionDeliveryRoute(sessionKey);
  if (origin?.channel !== "telegram") {
    return null;
  }
  const originTopic = TELEGRAM_TOPIC_SUFFIX.exec(origin.peerId);
  const originChat = originTopic?.[1] ?? origin.peerId;
  const canonicalThread = origin.threadId
    ? resolveSessionConversation({ channel: "telegram", kind: "group", rawId: origin.threadId })
    : null;
  if (canonicalThread?.threadId && canonicalThread.id !== originChat) {
    return true;
  }
  const scopedThread = canonicalThread?.threadId;
  const scopedDirect = scopedThread?.startsWith("direct-topic:") ?? false;
  const nativeOriginThread = scopedDirect
    ? scopedThread?.slice("direct-topic:".length)
    : scopedThread;
  const originThread = nativeOriginThread ?? origin.threadId ?? originTopic?.[3];
  if (origin.threadId && originTopic?.[3] && originThread !== originTopic[3]) {
    return true;
  }
  const originScope =
    originTopic?.[2]?.toLowerCase() === "direct-topic" || scopedDirect ? "direct-topic" : "thread";
  if (
    originTopic &&
    scopedThread &&
    scopedDirect !== (originTopic[2]?.toLowerCase() === "direct-topic")
  ) {
    return true;
  }
  if (!deliveryContext) {
    return null;
  }
  if (deliveryContext.channel?.trim().toLowerCase() !== "telegram") {
    return true;
  }
  const invocationAccountId = options.turnSourceAccountId
    ? normalizeOptionalAccountId(options.turnSourceAccountId)
    : undefined;
  if (options.turnSourceAccountId && !invocationAccountId) {
    return true;
  }
  const sessionAccountId = origin.accountId
    ? normalizeOptionalAccountId(origin.accountId)
    : undefined;
  if (origin.accountId && !sessionAccountId) {
    return true;
  }
  if (invocationAccountId && sessionAccountId && invocationAccountId !== sessionAccountId) {
    return true;
  }
  if (options.requireAccount && !invocationAccountId && !sessionAccountId) {
    return null;
  }
  const expectedAccountId = invocationAccountId ?? sessionAccountId;
  if (expectedAccountId) {
    const rawTargetAccountId = deliveryContext.accountId?.trim();
    const targetAccountId = rawTargetAccountId
      ? normalizeOptionalAccountId(rawTargetAccountId)
      : DEFAULT_ACCOUNT_ID;
    if (!targetAccountId || targetAccountId !== expectedAccountId) {
      return true;
    }
  }
  const rawTarget = deliveryContext.to
    ? stripOutboundTargetKindPrefix(stripTargetProviderPrefix(deliveryContext.to, "telegram", "tg"))
    : undefined;
  if (!rawTarget) {
    return true;
  }
  const targetConversation = resolveSessionConversation({
    channel: "telegram",
    kind: "group",
    rawId: rawTarget,
  });
  const parsedThread = targetConversation?.threadId;
  const isDirectTopic = parsedThread?.startsWith("direct-topic:") ?? false;
  const embeddedThread = isDirectTopic ? parsedThread?.slice("direct-topic:".length) : parsedThread;
  const targetChat = targetConversation?.id ?? rawTarget;
  const rawExplicitThread = String(deliveryContext.threadId ?? "").trim();
  const scopedExplicitThread = rawExplicitThread
    ? resolveSessionConversation({ channel: "telegram", kind: "group", rawId: rawExplicitThread })
    : null;
  if (scopedExplicitThread?.threadId && scopedExplicitThread.id !== targetChat) {
    return true;
  }
  const explicitDirect = scopedExplicitThread?.threadId?.startsWith("direct-topic:") ?? false;
  const explicitThread = scopedExplicitThread?.threadId
    ? explicitDirect
      ? scopedExplicitThread.threadId.slice("direct-topic:".length)
      : scopedExplicitThread.threadId
    : rawExplicitThread;
  if (scopedExplicitThread?.threadId && parsedThread && explicitDirect !== isDirectTopic) {
    return true;
  }
  if (explicitThread && embeddedThread && explicitThread !== embeddedThread) {
    return true;
  }
  const targetThread = explicitThread || embeddedThread;
  const targetScope = parsedThread
    ? isDirectTopic
      ? "direct-topic"
      : "thread"
    : scopedExplicitThread?.threadId
      ? explicitDirect
        ? "direct-topic"
        : "thread"
      : originScope;
  if (originScope === "direct-topic" && !isDirectTopic && !explicitDirect) {
    return true;
  }
  if (!originThread) {
    return targetChat !== originChat || Boolean(targetThread);
  }
  return targetChat !== originChat || targetThread !== originThread || targetScope !== originScope;
}

/** Undefined retains legacy notice routing; null rejects a verified route that cannot be normalized. */
export function resolveNodeSystemRunEventDeliveryContext(
  deliveryContext: DeliveryContext | undefined,
  authorization: unknown,
): DeliveryContext | null | undefined {
  const eventAuthorization = asOptionalRecord(authorization);
  const sessionKey =
    typeof eventAuthorization?.invocationSessionKey === "string"
      ? eventAuthorization.invocationSessionKey
      : undefined;
  if (!sessionKey) {
    return undefined;
  }
  const origin = parseSessionDeliveryRoute(sessionKey);
  const turnSourceAccountId =
    typeof eventAuthorization?.turnSourceAccountId === "string"
      ? eventAuthorization.turnSourceAccountId
      : undefined;
  // Other transports/shared bindings have no complete invocation-route verifier
  // here. Keep their ordinary route-less notice instead of promoting later history.
  if (
    !deliveryContext ||
    origin?.channel !== "telegram" ||
    !(turnSourceAccountId || origin.accountId)
  ) {
    return undefined;
  }
  if (
    resolveTelegramRouteMismatch(sessionKey, deliveryContext, {
      turnSourceAccountId,
      requireAccount: false,
    }) !== false
  ) {
    return undefined;
  }
  const verifiedContext: DeliveryContext = {
    ...deliveryContext,
    accountId:
      normalizeOptionalAccountId(turnSourceAccountId) ??
      normalizeOptionalAccountId(origin.accountId),
  };
  const explicitConversation =
    deliveryContext.threadId == null
      ? null
      : resolveSessionConversation({
          channel: "telegram",
          kind: "group",
          rawId: String(deliveryContext.threadId),
        });
  const targetConversation = deliveryContext.to
    ? resolveSessionConversation({
        channel: "telegram",
        kind: "group",
        rawId: stripOutboundTargetKindPrefix(
          stripTargetProviderPrefix(deliveryContext.to, "telegram", "tg"),
        ),
      })
    : null;
  const scopedConversation = explicitConversation?.threadId
    ? explicitConversation
    : targetConversation;
  if (scopedConversation?.threadId) {
    const canonicalTarget = serializeSessionConversationTarget({
      channel: "telegram",
      kind: "group",
      id: scopedConversation.id,
      threadId: scopedConversation.threadId,
    });
    if (!canonicalTarget) {
      if (
        eventAuthorization?.event === "exec.finished" &&
        typeof eventAuthorization.onTelegramRouteMismatch === "function"
      ) {
        eventAuthorization.onTelegramRouteMismatch(
          "node exec completion withheld: Telegram route normalization is unavailable; check the active channel plugin",
        );
      }
      return null;
    }
    verifiedContext.to = canonicalTarget;
    if (explicitConversation?.threadId) {
      verifiedContext.threadId = explicitConversation.threadId.startsWith("direct-topic:")
        ? explicitConversation.threadId.slice("direct-topic:".length)
        : explicitConversation.threadId;
    }
  }
  return verifiedContext;
}
