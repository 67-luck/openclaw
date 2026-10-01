import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as withdrawal from "../../config/sessions/session-pending-input-withdrawal.js";
import { isRpcSourceQueued } from "../../sessions/session-controller.rpc-sources.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadSessionEntry: () => ({
    entry: { sessionId: "main-session" },
    storePath: "/synthetic/withdrawal/sessions.json",
  }),
}));

describe("chat.abort exact controller input withdrawal", () => {
  it.each(["rejected", "committed and revoked"] as const)(
    "retains atomic input custody when the write is %s",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      const input = createActiveRun("main", {
        sessionId: "main-session",
        agentId: "main",
        queued: true,
        runId: " source ",
      });
      const context = createChatAbortContext({
        rpcSources: new Map([[" source ", input]]),
        getSessionEventSubscriberConnIds: () => new Set(),
      });
      let current = true;
      const discard = vi
        .spyOn(withdrawal, "discardSessionPendingInput")
        .mockImplementation(async (_scope, runId, assertCurrent) => {
          expect(runId).toBe(" source ");
          assertCurrent();
          entered.resolve();
          await release.promise;
          assertCurrent();
          if (outcome === "rejected") {
            throw new Error("write refused");
          }
          current = false;
          return true;
        });
      const stopping = invokeChatAbortHandler({
        handler: (options) =>
          handleChatAbortRequestWithLifecycle({
            ...options,
            hasCurrentClientAuthority: () => current,
          }),
        context,
        request: { sessionKey: "main", runId: " source ", discardPendingInput: true },
        client: { connect: { scopes: ["operator.admin"] } },
      });
      try {
        await entered.promise;
        expect(input.input.withdrawalHolds).toBe(1);
        expect(input.input.abortSignal.aborted).toBe(false);
        release.resolve();
        if (outcome === "rejected") {
          await expect(stopping).rejects.toThrow("write refused");
          expect(isRpcSourceQueued(input)).toBe(true);
          expect(input.input.abortSignal.aborted).toBe(false);
        } else {
          const respond = await stopping;
          expect(input.input.abortSignal.aborted).toBe(true);
          expect(respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [" source "],
          });
        }
        expect(input.input.withdrawalHolds).toBe(0);
      } finally {
        release.resolve();
        await stopping.catch(() => {});
        discard.mockRestore();
      }
    },
  );

  it("never withdraws an execution claim or a byte-distinct protocol run", async () => {
    const source = createRpcSourceForTest(
      {
        sessionKey: "main",
        sessionId: "main-session",
        agentId: "main",
      },
      { runId: " source " },
    );
    const release = await claimRpcSourceForTest(source);
    const context = createChatAbortContext({ rpcSources: new Map([[" source ", source]]) });
    const discard = vi.spyOn(withdrawal, "discardSessionPendingInput");
    try {
      for (const runId of ["source", " source "]) {
        const respond = await invokeChatAbortHandler({
          handler: handleChatAbortRequestWithLifecycle,
          context,
          request: { sessionKey: "main", runId, discardPendingInput: true },
          client: { connect: { scopes: ["operator.admin"] } },
        });
        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
      }
      expect(discard).not.toHaveBeenCalled();
      expect(source.input.abortSignal.aborted).toBe(false);
    } finally {
      release();
      discard.mockRestore();
    }
  });
});
