import { createNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import type { SessionManager } from "../../sessions/session-manager.js";
import {
  createToolResultPromptProjectionState,
  persistToolResultProjections,
} from "../session-prompt-state.js";

export function appendCompletedToolWork(
  manager: SessionManager,
  runId: string,
  beforeNested?: () => void,
  suffix = "",
) {
  const original = guardSessionManager(manager, { runId });
  original.appendMessage(
    createAssistant(
      testModel,
      [{ type: "toolCall", id: "completed-read" + suffix, name: "read", arguments: {} }],
      "toolUse",
    ),
  );
  beforeNested?.();
  original.appendMessage(
    createNestedToolActivity({
      runId,
      scopeId: "nested-scope" + suffix,
      afterEntryId: original.getAppendParentId(),
      startOrder: 0,
      parentToolCallId: "completed-read" + suffix,
      toolCallId: "nested-read" + suffix,
      toolName: "read",
      input: {},
      result: { content: [{ type: "text", text: "Nested read completed" }] },
      isError: false,
      startedAt: 2,
      timestamp: 3,
    }),
  );
  original.appendMessage({
    role: "toolResult",
    toolCallId: "completed-read" + suffix,
    toolName: "read",
    content: [{ type: "text", text: "Already read: use this completed result" }],
    isError: false,
    timestamp: 4,
  });
  original.appendCustomEntry("openclaw.cache-ttl", { timestamp: 4 });
}

export function appendOversizedCacheSnapshot(manager: SessionManager) {
  const state = createToolResultPromptProjectionState();
  state.frozen.add("prior-result");
  state.sourceHashByKey.set("prior-result", "synthetic-source");
  state.replacements.set("prior-result", {
    content: [{ type: "text", text: "x".repeat(64_000) }],
  });
  persistToolResultProjections(state, (type, data) => manager.appendCustomEntry(type, data));
}
