import { beforeEach, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { SessionControllerMailboxClaim } from "../../sessions/session-controller.mailbox.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  admit: vi.fn(),
  preflight: vi.fn(),
  resolveConfig: vi.fn(async (config: unknown) => config),
}));

vi.mock("../../sessions/session-controller.mailbox.js", () => ({
  attachSessionControllerInputOperation: vi.fn(),
  bindSessionControllerInputOperation: vi.fn(),
  claimSessionControllerInput: vi.fn(),
  releaseSessionControllerClaim: vi.fn(),
}));
vi.mock("./agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: (config: unknown) => state.resolveConfig(config),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));
vi.mock("./reply-turn-admission.js", () => ({
  admitReplyTurn: (...args: unknown[]) => state.admit(...args),
}));
vi.mock("./reply-turn-preflight.js", () => ({
  prepareReplyTurnContext: (...args: unknown[]) => state.preflight(...args),
}));

const { prepareReplyAgentTurn } = await import("./reply-agent-turn-preparation.js");

function createRun(): FollowupRun {
  return {
    prompt: "hello",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "provider",
      model: "model",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

function createOperation(): ReplyOperation {
  return {
    sessionId: "session",
    abortSignal: new AbortController().signal,
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  } as unknown as ReplyOperation;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.admit.mockImplementation(async () => ({
    status: "owned",
    operation: createOperation(),
    sessionEntry: undefined,
  }));
  state.preflight.mockResolvedValue(undefined);
});

it("prepares immediate and queued turns through the same model and memory preflight", async () => {
  const signalRunStart = vi.fn(async () => {});
  const claimSource = async () =>
    ({ abortController: new AbortController() }) as SessionControllerMailboxClaim;
  for (const kind of ["visible", "queued_followup"] as const) {
    const result = await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: {
        typing: {} as Parameters<typeof prepareReplyAgentTurn>[0]["defaults"]["typing"],
        typingMode: "never",
        defaultModel: "default-model",
      },
      kind,
      claimSource,
      signalRunStart,
    });
    expect(result.kind).toBe("admitted");
  }
  expect(state.resolveConfig).toHaveBeenCalledTimes(2);
  expect(state.preflight).toHaveBeenCalledTimes(2);
  expect(signalRunStart).toHaveBeenCalledTimes(2);
  expect(state.preflight.mock.calls.map(([params]) => params.defaultModel)).toEqual([
    "default-model",
    "default-model",
  ]);
});
