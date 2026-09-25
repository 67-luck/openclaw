import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { clearAgentRunContext, getAgentRunContext } from "../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { agentRunHandler } from "./agent-run-handler.js";
import * as chatSession from "./chat-send-session.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";

let ownedBody: Promise<void> | undefined;

// Vitest can abort its wrapper before the body's native joins and state cleanup.
// Join the original body before generic teardown without reporting its error twice.
afterEach(async () => {
  const completion = ownedBody;
  try {
    await Promise.allSettled([completion]);
  } finally {
    if (ownedBody === completion) {
      ownedBody = undefined;
    }
  }
});

it.for(["aborted", "routing-rejected"] as const)(
  "preserves a same-generation successor while original %s chat cleanup joins",
  (mode, { signal }) => {
    ownedBody = withOpenClawTestState({ scenario: "minimal" }, async () => {
      const runId = `chat-cleanup-successor-${mode}`;
      const sessionKey = `agent:main:${runId}`;
      const context = createDirectChatContext();
      const respond = vi.fn();
      const successorRespond = vi.fn();
      const closeEntered = createDeferred();
      const releaseClose = createDeferred();
      const successorEntered = createDeferred();
      const releaseSuccessor = createDeferred();
      const releaseGates = () => {
        releaseClose.resolve();
        releaseSuccessor.resolve();
      };
      const qualify = chatSession.qualifyChatSendSession;
      let holdClose = false;
      const closeTarget = vi.fn(async (close: () => Promise<void>) => {
        if (holdClose) {
          closeEntered.resolve();
          await releaseClose.promise;
        }
        await close();
      });
      const qualifySpy = vi
        .spyOn(chatSession, "qualifyChatSendSession")
        .mockImplementationOnce((loaded) => {
          const session = qualify(loaded);
          return {
            ...session,
            closeSessionTarget: () => closeTarget(session.closeSessionTarget),
          };
        });
      // Admission and its real registration run first. No provider work starts.
      const runtimeSpy = vi
        .spyOn(preparedRuntime, "loadPublishedGatewayReplyDispatchRuntime")
        .mockImplementationOnce(async () => {
          successorEntered.resolve();
          await releaseSuccessor.promise;
          return undefined;
        });
      let prepared: Awaited<ReturnType<typeof prepareAndAdmitChatSend>> = undefined;
      let creatingAdmission: ReturnType<typeof prepareAndAdmitChatSend> | undefined;
      let original: Promise<{ error?: unknown; ok: boolean }> | undefined;
      let successor: Promise<{ error?: unknown; ok: boolean }> | undefined;
      const failures: unknown[] = [];
      signal.addEventListener("abort", releaseGates, { once: true });
      try {
        signal.throwIfAborted();
        creatingAdmission = prepareAndAdmitChatSend({
          params: { agentId: "main", sessionKey, message: "original", idempotencyKey: runId },
          context,
          respond,
          client: null,
        });
        prepared = await racePromiseWithAbortSignal(creatingAdmission, signal);
        assert(prepared);
        const admission = prepared.admitted.value;
        const originalEntry = admission.activeRunAbort.entry;
        const originalContext = getAgentRunContext(runId);
        assert(originalEntry);
        assert(originalContext);
        expect(originalContext.lifecycleGeneration).toBe(admission.lifecycleGeneration);
        expect(context.chatAbortControllers.get(runId)).toBe(originalEntry);
        expect(abortChatRunById(createChatAbortOps(context), { runId, sessionKey })).toEqual({
          aborted: true,
        });
        expect(context.chatAbortControllers.has(runId)).toBe(false);
        holdClose = true;
        original = (
          mode === "aborted"
            ? admission.finishAbortedChatSend()
            : admission.rejectSessionRoutingChanged()
        ).then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        expect(
          await racePromiseWithAbortSignal(
            Promise.race([
              closeEntered.promise.then(() => "close-entered"),
              original.then(() => "original-ended"),
            ]),
            signal,
          ),
        ).toBe("close-entered");
        expect(closeTarget).toHaveBeenCalledOnce();
        expect(respond).not.toHaveBeenCalled();
        expect(getAgentRunContext(runId)).toBe(originalContext);

        const params = { agentId: "main", sessionKey, message: "successor", idempotencyKey: runId };
        successor = Promise.resolve(
          agentRunHandler({
            params,
            req: { type: "req", id: "successor", method: "agent", params },
            context,
            respond: successorRespond,
            client: null,
            isWebchatConnect: () => false,
          }),
        ).then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        expect(
          await racePromiseWithAbortSignal(
            Promise.race([
              successorEntered.promise.then(() => "successor-admitted"),
              successor.then(() => "successor-ended"),
            ]),
            signal,
          ),
        ).toBe("successor-admitted");
        const successorEntry = context.chatAbortControllers.get(runId);
        assert(successorEntry);
        expect(successorEntry).not.toBe(originalEntry);
        expect(successorEntry.kind).toBe("agent");
        expect(successorEntry.lifecycleGeneration).toBe(admission.lifecycleGeneration);
        // Same-generation registration merges into the original context object.
        expect(getAgentRunContext(runId)).toBe(originalContext);
        expect(context.dedupe.has(`agent:${runId}`)).toBe(true);
        expect(successorRespond).not.toHaveBeenCalled();

        releaseClose.resolve();
        const outcome = await racePromiseWithAbortSignal(original, signal);
        expect(outcome).toEqual({ ok: true });
        expect(respond).toHaveBeenCalledOnce();
        expect(closeTarget).toHaveBeenCalledOnce();
        expect(getAgentRunContext(runId)).toBe(originalContext);
        expect(context.chatAbortControllers.get(runId)).toBe(successorEntry);
        expect(successorEntry.controller.signal.aborted).toBe(false);
      } catch (error) {
        failures.push(error);
      } finally {
        releaseGates();
        const cleanups: Array<() => void | Promise<void>> = [
          async () => {
            prepared ??= await creatingAdmission;
          },
          async () => {
            if (original) {
              const outcome = await original;
              if (!outcome.ok && !failures.includes(outcome.error)) {
                failures.push(outcome.error);
              }
            } else {
              await prepared?.admitted.value.cleanupAdmittedRun();
            }
          },
          async () => {
            const outcome = await successor;
            if (outcome && !outcome.ok && !failures.includes(outcome.error)) {
              failures.push(outcome.error);
            }
          },
          () => {
            clearAgentRunContext(runId, prepared?.admitted.value.lifecycleGeneration);
          },
          () => {
            runtimeSpy.mockRestore();
          },
          () => {
            qualifySpy.mockRestore();
          },
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            if (!failures.includes(error)) {
              failures.push(error);
            }
          }
        }
        signal.removeEventListener("abort", releaseGates);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "chat successor fixture and cleanup failed");
      }
    });
    return ownedBody;
  },
);
