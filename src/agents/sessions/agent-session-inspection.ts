import { selectSessionResidentEvidence } from "../../config/sessions/session-context-usage-evidence.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { AssistantMessage } from "../../llm/types.js";
import { estimateContextTokens } from "../runtime/index.js";
import { AgentSessionModels } from "./agent-session-models.js";
import {
  estimateMessagesFromContent,
  extractTextContent,
  hasPersistedAssistantContent,
} from "./agent-session-utils.js";
import type { ContextUsage } from "./extensions/index.js";
import { warnSessionPersistenceDeprecation } from "./session-persistence-deprecation.js";

export abstract class AgentSessionInspection extends AgentSessionModels {
  /** @deprecated Use setSessionNameAsync; removed at the next Plugin SDK major. */
  setSessionName(name: string): void {
    warnSessionPersistenceDeprecation("AgentSession.setSessionName", "setSessionNameAsync");
    this.sessionManager.appendSessionInfo(name);
    this.emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
  }

  /** Persist the display name before publishing its changed event. */
  async setSessionNameAsync(name: string): Promise<void> {
    const manager = this.sessionManager;
    const target = manager.getSessionTarget();
    const sessionId = manager.getSessionId();
    const assertCurrent = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
    await manager.appendSessionInfoAsync(name);
    assertCurrent?.();
    if (
      this.sessionManager !== manager ||
      manager.getSessionId() !== sessionId ||
      !sameSessionTranscriptTargetBinding(target, manager.getSessionTarget())
    ) {
      throw new Error("Session changed before publishing its display name");
    }
    this.emit({ type: "session_info_changed", name: manager.getSessionName() });
  }

  getContextUsage(): ContextUsage | undefined {
    const model = this.model;
    if (!model) {
      return undefined;
    }

    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) {
      return undefined;
    }

    const { mode } = selectSessionResidentEvidence(this.sessionManager.getBranch());
    if (mode === "unknown") {
      return { tokens: null, contextWindow, percent: null };
    }

    const tokens =
      mode === "content"
        ? estimateMessagesFromContent(this.messages)
        : estimateContextTokens(this.messages).tokens;
    const percent = (tokens / contextWindow) * 100;

    return {
      tokens,
      contextWindow,
      percent,
    };
  }

  /**
   * Get text content of last assistant message.
   * Useful for /copy command.
   * @returns Text content, or undefined if no assistant message exists
   */
  getLastAssistantText(): string | undefined {
    const message = this.messages.findLast(
      (entry): entry is AssistantMessage =>
        entry.role === "assistant" &&
        (entry.stopReason !== "aborted" || hasPersistedAssistantContent(entry.content)),
    );
    return message ? extractTextContent(message.content).trim() || undefined : undefined;
  }
}
