import { expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as sessionAdmission from "../../../sessions/session-controller.admission.js";
import type { SessionControllerInput } from "../../../sessions/session-controller.mailbox.js";
import { assertSessionControllerOperation } from "../../../sessions/session-controller.state.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent-runner/types.js";
import { settleRequesterRun } from "../../requester-run-settlement.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as registryPersistence from "./subagent-registry-persistence.js";
import * as registry from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

// Failed terminal persistence must resume this still-unfinished cleanup owner.
async function driftCompletionCleanup(entry: SubagentRunRecord): Promise<void> {
  expect(entry.cleanupHandled).toBe(true);
  expect(entry.cleanupCompletedAt).toBeUndefined();
  const failed = vi.fn(async () => {
    throw new Error("Synthetic terminal completion refusal");
  });
  const resume = vi.fn();
  const recovery = createSubagentRegistryCompletionRuntime({
    runs: subagentRuns,
    resumed: new Set([getSubagentRunRuntimeKey(entry)]),
    retryTimers: new Set(),
    completeSubagentRun: failed,
    scheduleSweep: vi.fn(),
    resumeRun: resume,
    warn: vi.fn(),
  });
  await recovery.completeSubagentRunWithRecovery(
    {
      runId: entry.runId,
      expectedEntry: entry,
      outcome: { status: "ok" },
      reason: "subagent-complete",
      triggerCleanup: true,
    },
    "requester-wake-ack-proof",
  );
  expect(failed).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledWith(entry.runId);
  expect(subagentRuns.get(entry.runId)?.cleanupHandled).toBe(false);
}

/** Starts same-owner recovery and observes its FIFO writer reservation. */
export function queueCompletionCleanupDrift(entry: SubagentRunRecord) {
  const queued = createDeferred();
  const mutate = registryPersistence.mutateSubagentRuns;
  vi.spyOn(registryPersistence, "mutateSubagentRuns").mockImplementation((...args) => {
    const result = mutate(...args);
    if (args[0].length === 1 && args[0][0] === entry.runId) {
      queued.resolve();
    }
    return result;
  });
  const completed = driftCompletionCleanup(entry);
  void completed.catch(() => {});
  return { queued: queued.promise, completed };
}

/** Holds one admitted requester while its children reserve their completion turns. */
export function createRequesterTurnSettlement(params: {
  requesterFirst: boolean;
  requesterSessionKey: string;
  requesterTurnRunId: string;
  children: AcceptedSessionSpawn[];
}) {
  const { requesterFirst, requesterSessionKey, requesterTurnRunId, children } = params;
  const admitted = createDeferred();
  const queued = createDeferred();
  const allowYield = createDeferred();
  const inputs = new Map<string, SessionControllerInput>();
  if (requesterFirst) {
    const admit = sessionAdmission.withSessionTurn;
    vi.spyOn(sessionAdmission, "withSessionTurn").mockImplementation((turn, run) => {
      const result = admit(turn, run);
      // Observe real Gateway adoption and task submission, not reservation alone.
      for (const child of children) {
        const entry = registry.getSubagentRunByRunId(child.runId);
        const input = turn.controllerInput;
        if (
          entry &&
          input?.protocolRunId ===
            buildAnnounceIdempotencyKey(buildAnnounceIdFromChildRun(entry.runId, entry.generation))
        ) {
          expect(input.custody.rpcAdopted).toBe(true);
          expect(input.phase).toBe("waiting");
          expect(input.claim).toBeUndefined();
          inputs.set(child.runId, input);
        }
      }
      if (children.every((child) => inputs.has(child.runId))) {
        queued.resolve();
      }
      return result;
    });
  }
  const yieldTool = createSessionsYieldTool({
    sessionId: "sess-main",
    claimYield: async () =>
      (await registry.markRequesterTurnYielded({
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId,
      })) > 0,
    onYield: () => {},
  });
  const yieldRequester = async () => {
    await expect(
      yieldTool.execute("yield-requester-wake", { message: "Wait for visible children" }),
    ).resolves.toMatchObject({ details: { status: "yielded" } });
  };
  const result: EmbeddedAgentRunResult = {
    acceptedSessionSpawns: children,
    meta: {
      durationMs: 1,
      yielded: true,
      executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
    },
  };
  const start = () =>
    sessionAdmission.withSessionTurn(
      { sessionId: "sess-main", sessionKey: requesterSessionKey, agentId: "main" },
      async (operation) => {
        if (!operation) {
          throw new Error("Requester settlement requires its admitted controller turn");
        }
        admitted.resolve();
        if (requesterFirst) {
          await allowYield.promise;
          await yieldRequester();
        }
        // Logical run settlement borrows this turn's live controller authority.
        await settleRequesterRun(
          { sessionKey: requesterSessionKey, agentId: "main", runId: requesterTurnRunId },
          result,
          () => assertSessionControllerOperation(operation),
        );
      },
    );
  return {
    result,
    inputs,
    admitted: admitted.promise,
    queued: queued.promise,
    release: () => allowYield.resolve(),
    yieldRequester,
    start,
  };
}
