import type { HeartbeatConfig } from "./heartbeat-config.js";
import type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

/** Fallback policy for retained routes, never an independently requested destination. */
export function captureHeartbeatRouteContinuation(
  heartbeat: HeartbeatConfig,
  cronPayload: boolean,
): NonNullable<HeartbeatWakeRequest["routeContinuation"]> {
  return {
    cronPayload,
    // This is the actual sparse request, not resolved configuration. Retain its admission policy too.
    heartbeat: heartbeat && { ...heartbeat },
  };
}

/** The wake owner chooses priority; only its retained policy is combined here. */
export function mergeHeartbeatRouteContinuation(
  preferred: HeartbeatWakeRequest,
  other: HeartbeatWakeRequest,
): HeartbeatWakeRequest["routeContinuation"] {
  const cronPayload =
    preferred.source === "cron" ||
    other.source === "cron" ||
    preferred.routeContinuation?.cronPayload === true ||
    other.routeContinuation?.cronPayload === true;
  if (
    !preferred.routeContinuation &&
    !other.routeContinuation &&
    (!cronPayload || preferred.source === "cron")
  ) {
    return undefined;
  }
  return {
    heartbeat: preferred.routeContinuation?.heartbeat ?? other.routeContinuation?.heartbeat,
    cronPayload,
  };
}

/** Clear cron last-target fields before coalescing can change the effective source. */
export function normalizeRequestedHeartbeatDestination(
  source: HeartbeatWakeRequest["source"],
  heartbeat: HeartbeatWakeRequest["heartbeat"],
): HeartbeatWakeRequest["heartbeat"] {
  return source === "cron" && heartbeat?.target === "last"
    ? { ...heartbeat, to: undefined, accountId: undefined }
    : heartbeat;
}

/** Independent destinations override retained destinations; configured opt-outs still apply. */
export function resolveRequestedHeartbeatWithContinuation(
  independent: HeartbeatWakeRequest["heartbeat"],
  continuation: HeartbeatWakeRequest["routeContinuation"],
  configured: HeartbeatConfig,
): HeartbeatConfig {
  const fallback = continuation?.heartbeat && { ...continuation.heartbeat };
  if (!fallback) {
    return independent;
  }
  if (independent !== undefined || configured?.target === "none") {
    delete fallback.target;
    delete fallback.to;
    delete fallback.accountId;
  }
  return independent
    ? { ...fallback, ...independent }
    : Object.keys(fallback).length > 0
      ? fallback
      : undefined;
}
