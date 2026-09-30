import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  runCodexAppServerAttempt,
} from "./run-attempt.context-engine.test-support.js";

setupRunAttemptTestHooks();
describe("Codex continuation admission", () => {
  it("returns only new native work when continuing an existing logical turn", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "continuation-delta.jsonl"),
      path.join(tempDir, "continuation-delta-workspace"),
    );
    params.prompt = "Revise the current draft without repeating completed work.";
    params.continuationMessages = [
      userMessage("ORIGINAL_SOURCE", 10),
      assistantMessage("COMPLETED_PREFIX", 20),
    ];
    params.suppressNextUserMessagePersistence = true;
    params.captureContinuationMessages = true;
    const pending = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    expect(getRequestInputText(harness)).toContain("COMPLETED_PREFIX");
    await harness.completeTurn();
    const result = await pending;
    // Input history is projected to Codex, but the outgoing continuation is this attempt only.
    expect(result.continuationMessages).toBeDefined();
    expect(JSON.stringify(result.continuationMessages)).not.toContain("ORIGINAL_SOURCE");
    expect(JSON.stringify(result.continuationMessages)).not.toContain("COMPLETED_PREFIX");
    expect(result.continuationMessages?.some((message) => message.role === "assistant")).toBe(true);
  });

  it.each([
    ["normal", "eager"],
    ["normal", "lazy"],
    ["refresh", "eager"],
    ["refresh", "lazy"],
    ["refresh", "none"],
    ["empty-refresh", "none"],
    ["continuation", "eager"],
    ["continuation", "none"],
  ] as const)(
    "uses one recorder representation for %s with recorder: %s",
    async (scenario, recorderKind) => {
      const withRecorder = recorderKind !== "none";
      const beforePromptBuild = vi.fn(async (_event: unknown) => undefined);
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_prompt_build",
            handler: beforePromptBuild,
          },
        ]),
      );
      const sessionFile = path.join(tempDir, "session-runtime-refresh.jsonl");
      const workspaceDir = path.join(tempDir, "workspace-runtime-refresh");
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.prompt = "Transport context and media wrapping, or continue after runtime refresh.";
      const admittedMessage = {
        ...userMessage("", 10),
        content: [
          { type: "text" as const, text: "What do you remember" },
          {
            type: "image" as const,
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXkAAAAASUVORK5CYII=",
          },
          { type: "text" as const, text: "about my preferences?" },
        ],
        idempotencyKey: "refresh-original:user",
      };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareContextMedia: async ({ message }) => ({
          images:
            message.role === "user"
              ? admittedMessage.content.filter((part) => part.type === "image")
              : [],
        }),
      };
      if (withRecorder) {
        params.userTurnTranscriptRecorder = {
          message: recorderKind === "lazy" ? undefined : admittedMessage,
          resolveMessage: async () => admittedMessage,
          markRuntimePersisted() {},
          getAdmissionReceipt: () => undefined,
        } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
      }
      if (scenario !== "normal") {
        const messages =
          scenario === "empty-refresh"
            ? []
            : [admittedMessage, assistantMessage("Work completed before refresh.", 20)];
        if (scenario === "continuation") {
          params.continuationMessages = messages;
        } else {
          params.pluginRuntimeRefreshMessages = messages;
        }
      }

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      if (scenario === "refresh" || scenario === "continuation") {
        expect(getRequestInputText(harness)).toContain("Work completed before refresh.");
      }
      if (scenario === "continuation") {
        expect(getRequestInputText(harness)).toContain(params.prompt);
      }
      expect(beforePromptBuild).toHaveBeenCalled();
      for (const [event] of beforePromptBuild.mock.calls) {
        expect(event).toMatchObject({
          currentUserMessage: withRecorder ? "What do you remember\nabout my preferences?" : "",
        });
        if (withRecorder) {
          expect(event).toHaveProperty("currentUserMessageId", "refresh-original:user");
        } else {
          expect(event).not.toHaveProperty("currentUserMessageId");
        }
      }

      await harness.completeTurn();
      await run;
    },
  );
});
