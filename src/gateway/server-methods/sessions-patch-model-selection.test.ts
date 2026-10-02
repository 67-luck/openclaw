import { afterEach, expect, it } from "vitest";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { refreshSessionPatchQueuedSelection } from "./sessions-patch-model-selection.js";

const sessionKey = "agent:main:direct:model-reset";

afterEach(() => {
  clearFollowupQueue(sessionKey);
});

it("retargets an already queued follow-up after a committed model reset", () => {
  const cfg = { agents: { defaults: { model: "openai/configured" } } };
  const source = {
    prompt: "queued message",
    enqueuedAt: 1,
    run: {
      agentId: "main",
      agentDir: "/fixture/agent",
      sessionId: "session-reset",
      sessionKey,
      sessionFile: "/fixture/session.jsonl",
      workspaceDir: "/fixture/workspace",
      config: cfg,
      provider: "anthropic",
      model: "old-override",
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
      timeoutMs: 30_000,
      blockReplyBreak: "message_end" as const,
    },
  };
  enqueueFollowupRun(sessionKey, source, { mode: "followup" }, "none", undefined, false);

  refreshSessionPatchQueuedSelection({
    cfg,
    entry: { sessionId: "session-reset", updatedAt: 2 },
    patch: { key: sessionKey, model: null },
    sessionKey,
    agentId: "main",
  });

  expect(source.run).toMatchObject({
    provider: "openai",
    model: "configured",
    hasSessionModelOverride: false,
    modelOverrideSource: undefined,
  });
});
