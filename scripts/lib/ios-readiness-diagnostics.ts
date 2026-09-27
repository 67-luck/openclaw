// Temporary release investigation. Remove with the ios.readiness Swift call sites.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_EVENTS = 128;
const STAGES: Record<string, readonly string[]> = {
  send: ["begin", "captured", "validated", "ready", "optimistic", "end"],
  health: ["begin", "end"],
  route: ["replace", "detach"],
  bootstrap: [
    "operator-connected",
    "agents-begin",
    "agents-end",
    "node-connected",
    "auth-begin",
    "auth-end",
    "ui-connected",
    "node-connect-begin",
    "node-disconnected",
    "node-error",
    "operator-connect-begin",
    "operator-disconnected",
    "operator-error",
  ],
};
const BOOLEAN_FIELDS = [
  "health",
  "current",
  "submitting",
  "sending",
  "sameOwner",
  "draftTransferred",
  "pinned",
  "pairingApproval",
  "pauseReconnect",
];
const NUMBER_FIELDS = ["pending", "inputLength", "elapsedMs"];
const OUTCOMES = ["ok", "false", "error", "cancelled", "unknown"];
const IGNORED_REASONS = new Set([
  "model-auth",
  "sending",
  "attachment-staging",
  "pending",
  "empty",
]);
const CONNECTION_PROBLEMS = [
  "gatewayAuthTokenMissing",
  "gatewayAuthTokenMismatch",
  "gatewayAuthTokenNotConfigured",
  "gatewayAuthPasswordMissing",
  "gatewayAuthPasswordMismatch",
  "gatewayAuthPasswordNotConfigured",
  "bootstrapTokenInvalid",
  "deviceTokenMismatch",
  "deviceTokenScopeMismatch",
  "pairingRequired",
  "pairingRoleUpgradeRequired",
  "pairingScopeUpgradeRequired",
  "pairingMetadataUpgradeRequired",
  "protocolMismatch",
  "deviceIdentityRequired",
  "deviceSignatureExpired",
  "deviceNonceRequired",
  "deviceNonceMismatch",
  "deviceSignatureInvalid",
  "devicePublicKeyInvalid",
  "deviceIdMismatch",
  "tailscaleIdentityMissing",
  "tailscaleProxyMissing",
  "tailscaleWhoisFailed",
  "tailscaleIdentityMismatch",
  "authRateLimited",
  "timeout",
  "connectionRefused",
  "reachabilityFailed",
  "websocketCancelled",
  "tlsPinMismatch",
  "tlsCertificateUntrusted",
  "tlsCertificateUnavailable",
  "unknown",
];
const SEND_STAGES: [string, string][] = [
  ["chat.ui send queued offline ", "offline-outbox"],
  ["chat.ui send routed behind outbox ", "ordered-outbox"],
  ["chat.ui send queued sessionKey=", "optimistic-message"],
  ["chat.ui transport send start ", "transport-start"],
  ["chat.ui transport send accepted ", "transport-accepted"],
  ["chat.ui send delivery unconfirmed ", "delivery-unconfirmed"],
  ["chat.ui send queued after route change ", "route-changed"],
  ["chat.ui send failed ", "failed"],
  ["chat.send skipped before dispatch: route changed", "dispatch-route-changed"],
];

type TimelineEvent = {
  event: string;
  stage: string;
  atMs: number;
  fields: Record<string, boolean | number | string>;
};

export function diagnosticReadOutcome(error: unknown): "missing" | "too-large" | "unreadable" {
  if (isRecord(error) && error.code === "ENOENT") {
    return "missing";
  }
  return error instanceof Error && error.message === "diagnostic-size-budget"
    ? "too-large"
    : "unreadable";
}

export async function readReadinessLog(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_LOG_BYTES) {
      throw new Error("diagnostic-size-budget");
    }
    const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > MAX_LOG_BYTES) {
      throw new Error("diagnostic-size-budget");
    }
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,8})$/u.test(value)) {
    return undefined;
  }
  return Number(value);
}

