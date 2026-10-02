import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  getRpcSourceIdentity,
  getRpcSourceStartedAt,
  isRpcSourceActive,
  listRpcSourceEntries,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";
import type { ChatRunPlanSnapshot, ChatRunState } from "./server-chat-state.js";

export type InFlightRunSnapshot = {
  runId: string;
  text: string;
  startedAt?: number;
  /**
   * True when the in-flight run is owned by the embedded-run registry and can
   * only be cancelled through the session-owned abort path (sessions.abort),
   * never through run-specific chat.abort. Control UI uses this to keep Stop
   * routing session-scoped for recovered embedded runs.
   */
  sessionAbortable?: boolean;
  plan?: ChatRunPlanSnapshot;
  events?: AgentEventPayload[];
};

export function projectInFlightRunSnapshot(params: {
  chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs">;
  runId: string;
  startedAtMs?: number;
  sessionAbortable?: boolean;
}): InFlightRunSnapshot {
  const run = params.chatRunState.runs.get(params.runId);
  const projected = projectLiveAssistantBufferedText(
    params.chatRunState.resolveBuffer(params.runId).text,
    { suppressLeadFragments: true },
  );
  const plan = run?.planSnapshot;
  const events = run?.progressSnapshot?.events;
  return {
    runId: params.runId,
    text: projected.suppress ? "" : projected.text,
    ...(params.startedAtMs === undefined ? {} : { startedAt: params.startedAtMs }),
    ...(params.sessionAbortable ? { sessionAbortable: true } : {}),
    ...(plan ? { plan } : {}),
    ...(events?.length ? { events } : {}),
  };
}

/** Restore the newest visible run when chat.history switches back to its session.
 * Match requested and canonical keys, with agent scoping for the shared global row.
 */
export function resolveInFlightRunSnapshot(params: {
  chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs">;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): InFlightRunSnapshot | undefined {
  const matchesKey = (entry: RpcSourceRef, key: string): boolean => {
    const identity = getRpcSourceIdentity(entry);
    if (identity.sessionKey !== key) {
      return false;
    }
    if (key !== "global") {
      return true;
    }
    const requestedAgentId =
      normalizeOptionalLowercaseString(params.agentId) ??
      normalizeOptionalLowercaseString(params.defaultAgentId);
    if (!requestedAgentId) {
      return false;
    }
    const runAgentId =
      normalizeOptionalLowercaseString(identity.agentId) ??
      normalizeOptionalLowercaseString(params.defaultAgentId);
    return runAgentId === requestedAgentId;
  };
  // Timestamp wins over insertion order; runId breaks ties deterministically.
  let best: { runId: string; startedAtMs: number } | undefined;
  for (const [runId, entry] of listRpcSourceEntries()) {
    if (
      !isRpcSourceActive(entry) ||
      entry.adapter.controlUiVisible === false ||
      entry.input.abortSignal.aborted ||
      entry.adapter.kind === "agent"
    ) {
      continue;
    }
    if (
      !matchesKey(entry, params.requestedSessionKey) &&
      !matchesKey(entry, params.canonicalSessionKey)
    ) {
      continue;
    }
    const newer = best === undefined || (getRpcSourceStartedAt(entry) ?? 0) > best.startedAtMs;
    const tie =
      best !== undefined &&
      (getRpcSourceStartedAt(entry) ?? 0) === best.startedAtMs &&
      runId > best.runId;
    if (newer || tie) {
      best = { runId, startedAtMs: getRpcSourceStartedAt(entry) ?? 0 };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  // A run can be active before its first text arrives. Adopt it now so the UI
  // stays streaming and can reconcile the eventual reply.
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId: best.runId,
    startedAtMs: best.startedAtMs,
  });
}
