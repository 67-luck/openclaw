import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { spawnSubagentDirect } from "../agents/subagents/spawn/subagent-spawn.js";
import * as spawnRuntime from "../agents/subagents/spawn/subagent-spawn.runtime.js";
import * as swarmScheduler from "../agents/subagents/swarm/swarm-scheduler.js";
import {
  isSwarmRunActive,
  releaseSwarmRun,
  removeQueuedSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { readToolEffectReceipt, withToolEffectBoundary } from "../agents/tool-effect-receipt.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";

const { parentKey, launchedRunIds, requestContext, listChildren } = useQueuedCollectorFixture();

function pauseFirstRequesterLookup(failure?: Error) {
  const entered = createDeferred();
  const released = createDeferred();
  const readRequester = spawnRuntime.resolveGatewaySessionStoreTargetInWorker;
  const lookup = vi
    .spyOn(spawnRuntime, "resolveGatewaySessionStoreTargetInWorker")
    .mockImplementationOnce(async (params) => {
      const target = await readRequester(params);
      entered.resolve();
      await released.promise;
      if (failure) {
        throw failure;
      }
      return target;
    });
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    restore: () => lookup.mockRestore(),
  };
}

describe("collector FIFO before requester acquisition", () => {
  it.each(["current", "lookup failure", "cancelled", "invalid schema"] as const)(
    "retains invocation order while the first requester lookup is %s",
    async (outcome) => {
      const context = requestContext();
      await replaceSessionEntry(
        { agentId: "main", sessionKey: parentKey },
        { sessionId: "fifo-original-requester", updatedAt: 1 },
      );
      const gate = pauseFirstRequesterLookup(
        outcome === "lookup failure" ? new Error("requester lookup failed") : undefined,
      );
      const abort = new AbortController();
      const pending: Array<ReturnType<typeof spawnSubagentDirect>> = [];
      const spawn = (label: string, groupId: string) => {
        const operation = withToolEffectBoundary((onSpawnEffectsStart) =>
          spawnSubagentDirect(
            {
              task: "Preserve collector order",
              label,
              collect: true,
              context: "isolated",
              lightContext: true,
              groupId,
              ...(label === "first" && outcome === "invalid schema"
                ? { outputSchema: { type: "not-a-json-schema-type" } }
                : {}),
            },
            {
              agentSessionKey: parentKey,
              requesterRunId: "parent-turn",
              requesterTurnRunId: "parent-turn",
              onSpawnEffectsStart,
              ...(label === "first"
                ? {
                    assertActive: () => abort.signal.throwIfAborted(),
                  }
                : {}),
            },
          ),
        );
        pending.push(operation);
        return operation;
      };
      try {
        const first = spawn("first", "fifo");
        await Promise.race([
          gate.entered,
          first.then(() => {
            throw new Error("First spawn settled before requester lookup entered");
          }),
        ]);
        expect(subagentRuns.size).toBe(0);
        expect((await listChildren(context)).sessions).toEqual([]);
        await replaceSessionEntry(
          { agentId: "main", sessionKey: parentKey },
          { sessionId: "fifo-replacement-requester", updatedAt: 2 },
        );
        const second = await spawn("second", "fifo");
        expect(second.status).toBe("accepted");
        const secondRunId = expectDefined(second.runId, "second collector run");
        expect(isSwarmRunActive(secondRunId)).toBe(false);
        expect(launchedRunIds).toEqual([]);

        const independent = await spawn("independent", "other-group");
        expect(independent.status).toBe("accepted");
        const independentRunId = expectDefined(independent.runId, "independent collector run");
        await vi.waitFor(() => expect(launchedRunIds).toEqual([independentRunId]));
        if (outcome === "cancelled") {
          abort.abort(new Error("requester acquisition cancelled"));
        }
        gate.release();
        const result = await first;
        // An attempted reservation must not be labeled as never started.
        expect(readToolEffectReceipt(result)).toBeUndefined();
        if (outcome === "current") {
          expect(result.status).toBe("accepted");
          const firstRunId = expectDefined(result.runId, "first collector run");
          await vi.waitFor(() => expect(launchedRunIds).toEqual([independentRunId, firstRunId]));
          expect(subagentRuns.get(firstRunId)?.completionRequesterSessionId).toBe(
            "fifo-original-requester",
          );
          expect(releaseSwarmRun(firstRunId)).toBe(true);
          await vi.waitFor(() =>
            expect(launchedRunIds).toEqual([independentRunId, firstRunId, secondRunId]),
          );
        } else {
          expect(result.status).toBe("error");
          expect(result.error).toContain(
            outcome === "lookup failure"
              ? "requester lookup failed"
              : outcome === "cancelled"
                ? "requester acquisition cancelled"
                : "Invalid sessions_spawn outputSchema",
          );
          expect(result.childSessionKey).toBeUndefined();
          expect(
            (await listChildren(context)).sessions
              .map((row) => row.label)
              .toSorted((left, right) => String(left).localeCompare(String(right))),
          ).toEqual(["independent", "second"]);
          await vi.waitFor(() => expect(launchedRunIds).toEqual([independentRunId, secondRunId]));
        }
      } finally {
        gate.release();
        await Promise.allSettled(pending);
        gate.restore();
      }
    },
  );

  it("does not transfer or withdraw a replacement reservation after requester lookup", async () => {
    const gate = pauseFirstRequesterLookup();
    const reserve = vi.spyOn(swarmScheduler, "reserveSwarmRun");
    const pending: Array<ReturnType<typeof spawnSubagentDirect>> = [];
    const spawn = (label: string, replayKey?: string) => {
      const operation = spawnSubagentDirect(
        {
          task: "Keep exact reservation ownership",
          label,
          collect: true,
          context: "isolated",
          lightContext: true,
          groupId: "replacement",
          swarmLaunchReplayKey: replayKey,
        },
        {
          agentSessionKey: parentKey,
          requesterRunId: "parent-turn",
          requesterTurnRunId: "parent-turn",
        },
      );
      pending.push(operation);
      return operation;
    };
    try {
      const first = spawn("retired", "same-replay-id");
      await Promise.race([
        gate.entered,
        first.then(() => {
          throw new Error("First spawn settled before requester lookup entered");
        }),
      ]);
      const firstRunId = expectDefined(reserve.mock.calls[0]?.[0].runId, "first reservation");
      const second = await spawn("second");
      const secondRunId = expectDefined(second.runId, "second collector run");
      expect(isSwarmRunActive(secondRunId)).toBe(false);
      expect(removeQueuedSwarmRun(firstRunId)).toBe(true);
      await vi.waitFor(() => expect(launchedRunIds).toEqual([secondRunId]));
      const replacement = await spawn("replacement", "same-replay-id");
      expect(replacement).toMatchObject({ status: "accepted", runId: firstRunId });
      const replacementEntry = expectDefined(subagentRuns.get(firstRunId), "replacement record");
      gate.release();
      expect(await first).toEqual({
        status: "error",
        error: "Collector FIFO reservation is no longer current",
      });
      expect(subagentRuns.get(firstRunId)).toBe(replacementEntry);
      expect(isSwarmRunActive(firstRunId)).toBe(false);
      expect(releaseSwarmRun(secondRunId)).toBe(true);
      await vi.waitFor(() => expect(launchedRunIds).toEqual([secondRunId, firstRunId]));
    } finally {
      gate.release();
      await Promise.allSettled(pending);
      reserve.mockRestore();
      gate.restore();
    }
  });
});
