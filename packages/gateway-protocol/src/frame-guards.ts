import { isNonEmptyProtocolString, isProtocolRecord } from "./protocol-value-normalization.js";
import type { EventFrame, ResponseFrame } from "./schema/frames.js";
import type { SessionsChangedBundleEvent } from "./schema/sessions-changed.js";
export { GATEWAY_SERVER_CAPS } from "./server-capabilities.js";
export type {
  ConnectParams,
  ErrorShape,
  EventFrame,
  GatewayFrame,
  HelloOk,
  RequestFrame,
  ResponseFrame,
} from "./schema/frames.js";

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGatewayErrorShape(value: unknown): boolean {
  if (!isProtocolRecord(value)) {
    return false;
  }
  if (!isNonEmptyProtocolString(value.code) || !isNonEmptyProtocolString(value.message)) {
    return false;
  }
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    return false;
  }
  return value.retryAfterMs === undefined || isNonNegativeInteger(value.retryAfterMs);
}

// These lightweight guards validate dispatch-critical envelope fields without
// compiling the full schemas or rejecting additive payload fields.
export function isGatewayEventFrame(value: unknown): value is EventFrame {
  if (
    !isProtocolRecord(value) ||
    value.type !== "event" ||
    !isNonEmptyProtocolString(value.event)
  ) {
    return false;
  }
  return value.seq === undefined || isNonNegativeInteger(value.seq);
}

export function isGatewayResponseFrame(value: unknown): value is ResponseFrame {
  if (
    !isProtocolRecord(value) ||
    value.type !== "res" ||
    !isNonEmptyProtocolString(value.id) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.error === undefined || isGatewayErrorShape(value.error);
}

/** Validates bundle dispatch fields without importing the schema registry into browsers. */
export function isSessionsChangedBundleEvent(value: unknown): value is SessionsChangedBundleEvent {
  return (
    isProtocolRecord(value) &&
    isNonEmptyProtocolString(value.sessionKey) &&
    (value.agentId === undefined || isNonEmptyProtocolString(value.agentId)) &&
    Array.isArray(value.receipts) &&
    value.receipts.length > 0 &&
    value.receipts.length <= 32 &&
    value.receipts.every(
      (receipt: unknown) =>
        isProtocolRecord(receipt) &&
        Object.hasOwn(receipt, "payload") &&
        (receipt.stateVersion === undefined ||
          (isProtocolRecord(receipt.stateVersion) &&
            isNonNegativeInteger(receipt.stateVersion.presence) &&
            isNonNegativeInteger(receipt.stateVersion.health))),
    )
  );
}
