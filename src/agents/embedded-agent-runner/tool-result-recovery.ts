import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import { committedSessionPublicationError } from "../sessions/agent-session-publication.js";
import { sessionManagerPrepareHistoryRead } from "../sessions/session-manager-history.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { log } from "./logger.js";
import type { ToolResultPromptProjectionState } from "./session-prompt-state.js";
import {
  buildRecoveryToolResultReplacementPlan,
  reconcileToolResultPromptProjectionState,
  toolResultWarningDedupe,
} from "./tool-result-truncation.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

function logToolResultSessionTruncation(params: {
  rewrittenEntries: number;
  contextWindowTokens: number;
  maxChars: number;
  aggregateBudgetChars: number;
  oversizedReplacementCount: number;
  aggregateReplacementCount: number;
  sessionKey?: string;
  sessionId?: string;
}): void {
  const sessionLogKey = params.sessionKey ?? params.sessionId ?? "unknown";
  const message =
    `[tool-result-truncation] Truncated ${params.rewrittenEntries} tool result(s) in session ` +
    `(contextWindow=${params.contextWindowTokens} maxChars=${params.maxChars} ` +
    `aggregateBudgetChars=${params.aggregateBudgetChars} ` +
    `oversized=${params.oversizedReplacementCount} aggregate=${params.aggregateReplacementCount}) ` +
    `sessionKey=${sessionLogKey}`;
  if (
    params.aggregateReplacementCount <= 0 ||
    toolResultWarningDedupe.sessionRecovery.check(sessionLogKey)
  ) {
    log.info(message);
    return;
  }
  log.warn(
    `${message}; aggregate tool-result pressure detected; consider /compact or /new if pressure persists`,
  );
}

export async function truncateOversizedToolResultsInSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  projectionState?: ToolResultPromptProjectionState;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  let committed = false;
  try {
    const { sessionManager, contextWindowTokens } = params;
    const history = sessionManager[sessionManagerPrepareHistoryRead]();
    const branch = await history.readBranch({ oversizedToolResults: "complete" });

    const { maxChars, aggregateBudgetChars, plan } = buildRecoveryToolResultReplacementPlan({
      branch,
      contextWindowTokens,
      maxCharsOverride: params.maxCharsOverride,
      aggregateMaxCharsOverride: params.aggregateMaxCharsOverride,
      protectTrailingToolResults: params.protectTrailingToolResults,
      projectionState: params.projectionState,
    });
    if (plan.replacements.length === 0) {
      return {
        truncated: false,
        truncatedCount: 0,
        reason: branch.length === 0 ? "empty session" : "no oversized or aggregate tool results",
      };
    }
    history.assertCurrent();
    const rewriteResult = await rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: plan.replacements,
    });
    committed = rewriteResult.changed;
    history.assertNavigationCurrent();
    if (rewriteResult.changed && params.projectionState) {
      // Recovery changed canonical bytes; keeping their former source would undo the next TTL edit.
      const committedHistory = sessionManager[sessionManagerPrepareHistoryRead]();
      const context = await committedHistory.readContext();
      committedHistory.assertCurrent();
      reconcileToolResultPromptProjectionState(context.messages, params.projectionState);
    }
    const target =
      sessionManager.getSessionTarget() ??
      (params.sessionId && params.sessionKey && params.agentId && params.storePath
        ? {
            agentId: params.agentId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          }
        : undefined);
    if (rewriteResult.changed && (params.sessionFile || target)) {
      emitSessionTranscriptUpdate({
        ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
        ...(target
          ? { target }
          : {
              sessionKey: params.sessionKey,
              ...(params.agentId ? { agentId: params.agentId } : {}),
            }),
      });
    }

    logToolResultSessionTruncation({
      rewrittenEntries: rewriteResult.rewrittenEntries,
      contextWindowTokens,
      maxChars,
      aggregateBudgetChars,
      oversizedReplacementCount: plan.oversizedReplacementCount,
      aggregateReplacementCount: plan.aggregateReplacementCount,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });

    return {
      truncated: rewriteResult.changed,
      truncatedCount: rewriteResult.rewrittenEntries,
      reason: rewriteResult.reason,
    };
  } catch (err) {
    if (isRecordedModelFallbackStop(err)) {
      throw err;
    }
    if (committed) {
      throw committedSessionPublicationError(
        "Tool-result truncation committed, but context publication failed; do not replay the rewrite",
        err,
      );
    }
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}
