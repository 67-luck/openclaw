import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { runReplyAgent } from "./agent-runner.runtime.js";
import type { PreparedReplyThinkingFixture } from "./get-reply-run.media-only.test.js";
import { baseParams } from "./get-reply-run.test-support.js";

export function registerPreparedReplyThinkingCases({
  runPrepared,
  requireRunReplyAgentCall,
}: PreparedReplyThinkingFixture) {
  it("hydrates runtime thinking metadata before trusting static provider support", async () => {
    const resolveThinkingCatalog = vi.fn(async () => [
      {
        provider: "openai",
        id: "chat-latest",
        name: "Chat Latest",
        reasoning: false,
      },
    ]);

    await runPrepared({
      provider: "openai",
      model: "chat-latest",
      resolvedThinkLevel: "high",
      modelState: {
        ...baseParams().modelState,
        resolveDefaultThinkingLevel: async () => "high",
        resolveThinkingCatalog,
        allowedModelCatalog: [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
          },
        ],
      },
    });

    expect(resolveThinkingCatalog).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.thinkLevel).toBe("off");
    expect(call.followupRun.run.thinkingCatalog).toEqual([
      {
        provider: "openai",
        id: "chat-latest",
        name: "Chat Latest",
        reasoning: false,
      },
    ]);
  });

  it("reports unsupported explicit one-turn thinking overrides", async () => {
    const result = await runPrepared({
      provider: "openai",
      model: "chat-latest",
      resolvedThinkLevel: "xhigh",
      opts: { thinkingLevelOverride: "xhigh" },
      modelState: {
        ...baseParams().modelState,
        resolveDefaultThinkingLevel: async () => "high",
        resolveThinkingCatalog: async () => [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
            reasoning: false,
          },
        ],
        allowedModelCatalog: [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
          },
        ],
      },
    });

    expect(Array.isArray(result) ? undefined : result?.text).toContain(
      'Thinking level "xhigh" is not supported',
    );
    expect(runReplyAgent).not.toHaveBeenCalled();
  });

  it("does not persist turn-local thinking fallback over a stored session override", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-thinking",
      thinkingLevel: "high",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": sessionEntry,
    };

    await runPrepared({
      provider: "openai",
      model: "chat-latest",
      resolvedThinkLevel: "high",
      sessionEntry,
      sessionStore,
      storePath: "/tmp/openclaw-sessions.json",
      modelState: {
        ...baseParams().modelState,
        resolveDefaultThinkingLevel: async () => "high",
        resolveThinkingCatalog: async () => [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
            reasoning: false,
          },
        ],
        allowedModelCatalog: [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
          },
        ],
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.thinkLevel).toBe("off");
    expect(sessionEntry.thinkingLevel).toBe("high");
    expect(sessionStore["session-key"]?.thinkingLevel).toBe("high");
  });
}
