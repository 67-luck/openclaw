import type { DiagnosticBaseEvent } from "./diagnostic-base-event.types.js";

/** Payload-free facts from authenticated Gateway WebSocket request owners. */
export type DiagnosticGatewayRpcEvent = DiagnosticBaseEvent & {
  type: "gateway.rpc";
  /** Canonical core method name, or a fixed other/unknown bucket. */
  method: string;
} & (
    | { phase: "received" }
    | {
        phase: "response";
        outcome: "ok" | "error" | "unavailable" | "suppressed";
        durationMs: number;
      }
    | {
        phase: "handler";
        outcome: "returned" | "threw";
        durationMs: number;
        admissionMs: number;
      }
    | {
        phase: "dispatch";
        outcome: "returned" | "threw" | "rejected" | "cancelled";
        durationMs: number;
        queueWaitMs?: number;
        response: "none" | "sent" | "unavailable" | "suppressed";
      }
  );
