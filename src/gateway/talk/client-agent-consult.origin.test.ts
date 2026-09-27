import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  readGatewayDeviceRevocationGuard,
} from "../device-revocation.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";

const fixture = vi.hoisted(() => ({
  root: "",
  runId: "",
  prepare: vi.fn(),
  execute: vi.fn(),
  session: { sessionId: "session-talk", updatedAt: 1 },
}));
vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: (runId: string) => {
    fixture.runId = runId;
    return { runId, instanceId: "instance" };
  },
  prepareAgentRunAdmission: fixture.prepare,
}));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: fixture.execute }));
// Replace the backend/session adapter, not consultRealtimeVoiceAgent: the real
// runtime must call the returned cleanup with its actual continuation result.
vi.mock("../../plugins/runtime/index.js", () => ({
  createPluginRuntime: () => ({
    agent: {
      resolveAgentDir: () => fixture.root,
      resolveAgentWorkspaceDir: () => fixture.root,
      resolveAgentTimeoutMs: () => 1000,
      ensureAgentWorkspace: async () => undefined,
      session: {
        resolveStorePath: () => fixture.root + "/sessions.json",
        getSessionEntry: () => fixture.session,
        patchSessionEntry: async () => fixture.session,
      },
    },
  }),
}));
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";

async function withFixture(run: (value: ReturnType<typeof setup>) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    fixture.root = path.dirname(state.configPath);
    const value = setup();
    try {
      await run(value);
    } finally {
      value.origin?.release();
      value.capture.release();
      clientVoiceSessionTesting.reset();
    }
  });
}
function setup() {
  const context = {};
  const scope = { agentId: "researcher", sessionKey: "main", origin: "client" as const };
  const voiceSessionId = createOrResumeClientVoiceSession(scope);
  const capture = captureGatewayDeviceRevocation(context, { deviceId: "widget" }, () => true);
  const origin = captureTalkVoiceOrigin({
    client: { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true },
    hasCurrentClientAuthority: capture.isCurrent,
  });
  const runner = createTalkClientAgentConsultRunner({
    config: {},
    context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      ...scope,
      canonicalKey: "agent:researcher:talk",
      storePath: fixture.root + "/sessions.json",
    },
    getVoiceSessionId: () => voiceSessionId,
    getOriginAuthority: () => origin,
    initialItems: [],
  });
  return { context, scope, voiceSessionId, capture, origin, runner };
}

