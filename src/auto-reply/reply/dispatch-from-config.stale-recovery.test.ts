import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { readReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let createReplyOperation: typeof import("../../sessions/session-controller.js").createReplyOperation;
let getSessionControllerOperation: typeof import("../../sessions/session-controller.js").getSessionControllerOperation;
let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

const sessionKey = "agent:main:telegram:direct:1";

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

function createVisibleDispatchParams(
  replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]>,
) {
  return {
    ctx: buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1",
      ChatType: "direct",
      SessionKey: sessionKey,
      MessageThreadId: "501.000",
      BodyForAgent: "second telegram direct turn",
    }),
    cfg: {} as OpenClawConfig,
    dispatcher: createDispatcher(),
    replyResolver,
  };
}

describe("dispatchReplyFromConfig stale visible admission recovery", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ createReplyOperation, getSessionControllerOperation } =
      await import("../../sessions/session-controller.js"));
    ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset();
    setNoAbort();
  });

  afterEach(() => {
    vi.useRealTimers();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
  });

  it("waits for fresh visible reply work without invoking diagnostic recovery", async () => {
    vi.useFakeTimers();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    activeOperation.abortSignal.addEventListener("abort", () => activeOperation.complete(), {
      once: true,
    });
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    // Dispatch may prepare queue policy while occupied; execution must use the selector.
    const dispatchParams = createVisibleDispatchParams(async (_ctx, options) =>
      withSessionTurn(
        {
          sessionKey,
          sessionId:
            readReplySourceInput(options)?.claim?.operation?.sessionId ?? activeOperation.sessionId,
          controllerInput: readReplySourceInput(options),
          abortSignal: options?.abortSignal,
        },
        () => replyResolver(),
      ),
    );
    let settled = false;

    const resultPromise = dispatchReplyFromConfig(dispatchParams).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(settled).toBe(false);
    expect(replyResolver).not.toHaveBeenCalled();

    activeOperation.complete();
    const result = await resultPromise;

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("waits for stale pre-backend producer settlement after cleanup expires", async () => {
    vi.useFakeTimers();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    // Dispatch may prepare queue policy while occupied; execution must use the selector.
    const dispatchParams = createVisibleDispatchParams(async (_ctx, options) =>
      withSessionTurn(
        {
          sessionKey,
          sessionId:
            readReplySourceInput(options)?.claim?.operation?.sessionId ?? activeOperation.sessionId,
          controllerInput: readReplySourceInput(options),
          abortSignal: options?.abortSignal,
        },
        () => replyResolver(),
      ),
    );
    vi.setSystemTime(activeOperation.watchdog.snapshot().semanticDeadlineAtMs);

    let settled = false;
    const resultPromise = dispatchReplyFromConfig(dispatchParams).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(getSessionControllerOperation(sessionKey)).toBe(activeOperation);

    await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_CLEANUP_MS);
    expect(settled).toBe(false);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(sessionKey)).toBe(activeOperation);
    expect(activeOperation.watchdog.snapshot().recovery?.status).toBe("blocked");
    activeOperation.complete();
    const result = await resultPromise;

    expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("sends truthful stalled feedback when the watchdog stops the active reply", async () => {
    vi.useFakeTimers();
    let resolverStarted: () => void = () => {};
    const resolverStartedPromise = new Promise<void>((resolve) => {
      resolverStarted = resolve;
    });
    const dispatchParams = createVisibleDispatchParams(async (_ctx, options) => {
      resolverStarted();
      await new Promise<void>((resolve) => {
        options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const error = new Error("reply expired");
      error.name = "AbortError";
      throw error;
    });

    const dispatchPromise = dispatchReplyFromConfig(dispatchParams);
    await resolverStartedPromise;
    const operation = getSessionControllerOperation(sessionKey);
    expect(operation).toBeDefined();
    if (!operation) {
      throw new Error("Expected the active dispatch owner");
    }
    vi.setSystemTime(operation.watchdog.snapshot().semanticDeadlineAtMs);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
      isError: true,
    });
  });
});
