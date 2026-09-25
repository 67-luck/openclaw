import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { transformMessages } from "../../packages/ai/src/transcript-transform.js";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createAssistantErrorTranscript } from "./assistant-error-transcript.js";
import { normalizeAssistantReplayContent } from "./embedded-agent-runner/replay-history.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { createTranscriptEventFixture } from "./session-tool-result-guard.transcript.test-support.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import {
  prepareCodeModeSourceAppend,
  takeCodeModeResponseSource,
  wrapStreamFnCodeModeSource,
} from "./transcript-code-mode-source.js";
const listeners: Array<() => void> = [];
const { openPersistedSessionManager } = createTranscriptEventFixture();

afterEach(async () => {
  // Remove all transcript listeners between tests to avoid duplicate broadcasts.
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

describe("deferred assistant error transcript", () => {
  async function setup() {
    const { sessionManager: manager, target } = await openPersistedSessionManager();
    const owner = createAssistantErrorTranscript({ runId: "run-test" });
    installSessionToolResultGuard(manager, { assistantErrorTranscript: owner });
    return { target, owner, manager };
  }

  it.each([false, true])("persists only the last failure when terminal=%s", async (terminal) => {
    const { target, owner, manager } = await setup();
    for (let attempt = 1; attempt <= 10; attempt++) {
      manager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: `Partial attempt ${attempt}` }],
          stopReason: "error",
          errorMessage: `provider rate limit ${attempt}`,
        }),
      );
      expect(SessionManager.open(target).getBranch()).toHaveLength(0);
    }
    if (!terminal) {
      manager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "Recovered" }] }),
      );
    }
    await owner.settle(terminal);
    await owner.settle(terminal);
    const messages = SessionManager.open(target)
      .getBranch()
      .filter((entry) => entry.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatchObject(
      terminal
        ? {
            content: [{ type: "text", text: "Partial attempt 10" }],
            stopReason: "error",
            errorMessage: "provider rate limit 10",
          }
        : { content: [{ type: "text", text: "Recovered" }] },
    );
  });

  it("preserves failed-attempt tool calls before their persisted results through recovery and replay", async () => {
    const { target, owner, manager } = await setup();
    const model = makeProviderModelFixture({
      id: "test-model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.invalid",
    });
    const toolCall = {
      type: "toolCall" as const,
      id: "call-exec",
      name: "exec",
      arguments: { code: "const API_TOKEN = computeToken(); return API_TOKEN;" },
    };
    const failed = makeAgentAssistantMessage({
      content: [{ type: "text", text: "I" }, toolCall],
      stopReason: "error",
      errorMessage: "provider rate limit",
    });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", reason: "error", error: failed });
    const response = await wrapStreamFnCodeModeSource(() => stream, new Set(["exec"]))(model, {
      messages: [],
    });
    const emitted = await response.result();
    manager.appendMessage(
      emitted,
      prepareCodeModeSourceAppend({}, emitted, takeCodeModeResponseSource(emitted)),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Persisted result" }],
      isError: false,
      timestamp: 1,
    });
    owner.clear();
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Recovered" }],
        timestamp: 2,
      }),
    );
    await owner.settle(false);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      { role: "assistant", content: [toolCall], stopReason: "toolUse" },
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        content: [{ type: "text", text: "Persisted result" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
    ]);
    expect(messages[0]).not.toHaveProperty("errorMessage");
    const normalized = normalizeAssistantReplayContent(messages);
    const replay = transformMessages(
      normalized.filter(
        (message) =>
          message.role === "assistant" || message.role === "user" || message.role === "toolResult",
      ),
      model,
    );
    expect(replay).toEqual(normalized);
  });

  it.each([
    {
      label: "canonical media",
      facts: {
        __openclaw: {
          media: [{ url: "https://example.invalid/report.pdf", contentType: "application/pdf" }],
        },
      },
    },
    { label: "managed attachment", facts: { openclawDelivery: { mediaUrls: ["./report.pdf"] } } },
    {
      label: "display override",
      facts: {
        openclawDisplayContent: [
          { type: "text", text: "Here" },
          { type: "attachment", url: "https://example.invalid/report.pdf" },
        ],
      },
    },
  ])("preserves $label facts without partial text when recovery succeeds", async ({ facts }) => {
    const { target, owner, manager } = await setup();
    const failed = {
      ...makeAgentAssistantMessage({
        content: [{ type: "text", text: "Here" }],
        stopReason: "error",
        errorMessage: "retry",
      }),
      ...facts,
    };
    manager.appendMessage(failed);
    owner.clear();
    manager.appendMessage(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "Recovered" }] }),
    );
    await owner.settle(false);
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [],
        stopReason: "stop",
        ...facts,
        ...(facts.openclawDisplayContent
          ? { openclawDisplayContent: [facts.openclawDisplayContent[1]] }
          : {}),
      },
      { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
    ]);
  });

  it("keeps terminal partial text and its error without duplicating tool facts or usage", async () => {
    const { target, owner, manager } = await setup();
    const displayText = { type: "text", text: "Displayed partial answer" };
    const attachment = { type: "attachment", url: "https://example.invalid/report.pdf" };
    const failed = {
      ...makeAgentAssistantMessage({
        content: [
          { type: "text", text: "Partial answer" },
          { type: "toolCall", id: "call-terminal", name: "read", arguments: {} },
        ],
        stopReason: "error",
        errorMessage: "terminal failure",
      }),
      openclawDisplayContent: [displayText, attachment],
    };
    failed.usage = { ...failed.usage, output: 7, totalTokens: 7 };
    manager.appendMessage(failed);
    manager.appendMessage(makeTextToolResult("call-terminal", "read", "Result", false, 1));
    await owner.settle(true);
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-terminal" }],
        openclawDisplayContent: [attachment],
        usage: { output: 7 },
      },
      { role: "toolResult", toolCallId: "call-terminal" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        openclawDisplayContent: [displayText],
        stopReason: "error",
        errorMessage: "terminal failure",
        usage: { output: 0 },
      },
    ]);
  });

  it("revalidates the captured writer before committing a terminal failure", async () => {
    const { target, owner, manager } = await setup();
    let active = true;
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {
          if (!active) {
            throw new Error("writer retired");
          }
        },
        withTranscriptWrite: async (operation) => await operation(),
      },
      async () => {
        manager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
      },
    );
    active = false;
    await expect(owner.settle(true)).rejects.toThrow("writer retired");
    expect(SessionManager.open(target).getBranch()).toHaveLength(0);
  });
});
