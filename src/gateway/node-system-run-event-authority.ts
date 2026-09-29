import {
  addTimerTimeoutGraceMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
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

export function shouldSuppressSystemRunCompletion(
  payload: { suppressNotifyOnExit?: boolean; invokeResultSentFirst?: boolean },
  authorization: unknown,
): boolean {
  const invokeResultReceived =
    typeof authorization === "object" &&
    authorization !== null &&
    "invokeResultReceived" in authorization &&
    authorization.invokeResultReceived === true;
  return (
    payload.suppressNotifyOnExit === true &&
    (payload.invokeResultSentFirst !== true || invokeResultReceived)
  );
}