describe("Talk consult origin custody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.runId = "";
    fixture.prepare.mockImplementation(() => ({ close: () => undefined }));
    fixture.execute.mockResolvedValue({ payloads: [{ text: "done" }], meta: {} });
  });
  afterEach(() => clientVoiceSessionTesting.reset());

  it("releases retained ingress when backend startup throws before lifecycle events", async () => {
    await withFixture(async ({ runner, origin, capture }) => {
      fixture.prepare.mockImplementationOnce(() => {
        throw new Error("startup failed");
      });
      await expect(runner.runArgs({ question: "Launch the app" })).rejects.toThrow(
        "startup failed",
      );
      origin?.release();
      capture.release();
      expect(resolveClientVoiceRunBinding(fixture.runId)).toBeUndefined();
      expect(readGatewayDeviceRevocationGuard(capture.isCurrent)?.()).toBe(false);
      expect(fixture.execute).not.toHaveBeenCalled();
    });
  });

  it("cleans up when onRunStarted throws after registration but before returning cleanup", async () => {
    await withFixture(async ({ runner, origin, capture }) => {
      let assertions = 0;
      await expect(
        runner.runOwnedArgs({ question: "Launch" }, undefined, undefined, () => {
          if (++assertions === 2) {
            throw new Error("callback failed");
          }
        }),
      ).rejects.toThrow("callback failed");
      origin?.release();
      capture.release();
      expect(readGatewayDeviceRevocationGuard(capture.isCurrent)?.()).toBe(false);
      expect(fixture.execute).not.toHaveBeenCalled();
    });
  });

  it.each(["yielded", "continuationPending"] as const)(
    "retains %s work after source release until definitive completion",
    async (kind) => {
      await withFixture(async ({ runner, origin, capture, context }) => {
        fixture.execute.mockResolvedValueOnce({
          payloads: [{ text: "working" }],
          meta: { [kind]: true },
        });
        await runner.runArgs({ question: "Launch" });
        origin?.release();
        capture.release();
        const binding = resolveClientVoiceRunBinding(fixture.runId);
        expect(binding?.originAuthority?.isCurrent()).toBe(true);
        emitAgentEvent({
          runId: fixture.runId,
          stream: "lifecycle",
          data: { phase: "end", [kind]: true },
        });
        expect(resolveClientVoiceRunBinding(fixture.runId)).toBe(binding);
        invalidateGatewayDeviceRevocation(context, "widget");
        expect(binding?.originAuthority?.isCurrent()).toBe(false);
        emitAgentEvent({ runId: fixture.runId, stream: "lifecycle", data: { phase: "end" } });
        expect(resolveClientVoiceRunBinding(fixture.runId)).toBeUndefined();
      });
    },
  );
  it("does not let a replay or stale disposer retire another registration", async () => {
    await withFixture(async ({ scope, voiceSessionId, origin }) => {
      const first = registerClientVoiceConsultRun({
        ...scope,
        voiceSessionId,
        originAuthority: origin,
        runId: "reused",
      });
      const binding = resolveClientVoiceRunBinding("reused");
      const replay = registerClientVoiceConsultRun({
        ...scope,
        voiceSessionId,
        originAuthority: origin,
        runId: "reused",
      });
      replay();
      expect(resolveClientVoiceRunBinding("reused")).toBe(binding);
      const replacementScope = { ...scope, sessionKey: "replacement" };
      const replacementId = createOrResumeClientVoiceSession(replacementScope);
      const second = registerClientVoiceConsultRun({
        ...replacementScope,
        voiceSessionId: replacementId,
        originAuthority: origin,
        runId: "reused",
      });
      first();
      expect(resolveClientVoiceRunBinding("reused")?.voiceSessionId).toBe(replacementId);
      expect(resolveClientVoiceRunBinding("reused")?.originAuthority?.isCurrent()).toBe(true);
      second();
      second();
      expect(resolveClientVoiceRunBinding("reused")).toBeUndefined();
    });
  });
  it("releases a cancelled continuation even when the terminal metadata still says yielded", async () => {
    await withFixture(async ({ runner, origin, capture }) => {
      fixture.execute.mockResolvedValueOnce({ payloads: [], meta: { yielded: true } });
      await runner.runArgs({ question: "Launch" });
      origin?.release();
      capture.release();
      emitAgentEvent({
        runId: fixture.runId,
        stream: "lifecycle",
        data: { phase: "end", yielded: true, aborted: true },
      });
      expect(resolveClientVoiceRunBinding(fixture.runId)).toBeUndefined();
      expect(readGatewayDeviceRevocationGuard(capture.isCurrent)?.()).toBe(false);
    });
  });
  it("keeps committed source authority after the accepting request ends, but not after revocation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = {};
      let requestCurrent = true;
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:request-handoff",
        origin: "client" as const,
      };
      const voiceSessionId = createOrResumeClientVoiceSession(scope);
      const capture = captureGatewayDeviceRevocation(
        context,
        { deviceId: "widget", role: "operator" },
        () => requestCurrent,
        undefined,
        {
          isCurrent: () => true,
          subscribe: () => () => {},
        },
      );
      const client = { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true };
      const origin = captureTalkVoiceOrigin({
        client,
        hasCurrentClientAuthority: capture.isCurrent,
      });
      const dispose = registerClientVoiceConsultRun({
        ...scope,
        voiceSessionId,
        runId: "handed-off",
        originAuthority: origin,
      });
      try {
        origin?.release();
        capture.release();
        requestCurrent = false;
        expect(resolveClientVoiceRunBinding("handed-off")?.originAuthority?.isCurrent()).toBe(true);
        expect(
          captureTalkVoiceOrigin({ client, hasCurrentClientAuthority: capture.isCurrent }),
        ).toBeUndefined();
        invalidateGatewayDeviceRevocation(context, "widget", "operator");
        expect(resolveClientVoiceRunBinding("handed-off")?.originAuthority?.isCurrent()).toBe(
          false,
        );
      } finally {
        dispose();
        origin?.release();
        capture.release();
      }
    });
  });
});
