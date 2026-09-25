import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexToolOutcomeFixture } from "../extensions/codex/test-api.js";
import { createAgentToolExecutionBudget } from "../src/agents/agent-tool-source-execution-guard.js";
import { createHostWorkspaceWriteTool } from "../src/agents/agent-tools.read.js";
import { emitAgentEvent } from "../src/infra/agent-events.js";
import {
  onTrustedToolExecutionEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  emitTrustedDiagnosticEvent,
} from "../src/infra/diagnostic-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../src/plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { resetClientVoiceConfirmationStateForTest } from "../src/talk/client-voice-confirmation.test-support.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../src/talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../src/talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";
import { createDeferred } from "./helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const { createCodexToolOutcomeFixture } = await loadCodexToolOutcomeFixture();
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const env = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;
let voiceSessionId: string;
const context = { agentId: "main", sessionKey: "agent:main:outcomes", runId: "run-outcome" };

describe("source execution through native presentation and voice effects", () => {
  beforeEach(async () => {
    tempDir = tempDirs.make("openclaw-source-outcome-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    voiceSessionId = createOrResumeClientVoiceSession({ ...context, origin: "client" });
    registerClientVoiceConsultRun({ ...context, voiceSessionId });
  });
  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await cleanupSessionStateForTest({ stateDir: tempDir });
    env.restore();
    vi.useRealTimers();
    setDiagnosticsEnabledForProcess(true);
  });

  it.each(["blocked", "failed", "throw"])(
    "keeps a real successful write when native presentation becomes %s",
    async (status) => {
      const registry = createEmptyPluginRegistry();
      const handler = async () => {
        if (status === "throw") {
          throw new Error("result middleware failed");
        }
        return {
          result: {
            content: [{ type: "text" as const, text: "Presentation withheld" }],
            details: { status },
          },
        };
      };
      registry.agentToolResultMiddlewares.push({
        pluginId: "result-test",
        handler,
        rawHandler: handler,
        runtimes: ["codex"],
        source: "test",
      });
      setActivePluginRegistry(registry);
      const target = path.join(tempDir, "written.txt");
      const fixture = createCodexToolOutcomeFixture({
        hookContext: context,
        tool: createHostWorkspaceWriteTool(tempDir, { workspaceOnly: true }),
      });
      const response = await fixture.call({ path: target, content: "source effect completed" });
      expect(await fs.readFile(target, "utf8")).toBe("source effect completed");
      expect(response).toMatchObject({ success: false });
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
        expect.objectContaining({
          toolName: "write",
          toolCallId: "call-outcome",
          status: "succeeded",
          finishedAt: expect.any(Number),
        }),
      ]);
    },
  );

  it("preserves native effects with optional diagnostics disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const target = path.join(tempDir, "without-diagnostics.txt");
    const fixture = createCodexToolOutcomeFixture({
      hookContext: context,
      tool: createHostWorkspaceWriteTool(tempDir, { workspaceOnly: true }),
    });
    expect(await fixture.call({ path: target, content: "written" })).toMatchObject({
      success: true,
    });
    expect(await fs.readFile(target, "utf8")).toBe("written");
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects[0]?.status).toBe(
      "succeeded",
    );
  });

  it("records a real pre-dispatch denial without creating an effect", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ block: true, blockReason: "Denied before write" }),
        },
      ]),
    );
    const target = path.join(tempDir, "denied.txt");
    const events: string[] = [];
    const stop = onTrustedToolExecutionEvent((event) => events.push(event.type));
    try {
      const fixture = createCodexToolOutcomeFixture({
        hookContext: context,
        tool: createHostWorkspaceWriteTool(tempDir, { workspaceOnly: true }),
      });
      expect(await fixture.call({ path: target, content: "never written" })).toMatchObject({
        success: false,
      });
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(events).toEqual(["tool.execution.blocked"]);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([]);
    } finally {
      stop();
    }
  });

  it("retains an actual source failure instead of native success presentation", async () => {
    const fixture = createCodexToolOutcomeFixture({
      hookContext: context,
      tool: createHostWorkspaceWriteTool(tempDir, { workspaceOnly: true }),
    });
    expect(
      await fixture.call({ path: tempDir, content: "cannot replace a directory" }),
    ).toMatchObject({ success: false });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
      expect.objectContaining({
        status: "failed",
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
      }),
    ]);
  });

  it.each(["cancel", "timeout"])(
    "preserves actual start across native %s and settles only on the source outcome",
    async (kind) => {
      const started = createDeferred();
      const release = createDeferred();
      const settled = createDeferred();
      const target = path.join(tempDir, "before-race.txt");
      const controller = new AbortController();
      const fixture = createCodexToolOutcomeFixture({
        hookContext: context,
        controller,
        tool: {
          name: "write",
          label: "Write",
          description: "Task-owned delayed write",
          parameters: Type.Object({ timeoutMs: Type.Number() }),
          async execute(_id, _args, signal) {
            await fs.writeFile(target, "effect before race");
            started.resolve();
            await release.promise;
            if (kind === "cancel") {
              throw signal?.reason;
            }
            return { content: [{ type: "text", text: "Written after wait" }], details: {} };
          },
        },
      });
      const stop = onTrustedToolExecutionEvent((event) => {
        if (event.type !== "tool.execution.started") {
          settled.resolve();
        }
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = fixture.call({ timeoutMs: 100 });
      try {
        await started.promise;
        expect(await fs.readFile(target, "utf8")).toBe("effect before race");
        if (kind === "cancel") {
          controller.abort(new Error("cancelled"));
        } else {
          await vi.advanceTimersByTimeAsync(100);
        }
        expect(await pending).toMatchObject({ success: false });
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects[0],
        ).toMatchObject({ status: "started" });
        release.resolve();
        await settled.promise;
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects[0],
        ).toMatchObject({
          status: kind === "cancel" ? "cancelled" : "succeeded",
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
        });
      } finally {
        release.resolve();
        await pending;
        stop();
      }
    },
  );

  it("retires the voice effect binding at canonical run end with diagnostics disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    emitAgentEvent({
      runId: context.runId,
      stream: "lifecycle",
      data: { phase: "end", executionSettled: true },
    });
    await waitForDiagnosticEventsDrained();
    const target = path.join(tempDir, "after-retirement.txt");
    const fixture = createCodexToolOutcomeFixture({
      hookContext: context,
      tool: createHostWorkspaceWriteTool(tempDir, { workspaceOnly: true }),
    });
    await fixture.call({ path: target, content: "not part of the retired voice call" });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([]);
  });

  it("keeps the voice binding through attempt diagnostics and a retryable lifecycle error", async () => {
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: context.runId,
      durationMs: 1,
      outcome: "error",
    });
    await waitForDiagnosticEventsDrained();
    emitAgentEvent({
      runId: context.runId,
      stream: "lifecycle",
      data: { phase: "error", error: "retryable", executionSettled: false },
    });
    const target = path.join(tempDir, "retry.txt");
    const fixture = createCodexToolOutcomeFixture({
      hookContext: context,
      tool: createHostWorkspaceWriteTool(tempDir, { workspaceOnly: true }),
    });
    await fixture.call({ path: target, content: "retry succeeded" });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects[0]?.status).toBe(
      "succeeded",
    );
  });

  it("does not execute a retained source after its admitted invocation closes", async () => {
    const controller = new AbortController();
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (reason) => controller.abort(reason),
    });
    const target = path.join(tempDir, "admitted.txt");
    const fixture = await budget.run(async () => {
      const admittedFixture = createCodexToolOutcomeFixture({
        hookContext: context,
        controller,
        tool: createHostWorkspaceWriteTool(tempDir, { workspaceOnly: true }),
      });
      expect(await admittedFixture.call({ path: target, content: "admitted" })).toMatchObject({
        success: true,
      });
      return admittedFixture;
    });
    expect(
      await fixture.call({ path: target, content: "must not run" }, "call-retained"),
    ).toMatchObject({ success: false });
    expect(await fs.readFile(target, "utf8")).toBe("admitted");
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
      expect.objectContaining({ toolCallId: "call-outcome", status: "succeeded" }),
    ]);
  });
});
