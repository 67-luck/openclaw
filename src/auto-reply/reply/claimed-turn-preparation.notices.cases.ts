import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { ClaimedTurnNoticeFixture } from "./claimed-turn-preparation.test.js";

export function registerClaimedTurnNoticeCases({
  state,
  createOperation,
  createRun,
  createDefaults,
  prepareClaimedReplyTurn,
}: ClaimedTurnNoticeFixture) {
  it("rechecks send policy before an in-preflight compaction notice", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const deniedEntry: SessionEntry = { ...initialEntry, updatedAt: 2 };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValueOnce(initialEntry).mockReturnValue(deniedEntry);
    state.resolveSendPolicy.mockImplementation(({ entry }) =>
      entry === deniedEntry ? "deny" : "allow",
    );
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return deniedEntry;
    });

    await prepareClaimedReplyTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      onCompactionNoticePayload,
    });

    expect(onCompactionNoticePayload).not.toHaveBeenCalled();
    expect(state.resolveSendPolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({ entry: deniedEntry }),
    );
  });

  it("delivers a terminal compaction notice after adopting its rotated generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      sessionStore.main = rotatedEntry;
      await onCompactionNotice?.("end");
      return rotatedEntry;
    });

    const result = await prepareClaimedReplyTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      onCompactionNoticePayload,
    });

    expect(result).toMatchObject({ kind: "admitted" });
    expect(onCompactionNoticePayload).toHaveBeenCalledWith(
      { text: "end" },
      expect.objectContaining({
        sendPolicy: "allow",
        queued: expect.objectContaining({
          run: expect.objectContaining({ sessionId: "compacted-session" }),
        }),
      }),
    );
  });

  it("releases the admitted operation when deferred terminal notice delivery fails", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const failure = new Error("notice delivery failed");
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return initialEntry;
    });

    await expect(
      prepareClaimedReplyTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry }),
        onCompactionNoticePayload: vi.fn(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("delivers an incomplete terminal notice after ordinary preflight failure", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("start");
      await onCompactionNotice?.("incomplete");
      throw new Error("preflight failed");
    });

    const result = await prepareClaimedReplyTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry }),
      onCompactionNoticePayload,
    });

    expect(result).toMatchObject({ kind: "admitted", turn: { preflightFailurePayload: {} } });
    expect(onCompactionNoticePayload).toHaveBeenCalledTimes(2);
    expect(onCompactionNoticePayload).toHaveBeenNthCalledWith(
      1,
      { text: "start" },
      expect.anything(),
      "start",
    );
    expect(onCompactionNoticePayload).toHaveBeenNthCalledWith(
      2,
      { text: "incomplete" },
      expect.anything(),
    );
  });
}
