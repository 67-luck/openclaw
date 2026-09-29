import {
  addTimerTimeoutGraceMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeAccountId } from "../routing/account-id.js";
import { parseSessionDeliveryRoute } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { PendingSystemRunEvent } from "./node-registry.invoke-stream.js";

const AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS = 5 * 60 * 1000;

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

export type SystemRunEventAuthorization = { invokeResultReceived: boolean };

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
    return { invokeResultReceived: authorized.invokeResultReceived };
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
  globallyEnabled: boolean,
  sessionKey: string,
): boolean {
  const invokeResultReceived =
    typeof authorization === "object" &&
    authorization !== null &&
    "invokeResultReceived" in authorization &&
    authorization.invokeResultReceived === true;
  const telegramRouteMismatch = resolveTelegramRouteMismatch(sessionKey, deliveryContext);
  return (
    !globallyEnabled ||
    payload.notifyOnExit === false ||
    telegramRouteMismatch === true ||
    (payload.suppressNotifyOnExit === true &&
      (payload.invokeResultSentFirst !== true ||
        invokeResultReceived ||
        !deliveryContext ||
        telegramRouteMismatch === null))
  );
}

const TELEGRAM_TOPIC_SUFFIX = /^(.*):(direct-topic|topic):(\d+)$/i;
const TELEGRAM_TARGET_THREAD_SUFFIX = /^(.*):(direct-topic|topic|thread):(\d+)$/i;

function resolveTelegramRouteMismatch(
  sessionKey: string,
  deliveryContext: DeliveryContext | undefined,
): boolean | null {
  const origin = parseSessionDeliveryRoute(sessionKey);
  if (origin?.channel !== "telegram") {
    return null;
  }
  const originTopic = TELEGRAM_TOPIC_SUFFIX.exec(origin.peerId);
  const originThread = origin.threadId ?? originTopic?.[3];
  if (origin.threadId && originTopic?.[3] && origin.threadId !== originTopic[3]) {
    return true;
  }
  const originChat = originTopic?.[1] ?? origin.peerId;
  const originScope =
    originTopic?.[2]?.toLowerCase() === "direct-topic" ? "direct-topic" : "thread";
  if (!deliveryContext) {
    return null;
  }
  if (deliveryContext.channel?.trim().toLowerCase() !== "telegram") {
    return true;
  }
  if (
    origin.accountId &&
    normalizeAccountId(deliveryContext.accountId) !== normalizeAccountId(origin.accountId)
  ) {
    return true;
  }
  const rawTarget = deliveryContext.to?.trim().replace(/^telegram:/i, "");
  if (!rawTarget) {
    return true;
  }
  const targetThreadSuffix = TELEGRAM_TARGET_THREAD_SUFFIX.exec(rawTarget);
  const targetChat = targetThreadSuffix?.[1] ?? rawTarget;
  const explicitThread = String(deliveryContext.threadId ?? "").trim();
  if (explicitThread && targetThreadSuffix?.[3] && explicitThread !== targetThreadSuffix[3]) {
    return true;
  }
  const targetThread = explicitThread || targetThreadSuffix?.[3];
  const targetScope = targetThreadSuffix?.[2]
    ? targetThreadSuffix[2].toLowerCase() === "direct-topic"
      ? "direct-topic"
      : "thread"
    : originScope;
  if (originScope === "direct-topic" && targetThreadSuffix?.[2]?.toLowerCase() !== "direct-topic") {
    return true;
  }
  if (!originThread) {
    return targetChat !== originChat || Boolean(targetThread);
  }
  return targetChat !== originChat || targetThread !== originThread || targetScope !== originScope;
}
