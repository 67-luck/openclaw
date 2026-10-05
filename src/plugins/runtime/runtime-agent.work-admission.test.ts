import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getActiveNativeAttempt } from "../../agents/embedded-agent-runner/run-state.js";
import {
  setActiveEmbeddedRun,
  clearActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  getCurrentSessionControllerClaim,
  interruptSessionControllerEffects,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime session work admission", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-plugin-session-admission-");
  let storePath: string;
  const sessionKey = "agent:main:voice:caller";
  const sessionId = "voice-session-id";

  beforeEach(async () => {
    const tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    await createRuntimeAgent().session.upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId, updatedAt: Date.now() },
    });
  });

  it("rejects an archived session before running admitted work", async () => {
    const runtime = createRuntimeAgent();
    await runtime.session.patchSessionEntry({
      storePath,
      sessionKey,
      update: () => ({ archivedAt: Date.now() }),
    });
    let ran = false;

    await expect(
      runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(`Session "${sessionKey}" is archived`);
    expect(ran).toBe(false);
  });

  it("waits for a queued archive mutation and rejects the stale start", async () => {
    const runtime = createRuntimeAgent();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
      run: async () => {
        await runtime.session.patchSessionEntry({
          storePath,
          sessionKey,
          update: () => ({ archivedAt: Date.now() }),
        });
      },
    });
    await mutationStarted.promise;

    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {});
    releaseMutation.resolve();
    await mutation;

    await expect(work).rejects.toThrow(`Session "${sessionKey}" is archived`);
  });

  it("rejects a session replaced while work waits for lifecycle admission", async () => {
    const runtime = createRuntimeAgent();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
      run: async () => {
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey,
          entry: { sessionId: "replacement-session", updatedAt: Date.now() },
        });
      },
    });
    await mutationStarted.promise;

    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {});
    releaseMutation.resolve();
    await mutation;

    await expect(work).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  });

  it("admits fresh work and protects session creation inside the callback", async () => {
    const runtime = createRuntimeAgent();
    const freshKey = "agent:main:voice:fresh";
    const freshId = "fresh-session-id";

    await runtime.session.runWithWorkAdmission({ storePath, sessionKey: freshKey }, async () => {
      const claim = getCurrentSessionControllerClaim();
      expect(claim?.operation).toBeUndefined();
      await runtime.session.upsertSessionEntry({
        storePath,
        sessionKey: freshKey,
        entry: { sessionId: freshId, updatedAt: Date.now() },
      });
      await withSessionTurn(
        { storePath, sessionKey: freshKey, sessionId: freshId },
        async (operation) => {
          expect(operation?.sessionId).toBe(freshId);
          expect(getCurrentSessionControllerClaim()).toBe(claim);
          const native = {
            runId: "fresh-sdk-native",
            queueMessage: async () => {},
            isStreaming: () => true,
            isCompacting: () => false,
            abort: () => {},
          };
          setActiveEmbeddedRun(freshId, native, freshKey, undefined, "main", operation);
          try {
            expect(getActiveNativeAttempt(freshId)).toBe(native);
          } finally {
            clearActiveEmbeddedRun(freshId, native);
          }
        },
      );
      expect(claim?.operation?.result).toBeNull();
    });

    expect(runtime.session.getSessionEntry({ storePath, sessionKey: freshKey })?.sessionId).toBe(
      freshId,
    );
  });

  it("holds admission through the callback and relays lifecycle interruption", async () => {
    const runtime = createRuntimeAgent();
    const workStarted = createDeferred();
    let admittedSignal: AbortSignal | undefined;
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async (signal) => {
      admittedSignal = signal;
      workStarted.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    await workStarted.promise;

    await interruptSessionControllerEffects({
      scope: storePath,
      identities: [sessionKey, sessionId],
    });
    await work;

    expect(admittedSignal?.aborted).toBe(true);
  });
});