export function projectReadinessTimeline(text: string, startedAt: number) {
  const events: TimelineEvent[] = [];
  let rejected = 0;
  let omitted = 0;
  for (const line of text.split("\n")) {
    const match = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] (.+)$/u.exec(line);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const message = match[2];
    let event: string;
    let stage: string;
    const fields: TimelineEvent["fields"] = {};
    if (message.startsWith("ios.readiness ")) {
      if (message.length > 2048) {
        rejected++;
        continue;
      }
      const values = new Map<string, string>();
      for (const pair of message.slice("ios.readiness ".length).split(" ")) {
        const [key, value, extra] = pair.split("=");
        if (key && value && extra === undefined) {
          values.set(key, value);
        }
      }
      event = values.get("event") ?? "";
      stage = values.get("stage") ?? "";
      if (!Object.hasOwn(STAGES, event) || !STAGES[event]?.includes(stage)) {
        rejected++;
        continue;
      }
      for (const key of BOOLEAN_FIELDS) {
        const value = values.get(key);
        if (value === "true" || value === "false") {
          fields[key] = value === "true";
        }
      }
      for (const key of NUMBER_FIELDS) {
        const value = number(values.get(key));
        if (value !== undefined) {
          fields[key] = value;
        }
      }
      for (const [key, accepted] of [
        ["outcome", OUTCOMES],
        ["problem", CONNECTION_PROBLEMS],
      ] as const) {
        const value = values.get(key);
        if (value && accepted.includes(value)) {
          fields[key] = value;
        }
      }
    } else if (message.startsWith("chat.ui send invoked ")) {
      event = "send";
      stage = "invoked";
      for (const [source, target] of [
        ["inputLen", "inputLength"],
        ["pending", "pending"],
      ]) {
        const value = number(
          new RegExp(`(?:^| )${source}=([0-9]+)(?: |$)`, "u").exec(message)?.[1],
        );
        if (value !== undefined && target) {
          fields[target] = value;
        }
      }
      for (const key of ["sending", "health"]) {
        const value = new RegExp(`(?:^| )${key}=(true|false)(?: |$)`, "u").exec(message)?.[1];
        if (value !== undefined) {
          fields[key] = value === "true";
        }
      }
    } else if (message.startsWith("chat.ui send ignored ")) {
      event = "send";
      stage = "ignored";
      const reason = /(?:^| )reason=([^ ]+)(?: |$)/u.exec(message)?.[1];
      fields.reason = reason && IGNORED_REASONS.has(reason) ? reason : "unknown";
    } else {
      const existing = SEND_STAGES.find(([prefix]) => message.startsWith(prefix));
      if (!existing) {
        continue;
      }
      event = "send";
      stage = existing[1];
    }
    const atMs = Date.parse(match[1]) - startedAt;
    if (!Number.isFinite(atMs) || Math.abs(atMs) > 3_600_000) {
      rejected++;
      continue;
    }
    events.push({ event, stage, atMs, fields });
    if (events.length > MAX_EVENTS) {
      // Keep startup and the latest send together when repetitive events fill the budget.
      events.splice(32, 1);
      omitted++;
    }
  }
  return { events, rejected, omitted };
}

export async function readProviderIngress(url: string, signal: AbortSignal) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { status: "unavailable" };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) {
          break;
        }
        bytes += item.value.length;
        if (bytes > 8192) {
          await reader.cancel();
          return { status: "too-large" };
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !isRecord(value) ||
      value.ok !== true ||
      !isRecord(value.requests) ||
      !isRecord(value.requests.ingress)
    ) {
      return { status: "malformed" };
    }
    const counts: Record<string, number> = {};
    for (const key of ["responses", "chatCompletions", "embeddings", "other"]) {
      const count = value.requests.ingress[key];
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 1_000_000
      ) {
        return { status: "malformed" };
      }
      counts[key] = count;
    }
    return { status: "read", counts };
  } catch {
    return { status: "unavailable" };
  }
}
