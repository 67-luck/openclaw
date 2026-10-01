import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import * as lifecycle from "../../sessions/session-controller.lifecycle.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));
import { emitSessionsChanged } from "./session-change-event.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

describe("chat interrupt acknowledgement", () => {
  it.each(["chat.send", "sessions.send", "frozen"] as const)(
    "acknowledges %s without waiting for predecessor settlement",
    async (method) => {
      const fixture = await createFixture();
      const active = fixture.activeRun;
      if (!active) {
        throw new Error("Expected an active fixture run");
      }
      const cleanup = createDeferred();
      active.registerExecutionCleanup(() => cleanup.promise);
      const settled = vi.fn();
      void active.ownerSettlement.then(settled);
      const cancel = vi.fn();
      active.attachBackend({ kind: "embedded", cancel });
      if (method === "frozen") {
        active.freezeAbort();
      }
      fixture.params.queueMode = "interrupt";
      const effectEntered = createDeferred();
      const begin = lifecycle.beginSessionEffect;
      const observeEffect = vi
        .spyOn(lifecycle, "beginSessionEffect")
        .mockImplementation((params) => {
          effectEntered.resolve();
          return begin(params);
        });
      const respond = vi.fn<RespondFn>();
      let sending: Promise<unknown> | undefined;
      vi.useFakeTimers();
      try {
        if (method === "sessions.send") {
          const cfg = fixture.context.getRuntimeConfig();
          fixture.context.getRuntimeConfig = () => ({
            ...cfg,
            messages: { ...cfg.messages, queue: { mode: "interrupt" } },
          });
          const handler = sessionMessagingHandlers["sessions.send"];
          if (!handler) {
            throw new Error("Expected sessions.send handler");
          }
          sending = Promise.resolve(
            handler({
              params: {
                key: fixture.scope.sessionKey,
                message: fixture.params.message,
                idempotencyKey: fixture.params.idempotencyKey,
              },
              req: { type: "req", id: "interrupt", method: "sessions.send" },
              client: fixture.client,
              context: fixture.context,
              respond,
              isWebchatConnect: () => true,
            } satisfies GatewayRequestHandlerOptions),
          );
        } else {
          sending = fixture.send(respond);
        }
        await effectEntered.promise;
        expect(cancel).toHaveBeenCalledTimes(method === "frozen" ? 0 : 1);
        expect(active.abortSignal.aborted).toBe(method !== "frozen");
        await sending;
        expect(settled).not.toHaveBeenCalled();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        const payload = respond.mock.calls[0]?.[1];
        expect(payload).toMatchObject({ status: "started" });
        if (method === "frozen") {
          expect(payload).not.toHaveProperty("interruptedActiveRun");
        } else {
          expect(payload).toHaveProperty("interruptedActiveRun", true);
        }
        if (method === "sessions.send") {
          expect(emitSessionsChanged).toHaveBeenCalledWith(
            fixture.context,
            expect.objectContaining({ sessionKey: fixture.scope.sessionKey, reason: "steer" }),
          );
        }
      } finally {
        cleanup.resolve();
        active.complete();
        fixture.releaseDispatch();
        await sending;
        observeEffect.mockRestore();
        await fixture.cleanup();
        vi.useRealTimers();
      }
    },
    10_000,
  );
});
