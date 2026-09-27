import type { DiagnosticBaseEvent } from "./diagnostic-base-event.types.js";

/** Payload-free native admission facts; absence never proves a denied or accepted action. */
export type DiagnosticGatewayAdmissionEvent = DiagnosticBaseEvent & {
  type: "gateway.admission";
  method: "gateway.restart.request";
  outcome: "emitted" | "coalesced" | "failed";
};

export type DiagnosticGatewayRunOwnerEvent = DiagnosticBaseEvent & {
  type: "gateway.run.owner";
  phase: "before_tool_call";
  gatewayOwner: "match" | "mismatch" | "unobserved";
};
