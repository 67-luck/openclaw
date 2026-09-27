import type { InternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";

export const DIAGNOSTIC_STABILITY_EVENT_INTEREST = {
  // Recovery needs model-call telemetry; other trusted events have dedicated owners.
  includeTrusted: ["model.call.started", "model.call.completed", "model.call.error"],
  exclude: [
    "log.record",
    "telemetry.exporter",
    "gateway.rpc",
    "gateway.admission",
    "gateway.run.owner",
    "gateway.event_loop.sample",
    "diagnostic.gc",
    "diagnostic.child_process.spawn",
    "model.runtime_choice",
  ],
} as const satisfies InternalDiagnosticEventInterest<DiagnosticEventPayload["type"]>;
