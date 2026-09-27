import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import {
  captureGatewayDeviceRevocation,
  readGatewayDeviceRevocationGuard,
} from "../device-revocation.js";
import { createChatRunState } from "../server-chat-state.js";
import { createChatSendDispatchErrorLifecycle } from "../server-methods/chat-send-dispatch-errors.js";
import { createConfigHandlerHarness } from "../server-methods/config.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
const mocks = vi.hoisted(() => ({ chatSend: vi.fn() }));
// Only chat admission transport is synthetic. The accepted registration, exact
// abort-controller removal and post-ack failure lifecycle are production owners.
vi.mock("../server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: mocks.chatSend,
}));
import { startTalkRealtimeAgentConsult } from "./agent-consult.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";

afterEach(() => {
  clientVoiceSessionTesting.reset();
  vi.restoreAllMocks();
});
describe("chat Talk origin registration handoff", () => {
  it.each([false, true])(
    "settles post-ack failure without retiring a started backend (started=%s)",
    async (started) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:chat-origin",
          sessionId: "chat-origin-session",
        };
        const runId = "chat-origin-run";
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        await upsertSessionEntryCore(
          { ...scope, storePath },
          { sessionId: scope.sessionId, updatedAt: Date.now() },
        );
        const voiceSessionId = createOrResumeClientVoiceSession({ ...scope, origin: "client" });
        const capture = captureGatewayDeviceRevocation({}, { deviceId: "widget" }, () => true);
        const client = { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true };
        const origin = captureTalkVoiceOrigin({
          client,
          hasCurrentClientAuthority: capture.isCurrent,
        });
        const harness = createConfigHandlerHarness({
          overrides: { client },
          contextOverrides: {
            agentRunSeq: new Map(),
            chatAbortControllers: new Map(),
            chatRunState: createChatRunState(),
            dedupe: new Map(),
            getRuntimeConfig: () => ({}),
            getSessionEventSubscriberConnIds: () => new Set(),
            broadcast: vi.fn(),
            broadcastToConnIds: vi.fn(),
            nodeSendToSession: vi.fn(),
            removeChatRun: vi.fn(),
          },
        });
        const previousRemoval = vi.fn();
        const registration = registerChatAbortController({
          chatAbortControllers: harness.options.context.chatAbortControllers,
          runId,
          ...scope,
          timeoutMs: 10000,
          ownerConnId: client.connId,
          onRemoved: previousRemoval,
        });
        if (!registration.registered) {
          throw new Error("Fixture chat run was not admitted");
        }
        mocks.chatSend.mockImplementationOnce(async (request) => {
          request.respond(true, { runId, status: "started" });
        });
        try {
          const acknowledged = await startTalkRealtimeAgentConsult(harness.options, {
            originAuthority: origin,
            sessionTarget: { ...scope, canonicalKey: scope.sessionKey, storePath },
            callId: "call",
            args: { question: "Launch" },
            onRunStarted: (acceptedRunId) =>
              registerClientVoiceConsultRun({
                ...scope,
                voiceSessionId,
                runId: acceptedRunId,
                originAuthority: origin,
              }),
          });
          expect(acknowledged.ok).toBe(true);
          origin?.release();
          capture.release();
          expect(resolveClientVoiceRunBinding(runId)?.originAuthority?.isCurrent()).toBe(true);
          if (started) {
            registration.markExecutionStarted();
          }
          const failure = createChatSendDispatchErrorLifecycle({
            admission: {
              sessionBinding: { ...scope, lifecycleGeneration },
              activeRunAbort: registration,
              cleanupAdmittedRun: registration.cleanup,
              lifecycleGeneration,
              restartSafeAdmission: undefined,
            },
            context: harness.options.context,
            isAgentRunStarted: () => started,
            isQueuedFollowupEnqueued: () => false,
            persistUserTurnTranscript: async () => undefined,
            session: {
              ...scope,
              backingSessionId: scope.sessionId,
              cfg: {},
              clientRunId: runId,
              now: Date.now(),
              rawSessionKey: scope.sessionKey,
            },
            terminalizeRestartSafeAdmission: async () => false,
            userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
          });
          await failure.handleError(new Error("worker unavailable before backend"));
          await failure.finalize();
          expect(previousRemoval).toHaveBeenCalledOnce();
          expect(resolveClientVoiceRunBinding(runId) !== undefined).toBe(started);
          if (started) {
            emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", yielded: true } });
            expect(resolveClientVoiceRunBinding(runId)).toBeDefined();
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: { phase: "error", executionSettled: true },
            });
          }
          expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
          expect(readGatewayDeviceRevocationGuard(capture.isCurrent)?.()).toBe(false);
        } finally {
          registration.cleanup();
          origin?.release();
          capture.release();
          clientVoiceSessionTesting.reset();
        }
      });
    },
  );
});
