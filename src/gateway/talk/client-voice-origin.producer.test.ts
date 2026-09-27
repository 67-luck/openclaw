import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunTerminal } from "../../agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { makeEmbeddedRunnerAttempt } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  createAgentLifecycleTerminalBackstop,
  resolveAgentLifecycleTerminalMetadata,
} from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";

// The direct Talk runner uses run-orchestrator's backstop, not the low-level
// attempt end emitter. Attempts emit "finishing"; the accepted result supplies
// the final metadata. No manually enriched continuation event is used here.
describe("voice binding at the real terminal producer boundary", () => {
  it.each([
    { route: "direct-talk", outcome: "explicit", retained: true },
    { route: "direct-talk", outcome: "implicit", retained: false },
    { route: "chat-talk", outcome: "explicit", retained: true },
    { route: "chat-talk", outcome: "implicit", retained: false },
    { route: "direct-talk", outcome: "cancelled", retained: false },
    { route: "direct-talk", outcome: "failed", retained: false },
  ] as const)(
    "$route / $outcome preserves only a real continuation",
    async ({ route, outcome, retained }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:producer",
          origin: "client" as const,
        };
        const runId = "producer-run";
        const voiceSessionId = createOrResumeClientVoiceSession(scope);
        const capture = captureGatewayDeviceRevocation({}, { deviceId: "widget" }, () => true);
        const origin = captureTalkVoiceOrigin({
          client: { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true },
          hasCurrentClientAuthority: capture.isCurrent,
        });
        const dispose = registerClientVoiceConsultRun({
          ...scope,
          voiceSessionId,
          runId,
          originAuthority: origin,
        });
        const replyOperation =
          route === "direct-talk"
            ? undefined
            : createReplyOperation({
                sessionKey: scope.sessionKey,
                sessionId: "producer-session",
                agentId: scope.agentId,
                resetTriggered: false,
                turnKind: "visible",
              });
        try {
          const attempt = makeEmbeddedRunnerAttempt({
            assistantTexts: [],
            acceptedSessionSpawns: [
              {
                runId: "child",
                childSessionKey: "agent:main:subagent:producer",
                expectsCompletionMessage: true,
              },
            ],
            yieldDetected: outcome === "explicit" || outcome === "cancelled",
            terminal:
              outcome === "failed"
                ? { kind: "failed", source: "prompt", error: new Error("fixture provider failure") }
                : outcome === "cancelled"
                  ? { kind: "aborted", source: "external" }
                  : { kind: "ok" },
          });
          const input = makeTerminalInput({
            attempt,
            runParams: {
              runId,
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              lane: "talk",
              replyOperation,
              ...(route === "chat-talk"
                ? {
                    inputProvenance: {
                      kind: "internal_system",
                      sourceTool: "openclaw_agent_consult",
                    },
                  }
                : {}),
            },
          });
          const resolved = await resolveEmbeddedRunTerminal(input);
          expect(resolved.action).toBe("complete");
          if (resolved.action !== "complete") {
            throw new Error("Producer unexpectedly retried");
          }
          const result = resolved.result;
          expect(result.meta.continuationPending).toBeUndefined();
          const terminal = createAgentLifecycleTerminalBackstop({
            runId,
            sessionKey: scope.sessionKey,
            getLifecycleGeneration: getAgentEventLifecycleGeneration,
            resolveTerminationFields: (error) =>
              resolveAgentRunErrorLifecycleFields(error, undefined),
          });
          // This is the final publication call in run-orchestrator.ts, including
          // its canonical metadata projection rather than guessed event fields.
          const error = result.meta.error?.message;
          terminal.emit(
            error ? "error" : "end",
            error ? new Error(error) : result,
            resolveAgentLifecycleTerminalMetadata(result.meta),
          );
          origin?.release();
          capture.release();
          expect(resolveClientVoiceRunBinding(runId)?.originAuthority?.isCurrent() === true).toBe(
            retained,
          );
        } finally {
          dispose();
          origin?.release();
          capture.release();
          replyOperation?.complete();
          clientVoiceSessionTesting.reset();
        }
      });
    },
  );
  it("recognizes implicit continuation eligibility for an ordinary external visible parent without inventing voice custody", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const replyOperation = createReplyOperation({
        sessionKey: "agent:main:external",
        sessionId: "external-parent",
        agentId: "main",
        resetTriggered: false,
        turnKind: "visible",
      });
      try {
        const result = await resolveEmbeddedRunTerminal(
          makeTerminalInput({
            attempt: makeEmbeddedRunnerAttempt({
              acceptedSessionSpawns: [
                {
                  runId: "child",
                  childSessionKey: "agent:main:subagent:external",
                  expectsCompletionMessage: true,
                },
              ],
            }),
            runParams: { replyOperation, inputProvenance: { kind: "external_user" } },
          }),
        );
        expect(result).toMatchObject({
          action: "complete",
          result: { meta: { continuationPending: true } },
        });
        expect(resolveClientVoiceRunBinding("external-parent")).toBeUndefined();
      } finally {
        replyOperation.complete();
      }
    });
  });
});
