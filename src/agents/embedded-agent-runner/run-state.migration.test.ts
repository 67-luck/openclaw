import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";

it("migrates retained handle indexes to one attachment record on reload", async () => {
  const stateKey = Symbol.for("openclaw.embeddedRunState");
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const previousState = globalStore[stateKey];
  const runId = "retained-run";
  const sessionId = "retained-session";
  const handle: EmbeddedAgentQueueHandle = {
    runId,
    queueMessage: vi.fn(async () => {}),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
  };
  const registration = {
    settlement: createDeferredCore(),
    sessionId,
  };
  const retainedRegistrations = new WeakMap([[handle, registration]]);
  const retainedGenerations = new WeakMap([[handle, "retained-generation"]]);
  const retainedState = {
    detachedAttempts: new Set([handle]),
    activeRunsByRunId: new Map([[runId, handle]]),
    retainedRegistrations,
    retainedGenerations,
  };
  globalStore[stateKey] = retainedState;

  try {
    const runState = await importFreshModule<typeof import("./run-state.js")>(
      import.meta.url,
      "./run-state.js?scope=retained-state-migration",
    );
    const attachment = runState.ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId);

    expect(attachment).toMatchObject({
      handle,
      lifecycleGeneration: "retained-generation",
      sessionId,
    });
    expect(runState.getActiveNativeAttempt(sessionId)).toBe(handle);
    expect([...runState.activeNativeAttempts()]).toEqual([[sessionId, handle]]);
    expect(handle[runState.embeddedRunCleanupAttachment]).toBe(attachment);
    expect(Object.values(retainedState)).not.toContain(retainedRegistrations);
    expect(Object.values(retainedState)).not.toContain(retainedGenerations);
  } finally {
    if (previousState === undefined) {
      Reflect.deleteProperty(globalStore, stateKey);
    } else {
      globalStore[stateKey] = previousState;
    }
  }
});
