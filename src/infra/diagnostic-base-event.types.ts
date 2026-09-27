import type { DiagnosticTraceContext } from "./diagnostic-trace-context.js";

export type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};
