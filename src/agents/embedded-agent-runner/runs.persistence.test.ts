import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

describe("embedded-agent runner persistence", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("does not fabricate persisted terminal state while the cancelled native producer still owns cleanup", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-native-custody-" },
      async (state) => {
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const sessionKey = "agent:main:native-custody";
        const entry = {
          lifecycleRunId: "stuck-run",
          sessionId: "session-stuck",
          startedAt: 10,
          status: "running" as const,
          updatedAt: 20,
        };
        await replaceSessionEntry({ storePath, sessionKey }, entry);
        const startedAt = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
        const operation = createReplyOperation({
          sessionKey,
          sessionId: entry.sessionId,
          target: captureSessionTarget({
            storeScope: storePath,
            sessionKey,
            incarnation: entry.sessionId,
          }),
          resetTriggered: false,
        });
        operation.setPhase("running");
        const abort = vi.fn();
        const handle = createEmbeddedRunHandle({ runId: entry.lifecycleRunId, abort });
        setActiveEmbeddedRun(entry.sessionId, handle, sessionKey, undefined, "main", operation);
        try {
          clock.mockReturnValue(startedAt + 6 * 60_000);
          expect(
            await abortAndDrainEmbeddedAgentRun({
              sessionId: entry.sessionId,
              sessionKey,
              settleMs: 0,
              forceClear: true,
              reason: "stuck_recovery",
            }),
          ).toMatchObject({ aborted: true, drained: false, forceCleared: false });
          expect(abort).toHaveBeenCalledOnce();
          expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(entry);
        } finally {
          clearActiveEmbeddedRun(entry.sessionId, handle, sessionKey);
          operation.complete();
          await operation.ownerSettlement;
        }
      },
    );
  });
});
