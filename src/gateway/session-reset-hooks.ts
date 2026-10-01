import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../auto-reply/reply/session-hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import {
  emitSessionAutoResetHook,
  hasSessionAutoResetListeners,
  isSessionAutoResetReason,
} from "../hooks/session-auto-reset.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import {
  resolveStableSessionEndTranscript,
  type ArchivedSessionTranscript,
} from "./session-transcript-files.fs.js";

export function emitGatewaySessionEndPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
  workspaceDir?: string;
  reason:
    | "new"
    | "reset"
    | "idle"
    | "daily"
    | "compaction"
    | "deleted"
    | "shutdown"
    | "restart"
    | "unknown";
  archivedTranscripts?: ArchivedSessionTranscript[];
  nextSessionId?: string;
  nextSessionKey?: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  // Drop this session from the shutdown finalizer's tracked set unconditionally
  // -- even when no plugin hooks are registered for `session_end`, the session
  // is being closed here and must not be re-finalized by a later shutdown drain.
  forgetActiveSessionForShutdown(params.sessionId);
  const hookRunner = getGlobalHookRunner();
  const shouldEmitAutoReset =
    isSessionAutoResetReason(params.reason) && hasSessionAutoResetListeners();
  const shouldEmitPluginHook = hookRunner?.hasHooks("session_end") === true;
  if (!shouldEmitAutoReset && !shouldEmitPluginHook) {
    return;
  }
  const transcript = resolveStableSessionEndTranscript({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    archivedTranscripts: params.archivedTranscripts,
  });
  if (shouldEmitAutoReset) {
    emitSessionAutoResetHook({
      cfg: params.cfg,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      reason: params.reason,
      sessionFile: transcript.sessionFile,
      transcriptArchived: transcript.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      storePath: params.storePath,
    });
  }
  if (!shouldEmitPluginHook) {
    return;
  }
  if (!hookRunner) {
    return;
  }
  const payload = buildSessionEndHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    reason: params.reason,
    sessionFile: transcript.sessionFile,
    transcriptArchived: transcript.transcriptArchived,
    nextSessionId: params.nextSessionId,
    nextSessionKey: params.nextSessionKey,
  });
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await hookRunner.runSessionEnd(payload.event, payload.context);
  }, "hooks:session-end").catch((err: unknown) => {
    logVerbose(`session_end hook failed: ${String(err)}`);
  });
}

export function emitGatewaySessionStartPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  resumedFrom?: string;
  storePath?: string;
  sessionFile?: string;
  agentId: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  // Track the session for the shutdown finalizer even when no plugin hooks are
  // registered locally, so a later restart still emits a typed `session_end`
  // for sessions that opened while a `session_end` plugin was attached. The
  // tracker is keyed by `sessionId`, so a session that is subsequently closed
  // via reset / delete / compaction is forgotten before the shutdown drain
  // ever runs (see #57790).
  if (params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_start")) {
    return;
  }
  const payload = buildSessionStartHookPayload({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    resumedFrom: params.resumedFrom,
  });
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await hookRunner.runSessionStart(payload.event, payload.context);
  }, "hooks:session-start").catch((err: unknown) => {
    logVerbose(`session_start hook failed: ${String(err)}`);
  });
}

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  await getSessionBindingService().unbind({
    targetSessionKey: params.targetSessionKey,
    reason: params.reason,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}
