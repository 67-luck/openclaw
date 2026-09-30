import type { Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import {
  captureEmbeddedAttemptContinuation,
  readEmbeddedContinuationPrefix,
} from "./attempt-continuation.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";

registerAgentSessionLoopTestLifecycle();

it.each(["replace", "passthrough", "none"] as const)(
  "revises once from persisted lookup evidence with %s history assembly and no recorder",
  async (engineMode) => {
    const read = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "The server listens on port 443." }],
      details: {},
    }));
    const { session, sessionManager, settingsManager } = await createTestSession({
      customTools: [
        {
          name: "read_fixture",
          label: "Read fixture",
          description: "Read fixture",
          parameters: Type.Object({}),
          execute: read,
        },
      ],
    });
    const requests: Message[][] = [];
    session.agent.streamFn = (_model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(
        createAssistant(
          testModel,
          requests.length === 1
            ? [{ type: "toolCall", id: "lookup", name: "read_fixture", arguments: {} }]
            : [
                {
                  type: "text",
                  text:
                    requests.length === 2
                      ? "Use port 443 and disable certificate checks."
                      : "Use port 443.",
                },
              ],
          requests.length === 1 ? "toolUse" : "stop",
        ),
      );
    };
    // Keep prior history distinct from the tool evidence produced by the new logical turn.
    sessionManager.appendMessage({ role: "user", content: "Earlier conversation", timestamp: 1 });
    session.agent.state.messages = sessionManager.buildSessionContext().messages;
    const capture = captureEmbeddedAttemptContinuation(
      { captureContinuationMessages: true },
      session,
    );
    await session.prompt("Find the server port.");
    capture.close();
    const continuationParams = {
      continuationMessages: capture.read(),
      continuationHistoryPrefix: capture.historyPrefix,
    };
    const continuation = await readEmbeddedContinuationPrefix(continuationParams);
    expect(continuation?.prefix).toEqual([
      { role: "user", content: "Earlier conversation", timestamp: 1 },
    ]);
    // Reopen the persisted context as the next native attempt does, rather than replacing it in the test.
    session.agent.state.messages = sessionManager.buildSessionContext().messages;
    const activeContextEngine =
      engineMode === "none"
        ? undefined
        : {
            info: { id: "history-fixture", name: "History fixture" },
            ingest: async () => ({ ingested: true }),
            assemble: async ({ messages }: { messages: typeof session.messages }) => ({
              messages: engineMode === "replace" ? [] : messages,
              estimatedTokens: 0,
            }),
            compact: async () => ({ ok: true, compacted: false }),
          };
    // SAFETY: This real-history entry-point fixture supplies every field used by history preparation;
    // unrelated bootstrap, tool execution and settlement state are not exercised.
    const input = {
      attempt: {
        ...continuationParams,
        model: testModel,
        modelId: testModel.id,
        provider: testModel.provider,
        sessionId: session.sessionId,
        prompt: "Reuse the lookup",
      },
      activeContextEngine,
      isRawModelRun: false,
      prepared: {
        sessionRuntime: {
          agentSession: {
            activeSession: session,
            settingsManager,
            setActiveSessionSystemPrompt: vi.fn(),
          },
          boundary: {},
          sessionManager,
          transcriptPolicy: resolveTranscriptPolicy({
            modelApi: testModel.api,
            modelId: testModel.id,
            provider: testModel.provider,
          }),
          transport: {},
          state: { systemPromptText: "" },
        },
        toolCatalog: {
          toolSearchRunPlan: {
            capabilityToolNames: ["read_fixture"],
            replayAllowedToolNames: ["read_fixture"],
          },
        },
      },
      setup: { effectiveWorkspace: sessionManager.getCwd(), sessionAgentId: "main" },
    } as unknown as Parameters<typeof prepareEmbeddedAttemptHistory>[0];
    await prepareEmbeddedAttemptHistory(input);
    if (engineMode !== "replace") {
      expect(session.messages).toContainEqual({
        role: "user",
        content: "Earlier conversation",
        timestamp: 1,
      });
    }
    await session.prompt("Remove the unsupported certificate advice. Reuse the completed lookup.");
    expect(read).toHaveBeenCalledOnce();
    expect(requests[2]?.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(
      requests[2]?.filter(
        (message) =>
          message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
      ),
    ).toHaveLength(1);
    expect(requests[2]).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "lookup",
        content: [{ type: "text", text: "The server listens on port 443." }],
      }),
    );
    expect(
      requests[2]?.filter(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("Find the server port."),
      ),
    ).toHaveLength(1);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Use port 443." }],
    });
  },
);
