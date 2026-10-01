import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { AgentRunTerminalOutcomeError } from "../../agent-run-terminal-error.js";
import { buildAgentRunTerminalOutcomeFromAttempt } from "../../agent-run-terminal-outcome.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const discovery = vi.hoisted(() => ({
  load: vi.fn<
    typeof import("../../computer-use-node-capabilities.js").loadPairedComputerUseAvailabilityForSurface
  >(),
}));
vi.mock("../../computer-use-node-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../computer-use-node-capabilities.js")>()),
  loadPairedComputerUseAvailabilityForSurface: discovery.load,
}));

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt abort races", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    discovery.load.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { stage: "projection", cleanupFails: false },
    { stage: "construction", cleanupFails: true },
  ])(
    "joins cleanup after $stage fails (cleanupFails=$cleanupFails)",
    async ({ stage, cleanupFails }) => {
      const preparationError = new Error("tool preparation failed");
      const held = createDeferred();
      const started = createDeferred();
      const cleanupScope = createAgentCleanupScope();
      let toolSignal: AbortSignal | undefined;
      const cleanup = vi.fn(async (_reason: string) => {
        started.resolve();
        await held.promise;
        if (cleanupFails) {
          throw new Error("registered resource teardown failed");
        }
      });
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options: unknown) => {
        const toolOptions = options as {
          abortSignal: AbortSignal;
          registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => void;
        };
        toolSignal = toolOptions.abortSignal;
        toolOptions.registerRunCleanup(cleanup);
        if (stage === "construction") {
          throw preparationError;
        }
        return [
          {
            get name(): string {
              throw preparationError;
            },
          },
        ];
      });
      const attempt = cleanupScope.run(() =>
        createContextEngineAttemptRunner({
          contextEngine: createContextEngineBootstrapAndAssemble(),
          sessionKey: "agent:main:triage:failed-tool-preparation",
          tempPaths,
          attemptOverrides: {
            oneShotCliRun: true,
            disableTools: false,
            forceRestartSafeTools: stage === "projection",
          },
        }),
      );
      let settled = false;
      const result = attempt
        .then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      try {
        expect(
          await Promise.race([
            started.promise.then(() => "cleanup-started"),
            result.then((outcome) => outcome.kind),
          ]),
        ).toBe("cleanup-started");
        expect(settled).toBe(false);
        expect(toolSignal?.aborted).toBe(true);
        expect(cleanup).toHaveBeenCalledExactlyOnceWith("error");
        held.resolve();
        const outcome = await result;
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind === "rejected") {
          expect(outcome.error).toBe(preparationError);
        }
        expect(cleanupScope.outcome).toBe(cleanupFails ? "uncertain" : "closed");
        expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await result;
      }
    },
  );

  it("bounds registered one-shot cleanup after a completed turn", async () => {
    const held = createDeferred();
    const started = createDeferred();
    const cleanupScope = createAgentCleanupScope();
    hoisted.createOpenClawCodingToolsMock.mockImplementation((options: unknown) => {
      (
        options as { registerRunCleanup: (cleanup: () => Promise<void>) => void }
      ).registerRunCleanup(async () => {
        started.resolve();
        await held.promise;
      });
      return [];
    });
    const attempt = cleanupScope.run(() =>
      createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:triage:cleanup",
        tempPaths,
        sessionPrompt: async () => {
          vi.useFakeTimers();
        },
        attemptOverrides: { oneShotCliRun: true, disableTools: false },
      }),
    );
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cleanupScope.outcome).toBe("uncertain");
      expect((await attempt).terminal).toEqual({ kind: "ok" });
    } finally {
      held.resolve();
      await attempt;
      vi.useRealTimers();
    }
  });

  it("preserves a run-budget timeout when abort blocks prompt submission", async () => {
    let releasePendingEvents!: () => void;
    const pendingEvents = new Promise<void>((resolve) => {
      releasePendingEvents = resolve;
    });
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("missing embedded subscription mock");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => ({
      ...baseSubscribe(params),
      waitForPendingEvents: async () => await pendingEvents,
    }));

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:timeout",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: {
        timeoutMs: 20,
        onAttemptTimeout: () => releasePendingEvents(),
      },
    });

    // The abort-blocked prompt release no longer unwinds the attempt: the run
    // settles so after-turn side effects still fire, and the run-budget
    // timeout attribution survives on the resolved terminal.
    const result = await attempt;

    expect(result.terminal).toMatchObject({ kind: "timeout" });
    expect(buildAgentRunTerminalOutcomeFromAttempt({ terminal: result.terminal })).toMatchObject({
      status: "timeout",
    });
  });

  it.each([
    { label: "cancellation", timeout: false },
    { label: "timeout", timeout: true },
  ])(
    "does not create attempt resources after external $label during paired-computer discovery",
    async ({ timeout }) => {
      const releaseDiscovery = createDeferred<undefined>();
      const abortController = new AbortController();
      const reason = new Error(
        timeout
          ? "timed out during paired-computer discovery"
          : "cancelled during paired-computer discovery",
      );
      reason.name = timeout ? "TimeoutError" : "AbortError";
      let discoverySignal: AbortSignal | undefined;
      discovery.load.mockImplementation((input) => {
        discoverySignal = input.signal;
        return releaseDiscovery.promise;
      });
      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:triage:deferred-computer",
        tempPaths,
        sessionPrompt: async () => {},
        attemptOverrides: {
          abortSignal: abortController.signal,
          config: { tools: { codeMode: true } },
          disableTools: false,
          forceCodeModeTools: true,
        },
      });
      const outcome = Promise.allSettled([attempt]);
      try {
        await vi.waitFor(() => expect(discovery.load).toHaveBeenCalledOnce());
        expect(discoverySignal).toBeDefined();
        abortController.abort(reason);
        // Observe forwarding while discovery still owns the await; a later
        // preparation checkpoint alone must not satisfy cancellation.
        expect(discoverySignal?.aborted).toBe(true);
        expect(discoverySignal?.reason).toBe(reason);
        releaseDiscovery.resolve(undefined);
        const [result] = await outcome;
        assert(result?.status === "rejected");
        if (timeout) {
          assert(result.reason instanceof AgentRunTerminalOutcomeError);
          expect(result.reason.cause).toBe(reason);
          expect(result.reason.terminalOutcome).toMatchObject({ status: "timeout" });
        } else {
          expect(result.reason).toBe(reason);
        }
        expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
        expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
      } finally {
        releaseDiscovery.resolve(undefined);
        await outcome;
      }
    },
  );

  it("propagates an ordinary paired-computer discovery failure without creating resources", async () => {
    const reason = new Error("paired-computer discovery failed");
    let discoverySignal: AbortSignal | undefined;
    discovery.load.mockImplementation((input) => {
      discoverySignal = input.signal;
      throw reason;
    });
    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:triage:failed-computer",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: {
        config: { tools: { codeMode: true } },
        disableTools: false,
        forceCodeModeTools: true,
      },
    });
    const outcome = Promise.allSettled([attempt]);
    try {
      const [result] = await outcome;
      assert(result?.status === "rejected");
      expect(result.reason).toBe(reason);
      expect(discoverySignal?.aborted).toBe(false);
      expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
      expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
    } finally {
      await outcome;
    }
  });
});
