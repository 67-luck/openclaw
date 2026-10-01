import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  type getAgentTestMocks,
  mockMainSessionEntry,
  invokeAgent,
  expectRespondError,
  expectStringFieldContains,
} from "./agent.test-harness.js";

export function registerAgentRestartRecoveryRejectionCases(
  mocks: ReturnType<typeof getAgentTestMocks>,
) {
  it("rejects ordinary work on a restart-recovery tombstone", async () => {
    const entry = {
      sessionId: "tombstoned-session",
      updatedAt: Date.now(),
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    };
    mockMainSessionEntry(entry);
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) => await updater({ "agent:main:main": structuredClone(entry) }),
    );
    const commandCallCount = mocks.agentCommand.mock.calls.length;
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "continue old work",
        sessionKey: "agent:main:main",
        idempotencyKey: "tombstone-reuse",
      },
      { reqId: "tombstone-reuse", respond },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
    const error = expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST });
    expectStringFieldContains(error, "message", "ended during restart recovery");
  });

  it("rejects ordinary work while restart recovery exhaustion is being tombstoned", async () => {
    const entry = {
      sessionId: "exhausted-session",
      updatedAt: Date.now(),
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 4,
        chargedAttempts: 3,
      },
    };
    mockMainSessionEntry(entry);
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) => await updater({ "agent:main:main": structuredClone(entry) }),
    );
    const commandCallCount = mocks.agentCommand.mock.calls.length;
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "continue old work",
        sessionKey: "agent:main:main",
        idempotencyKey: "exhausted-reuse",
      },
      { reqId: "exhausted-reuse", respond },
    );

    expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
    const error = expectRespondError(respond, { code: ErrorCodes.UNAVAILABLE });
    expectStringFieldContains(error, "message", "quarantined after restart recovery exhaustion");
  });
}
