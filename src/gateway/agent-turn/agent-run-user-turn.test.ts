import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as execApprovalState from "../../agents/bash-tools.exec-approval-followup-state.js";
import type { SessionEntry } from "../../config/sessions.js";
import { SessionPendingInputSettlementUnknownError } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import * as userTurnTranscript from "../../sessions/user-turn-transcript.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import {
  prepareAgentRunUserTurn,
  reconcileAgentRunUserTurnCompletion,
  releasePreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return { ...actual, loadSessionEntry: mocks.loadSessionEntry };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return { ...actual, persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn };
});

describe("prepareAgentRunUserTurn", () => {
  it.each(
    (["sync", "async"] as const).flatMap((delivery) =>
      (["primary", "cleanup", "unknown"] as const).map((failure) => ({ delivery, failure })),
    ),
  )(
    "preserves $delivery pending-input failure and handoff custody ($failure)",
    async ({ delivery, failure }) => {
      const primary =
        failure === "unknown"
          ? new SessionPendingInputSettlementUnknownError(new Error("native receipt lost"))
          : new Error("pending input settlement failed");
      const releaseFailure = new Error("handoff release failed");
      const gate = createDeferred();
      const observerReleased = vi.fn();
      const recorder = userTurnTranscript.createUserTurnTranscriptRecorder({
        input: { text: "retained input", timestamp: 1 },
        target: {
          agentId: "main",
          sessionId: "release-session",
          sessionKey: "agent:main:release",
          sessionEntry: undefined,
        },
      });
      const finish = vi
        .spyOn(userTurnTranscript, "finishUserTurnPendingInput")
        .mockImplementation((selected, disposition) => {
          expect(selected).toBe(recorder);
          expect(disposition).toBe("interrupted");
          if (delivery === "sync") {
            throw primary;
          }
          return gate.promise;
        });
      const release = vi
        .spyOn(execApprovalState, "releaseExecApprovalFollowupRuntimeHandoff")
        .mockImplementation(() => {
          if (failure === "cleanup") {
            throw releaseFailure;
          }
          return true;
        });
      let completion: void | Promise<void> = undefined;
      let observed: { error: unknown } | undefined;
      try {
        try {
          completion = releasePreparedAgentRunUserTurn({
            message: "retained input",
            senderIsOwner: false,
            suppressPromptPersistence: false,
            claimedExecApprovalFollowupHandoffId: "handoff",
            execApprovalFollowupHandoffClaimId: "claim",
            recorder,
            releaseProcessingAbortObserver: observerReleased,
          });
        } catch (error) {
          observed = { error };
        }
        expect(observerReleased).toHaveBeenCalledOnce();
        expect(finish).toHaveBeenCalledOnce();
        if (delivery === "async") {
          expect(completion).toBeInstanceOf(Promise);
          expect(observed).toBeUndefined();
          expect(release).not.toHaveBeenCalled();
          const settled = Promise.resolve(completion).catch((error: unknown) => {
            observed = { error };
          });
          gate.reject(primary);
          await settled;
        } else {
          expect(completion).toBeUndefined();
        }
        expect(observed).toBeDefined();
        if (failure === "cleanup") {
          expect(observed?.error).toBeInstanceOf(AggregateError);
          if (!(observed?.error instanceof AggregateError)) {
            throw new Error("pending-input and handoff failures lost their aggregate");
          }
          expect(observed.error.errors).toEqual([primary, releaseFailure]);
          expect(observed.error.errors[0]).toBe(primary);
          expect(observed.error.errors[1]).toBe(releaseFailure);
        } else {
          expect(observed?.error).toBe(primary);
        }
        expect(release).toHaveBeenCalledTimes(failure === "unknown" ? 0 : 1);
        if (failure !== "unknown") {
          expect(release).toHaveBeenCalledWith({ handoffId: "handoff", claimId: "claim" });
        }
      } finally {
        gate.resolve();
        await Promise.allSettled([completion]);
        finish.mockRestore();
        release.mockRestore();
      }
    },
  );

  it("keeps no-receipt completion reconciliation synchronous before acceptance", () => {
    const cleanup = vi.fn(async () => {});
    const emitAcceptance = vi.fn();
    const result = reconcileAgentRunUserTurnCompletion(
      {
        message: "input",
        senderIsOwner: false,
        suppressPromptPersistence: false,
        execApprovalFollowupHandoffClaimId: "claim",
      },
      { runId: "run" },
      cleanup,
      { emitAcceptance } as unknown as AgentTurnIo,
    );
    expect(result).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(emitAcceptance).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    mocks.loadSessionEntry.mockReset();
    mocks.persistSessionTranscriptTurn.mockReset().mockImplementation(async (scope, options) => {
      const message = options.messages[0]?.message;
      return {
        appendedCount: 1,
        messages: [
          {
            appended: true,
            messageId: "stale-user-turn",
            message,
            anchor: {
              agentId: scope.agentId ?? "main",
              sessionId: scope.sessionId,
              sessionKey: scope.sessionKey,
              storePath: scope.storePath,
              generation: "test-generation",
              entryId: "stale-user-turn",
              rawSeq: 1,
              effectiveParentId: null,
              activeMessagePosition: 0,
            },
          },
        ],
        sessionEntry: scope.sessionEntry,
      };
    });
  });

  it("fails closed when the admitted session entry disappeared before transcript persistence", async () => {
    const sessionKey = "agent:main:main";
    const admittedSessionId = "admitted-session";
    const sessionEntry: SessionEntry = {
      sessionId: admittedSessionId,
      updatedAt: 1,
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry: undefined,
      store: {},
    });

    await expect(
      prepareAgentRunUserTurn({
        assertCurrent: () => {},
        request: {
          message: "must not reach the stale session",
          idempotencyKey: "disappeared-session-run",
        } as AgentRunRequest,
        cfg: {},
        sessionEntry,
        resolvedSessionKey: sessionKey,
        admittedSessionId,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "must not reach the stale session",
        effectiveTranscriptInputText: "must not reach the stale session",
        images: [],
        offloadedRefs: [],
        runId: "disappeared-session-run",
        client: null,
        context: {
          logGateway: { warn: vi.fn() },
        } as unknown as AgentTurnContext,
      }),
    ).rejects.toThrow("agent turn was not durably admitted");
    expect(mocks.persistSessionTranscriptTurn).not.toHaveBeenCalled();
  });
});
