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
  resolveSessionTranscriptRuntimeTarget: vi.fn(),
  stageSessionPendingInput: vi.fn(),
  persistInboundImagesForTranscript: vi.fn(),
  deleteMediaBuffer: vi.fn(),
  persistedMessages: [] as unknown[],
  beforeTranscriptCommit: undefined as (() => void) | undefined,
}));

vi.mock("../chat-attachments.js", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-attachments.js")>("../chat-attachments.js");
  return { ...actual, persistInboundImagesForTranscript: mocks.persistInboundImagesForTranscript };
});

vi.mock("../../media/store.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../media/store.js")>("../../media/store.js");
  return { ...actual, deleteMediaBuffer: mocks.deleteMediaBuffer };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return { ...actual, loadSessionEntry: mocks.loadSessionEntry };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    persistSessionTranscriptTurn: mocks.persistSessionTranscriptTurn,
    resolveSessionTranscriptRuntimeTarget: mocks.resolveSessionTranscriptRuntimeTarget,
    stageSessionPendingInput: mocks.stageSessionPendingInput,
  };
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
    mocks.resolveSessionTranscriptRuntimeTarget.mockReset().mockResolvedValue({});
    mocks.persistInboundImagesForTranscript.mockReset().mockResolvedValue({ entries: [] });
    mocks.deleteMediaBuffer.mockReset().mockResolvedValue(undefined);
    mocks.persistedMessages.length = 0;
    mocks.beforeTranscriptCommit = undefined;
    mocks.stageSessionPendingInput.mockReset().mockImplementation(async (_scope, options) => {
      options.assertCurrent();
      const message = options.prepareMessageAfterIdempotencyCheck
        ? options.prepareMessageAfterIdempotencyCheck(options.message)
        : options.message;
      if (!message) {
        return undefined;
      }
      mocks.beforeTranscriptCommit?.();
      options.assertCurrent();
      mocks.persistedMessages.push(message);
      return {
        inputId: "pending-user-turn",
        message,
        run: <T>(operation: () => T) => operation(),
        finish: vi.fn(),
      };
    });
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

  it("does not stage the user turn when delegated runtime authority closes at commit", async () => {
    const sessionKey = "agent:main:worker-child";
    const admittedSessionId = "worker-child-session";
    const sessionEntry: SessionEntry = { sessionId: admittedSessionId, updatedAt: 1 };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry: sessionEntry,
      store: { [sessionKey]: sessionEntry },
    });
    let authorityActive = true;
    mocks.beforeTranscriptCommit = () => {
      authorityActive = false;
    };

    await expect(
      prepareAgentRunUserTurn({
        request: { message: "must not outlive the worker turn", idempotencyKey: "closed-run" },
        cfg: {},
        sessionEntry,
        resolvedSessionKey: sessionKey,
        admittedSessionId,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "must not outlive the worker turn",
        effectiveTranscriptInputText: "must not outlive the worker turn",
        images: [],
        offloadedRefs: [],
        runId: "closed-run",
        client: null,
        context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
        assertCurrent: () => {
          if (!authorityActive) {
            throw new TypeError("agent runtime authority is no longer active");
          }
        },
      }),
    ).rejects.toThrow("agent runtime authority is no longer active");
    expect(mocks.persistedMessages).toEqual([]);
  });

  it("deletes persisted media when delegated runtime authority closes during persistence", async () => {
    const sessionKey = "agent:main:worker-child";
    const sessionEntry: SessionEntry = { sessionId: "revoked-media-session", updatedAt: 1 };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      entry: sessionEntry,
      store: { [sessionKey]: sessionEntry },
    });
    let authorityActive = true;
    mocks.persistInboundImagesForTranscript.mockImplementationOnce(async () => {
      authorityActive = false;
      return { entries: [{ id: "revoked-media", fact: {} }] };
    });

    await expect(
      prepareAgentRunUserTurn({
        request: { message: "private image", idempotencyKey: "revoked-media-run" },
        cfg: {},
        sessionEntry,
        resolvedSessionKey: sessionKey,
        admittedSessionId: "revoked-media-session",
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "private image",
        effectiveTranscriptInputText: "private image",
        images: [],
        offloadedRefs: [],
        runId: "revoked-media-run",
        client: null,
        context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
        assertCurrent: () => {
          if (!authorityActive) {
            throw new TypeError("agent runtime authority is no longer active");
          }
        },
      }),
    ).rejects.toThrow("agent runtime authority is no longer active");
    expect(mocks.deleteMediaBuffer).toHaveBeenCalledWith("revoked-media", "inbound");
    expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
    expect(mocks.resolveSessionTranscriptRuntimeTarget).not.toHaveBeenCalled();
    expect(mocks.stageSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.persistedMessages).toEqual([]);
  });
});
