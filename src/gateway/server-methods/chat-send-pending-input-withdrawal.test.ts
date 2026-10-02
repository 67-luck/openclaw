import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import {
  admitFollowupRunLifecycle,
  retireFollowupRunCancellation,
} from "../../auto-reply/reply/queue/lifecycle.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import { listSessionPendingInputReceipts } from "../../config/sessions/session-accessor.sqlite-pending-input-receipts.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  isRpcSourceQueued,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import * as sessionChangeEvent from "./session-change-event.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("queued chat input withdrawal", () => {
  it.each([
    { target: "admitted", stopReason: "timeout", reason: "timeout", discardPendingInput: false },
    { target: "queued", stopReason: "stop", reason: "stop", discardPendingInput: false },
    { target: "queued", stopReason: "restart", reason: "restart", discardPendingInput: false },
    { target: "signal", stopReason: undefined, reason: "aborted", discardPendingInput: false },
    { target: "consumed", stopReason: "rpc", reason: undefined, discardPendingInput: false },
    { target: "queued", stopReason: "rpc", reason: "rpc", discardPendingInput: true },
  ] as const)(
    "settles $target input ($stopReason, discard: $discardPendingInput) without losing recovery",
    async ({ target, stopReason, reason, discardPendingInput }) => {
      const fixture = await createBrowserFollowupFixture();
      try {
        await fixture.send();
        const recorder = await fixture.dispatchedRecorder;
        const runId = fixture.params.idempotencyKey;
        const active = rpcSourceTesting.get(runId);
        if (!active) {
          throw new Error("Expected the pending input's abort owner");
        }
        const discard = async () => {
          const params = { sessionKey: fixture.scope.sessionKey, runId, discardPendingInput: true };
          const respond = vi.fn<RespondFn>();
          await handleChatAbortRequest({
            params,
            req: { type: "req", id: "discard-input", method: "chat.abort", params },
            client: fixture.client,
            context: fixture.context,
            respond,
            isWebchatConnect: () => true,
          });
          expect(respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [runId],
          });
        };
        if (target === "queued") {
          const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as
            | Parameters<typeof dispatchInboundMessage>[0]
            | undefined;
          const run = createQueueTestRun({ prompt: fixture.params.message });
          run.abortSignal = active.input.abortSignal;
          run.turnAdoptionLifecycle = dispatch?.replyOptions?.turnAdoptionLifecycle;
          bindSessionControllerSource(active.input, run);
          expect(run.turnAdoptionLifecycle).toBeDefined();
          expect(
            enqueueFollowupRun(
              fixture.scope.sessionKey,
              run,
              createQueueSettings({ mode: "followup" }),
              "none",
              async () => {},
              false,
            ),
          ).toBe(true);
          const detached = createDeferred();
          vi.mocked(fixture.context.removeChatRun).mockImplementationOnce(() => {
            detached.resolve();
            return undefined;
          });
          // Finish only the ingress dispatcher. The predecessor is still doing
          // real work, so this source must remain queued until withdrawal.
          fixture.releaseDispatch();
          await detached.promise;
          expect(rpcSourceTesting.get(runId)).toBe(active);
          expect(isRpcSourceQueued(active)).toBe(true);
          if (discardPendingInput) {
            await discard();
          } else {
            expect(
              abortChatRunById(createChatAbortOps(fixture.context), {
                runId,
                sessionKey: fixture.scope.sessionKey,
                stopReason,
              }).aborted,
            ).toBe(true);
          }
        } else if (target === "signal") {
          requestRpcSourceCancellation(
            active,
            new Error("Private cancellation payload must stay out of logs"),
          );
        } else {
          if (target === "consumed") {
            await recorder.persistApproved();
          }
          if (discardPendingInput) {
            await discard();
          } else {
            expect(
              abortChatRunById(createChatAbortOps(fixture.context), {
                runId,
                sessionKey: fixture.scope.sessionKey,
                stopReason,
              }).aborted,
            ).toBe(true);
          }
        }
        await fixture.finishDispatch();
        const disposition = reason === "restart" ? "interrupted" : "cancelled";
        expect(
          vi
            .mocked(fixture.context.logGateway.info)
            .mock.calls.filter(([message]) => message.startsWith("chat pending input aborted:")),
        ).toEqual(
          reason
            ? [
                [
                  `chat pending input aborted: ${reason} (${disposition})`,
                  {
                    runId,
                    sessionKey: fixture.scope.sessionKey,
                    sessionId: fixture.scope.sessionId,
                    agentId: "main",
                    disposition,
                    reason,
                  },
                ],
              ]
            : [],
        );
        expect(listSessionPendingInputs(fixture.scope)).toMatchObject(
          reason ? { items: [{ state: disposition }], total: 1 } : { items: [], total: 0 },
        );
        if (reason) {
          const page = await readChatPendingInputs(fixture.scope, { limit: 1, maxChars: 1000 });
          expect(page.items).toHaveLength(1);
          if (discardPendingInput) {
            expect(page.items[0]?.message).toMatchObject({ display: false, content: [] });
            expect(JSON.stringify(page)).not.toContain(fixture.approvedContent);
          } else {
            expect(page.items[0]?.message).toMatchObject({ content: fixture.approvedContent });
          }
          expect(listSessionPendingInputReceipts(fixture.scope, { runIds: [runId] })).toEqual([
            {
              runId,
              state: "pending",
              ...(disposition === "cancelled" ? { cancelled: true } : {}),
            },
          ]);
          expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        } else {
          expect(JSON.stringify(loadTranscriptEventsSync(fixture.scope))).toContain(
            fixture.approvedContent,
          );
        }
      } finally {
        clearFollowupQueue(fixture.scope.sessionKey);
        await fixture.cleanup();
      }
    },
  );

  it.each(["claimed", "consumed", "queued-consumed"] as const)(
    "does not stop an input that cannot be removed ($0)",
    async (target) => {
      const fixture = await createBrowserFollowupFixture();
      let claimed: Awaited<ReturnType<typeof claimSessionControllerInput>> | undefined;
      try {
        await fixture.send();
        const recorder = await fixture.dispatchedRecorder;
        const runId = fixture.params.idempotencyKey;
        const active = rpcSourceTesting.get(runId);
        if (!active) {
          throw new Error("Expected the pending input's abort owner");
        }
        if (target === "queued-consumed") {
          const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as
            | Parameters<typeof dispatchInboundMessage>[0]
            | undefined;
          const run = createQueueTestRun({ prompt: fixture.params.message });
          run.abortSignal = active.input.abortSignal;
          run.turnAdoptionLifecycle = dispatch?.replyOptions?.turnAdoptionLifecycle;
          bindSessionControllerSource(active.input, run);
          expect(
            enqueueFollowupRun(
              fixture.scope.sessionKey,
              run,
              createQueueSettings({ mode: "followup" }),
              "none",
              async () => {},
              false,
            ),
          ).toBe(true);
        }
        if (target === "claimed") {
          fixture.activeRun?.complete();
          const run = createQueueTestRun({ prompt: fixture.params.message });
          bindSessionControllerSource(active.input, run);
          claimed = await claimSessionControllerInput(run);
        } else {
          await recorder.persistApproved();
        }
        const queuedBefore = isRpcSourceQueued(active);
        const pending = listSessionPendingInputs(fixture.scope);
        const transcript = loadTranscriptEventsSync(fixture.scope);
        const params = { sessionKey: fixture.scope.sessionKey, runId, discardPendingInput: true };
        const respond = vi.fn<RespondFn>();

        await handleChatAbortRequest({
          params,
          req: { type: "req", id: "stale-removal", method: "chat.abort", params },
          client: fixture.client,
          context: fixture.context,
          respond,
          isWebchatConnect: () => true,
        });

        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
        expect(active.input.abortSignal.aborted).toBe(false);
        expect(rpcSourceTesting.get(runId)).toBe(active);
        expect(isRpcSourceQueued(active)).toBe(queuedBefore);
        expect(listSessionPendingInputs(fixture.scope)).toEqual(pending);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
      } finally {
        if (claimed) {
          releaseSessionControllerClaim(claimed);
        }
        clearFollowupQueue(fixture.scope.sessionKey);
        await fixture.cleanup();
      }
    },
  );

  it.each(["retry", "resume", "retired", "revoked"] as const)(
    "keeps refused removal available for $0 and fences adoption through withdrawal commit",
    async (afterRefusal) => {
      const fixture = await createBrowserFollowupFixture();
      let unsubscribe: (() => void) | undefined;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const refusal = vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission");
      const publishChange = vi.spyOn(sessionChangeEvent, "emitSessionsChanged");
      let replacement: RpcSourceRef | undefined;
      let cleanupReplacement: (() => void) | undefined;
      let retiredAfterCommit = false;
      try {
        await fixture.send();
        await fixture.dispatchedRecorder;
        const runId = fixture.params.idempotencyKey;
        const active = rpcSourceTesting.get(runId);
        if (!active) {
          throw new Error("Expected the pending input's abort owner");
        }
        const dispatch = dispatchInboundMessageMock.mock.calls.at(-1)?.[0] as
          | Parameters<typeof dispatchInboundMessage>[0]
          | undefined;
        const run = createQueueTestRun({ prompt: fixture.params.message });
        run.abortSignal = active.input.abortSignal;
        run.turnAdoptionLifecycle = dispatch?.replyOptions?.turnAdoptionLifecycle;
        bindSessionControllerSource(active.input, run);
        expect(
          enqueueFollowupRun(
            fixture.scope.sessionKey,
            run,
            createQueueSettings({ mode: "followup" }),
            "none",
            async () => {},
            false,
          ),
        ).toBe(true);
        expect(isRpcSourceQueued(active)).toBe(true);
        let adoption: Promise<"admitted" | "aborted"> | undefined;
        const beginAdoption = () => {
          adoption = claimSessionControllerInput(run)
            .then(async (claim) => {
              try {
                await admitFollowupRunLifecycle(run);
                retireFollowupRunCancellation(run);
              } finally {
                releaseSessionControllerClaim(claim);
              }
            })
            .then(
              () => "admitted" as const,
              () => "aborted" as const,
            );
          fixture.activeRun?.complete();
        };
        const published: boolean[] = [];
        let requestCurrent = true;
        unsubscribe = sessionChanges.subscribe((change) => {
          if ("sessionKey" in change && change.sessionKey === fixture.scope.sessionKey) {
            const input = listSessionPendingInputs(fixture.scope).items[0];
            const withdrawn = input?.state === "cancelled" && input.message.display === false;
            published.push(withdrawn);
            if (withdrawn && afterRefusal === "retired" && !replacement) {
              // Replace correlation during publication, but reserve the new source
              // through its real physical owner. The hold still belongs to old input.
              rpcSourceTesting.delete(runId);
              const registration = registerChatAbortController({
                runId,
                ...fixture.scope,
                target: captureSessionTarget({
                  storeScope: fixture.scope.storePath,
                  sessionKey: fixture.scope.sessionKey,
                  incarnation: fixture.scope.sessionId,
                  agentId: fixture.scope.agentId,
                }),
                timeoutMs: 60_000,
              });
              replacement = registration.entry;
              cleanupReplacement = registration.cleanup;
              retiredAfterCommit = rpcSourceTesting.get(runId) !== active;
            }
            if (withdrawn && afterRefusal === "revoked") {
              requestCurrent = false;
            }
          }
        });
        const params = { sessionKey: fixture.scope.sessionKey, runId, discardPendingInput: true };
        const respond = vi.fn<RespondFn>();
        const remove = () =>
          handleChatAbortRequest({
            params,
            req: { type: "req", id: "retry-removal", method: "chat.abort", params },
            client: fixture.client,
            context: fixture.context,
            respond,
            isWebchatConnect: () => true,
            hasCurrentClientAuthority: () => requestCurrent,
          });

        refusal.mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              if (afterRefusal === "resume") {
                beginAdoption();
              }
              throw new Error("Synthetic withdrawal commit refusal");
            }
            return callback(request, grant);
          }, attachment),
        );
        await expect(remove()).rejects.toThrow("Synthetic withdrawal commit refusal");
        expect(rpcSourceTesting.get(runId)).toBe(active);
        if (afterRefusal !== "resume") {
          expect(isRpcSourceQueued(active)).toBe(true);
        }
        expect(active.input.abortSignal.aborted).toBe(false);
        expect(listSessionPendingInputs(fixture.scope).items[0]?.state).toBe("queued");
        expect(published).toEqual([]);

        if (afterRefusal === "resume") {
          await expect(adoption).resolves.toBe("admitted");
          return;
        }
        refusal.mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              beginAdoption();
            }
            return callback(request, grant);
          }, attachment),
        );
        await remove();
        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [runId] });
        await expect(adoption).resolves.toBe("aborted");
        expect(active.input.abortSignal.aborted).toBe(true);
        if (afterRefusal === "retired") {
          expect(retiredAfterCommit).toBe(true);
          expect(replacement).toBeDefined();
        }
        if (replacement) {
          expect(replacement.input.abortSignal.aborted).toBe(false);
          expect(rpcSourceTesting.get(runId)).toBe(replacement);
        }
        expect(published.length).toBeGreaterThan(0);
        expect(published.every(Boolean)).toBe(true);
        expect(publishChange).toHaveBeenCalledWith(
          fixture.context,
          {
            sessionKey: fixture.scope.sessionKey,
            sessionId: fixture.scope.sessionId,
            agentId: fixture.scope.agentId,
            reason: "agent.input.settled",
          },
          { accessChanged: false },
        );
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      } finally {
        refusal.mockRestore();
        publishChange.mockRestore();
        unsubscribe?.();
        cleanupReplacement?.();
        clearFollowupQueue(fixture.scope.sessionKey);
        await fixture.cleanup();
      }
    },
  );
});
