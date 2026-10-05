import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecordedModelFallbackStop } from "../../model-fallback-stop.js";
import type { AgentMessage } from "../../runtime/index.js";
import { sessionManagerPrepareHistoryRead } from "../../sessions/session-manager-history.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  normalizeCompactionRecoveryTranscriptTail,
  removeTrailingMidTurnPrecheckAssistantError,
} from "./attempt-transcript-helpers.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

afterEach(() => vi.restoreAllMocks());

function fixture(persistedError: boolean) {
  const user: AgentMessage = { role: "user", content: "question", timestamp: 1 };
  const signal = new MidTurnPrecheckSignal({
    route: "compact_only",
    estimatedPromptTokens: 1,
    promptBudgetBeforeReserve: 1,
    overflowTokens: 1,
    toolResultReducibleChars: 0,
    effectiveReserveTokens: 0,
  });
  const error: AgentMessage = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    stopReason: "error",
    errorMessage: signal.message,
    timestamp: 2,
    usage: createZeroUsageFixture(),
  };
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage(user);
  if (persistedError) {
    sessionManager.appendMessage(error);
  }
  const messages = [user, error];
  const activeSession = { agent: { state: { messages } } };
  return { user, error, messages, sessionManager, activeSession };
}

const cleanups = [
  { name: "precheck", run: removeTrailingMidTurnPrecheckAssistantError },
  { name: "compaction", run: normalizeCompactionRecoveryTranscriptTail },
] as const;

describe("attempt transcript cleanup", () => {
  it.each(
    cleanups.flatMap(({ name, run }) =>
      [false, true].map((persistedError) => ({ name, run, persistedError })),
    ),
  )(
    "publishes unchanged $name ownership after cleanup (persisted error=$persistedError)",
    async ({ run, persistedError }) => {
      const f = fixture(persistedError);
      await run(f);
      expect(f.activeSession.agent.state.messages).toEqual([f.user]);
      expect(f.sessionManager.buildSessionContext().messages).toEqual([f.user]);
    },
  );

  it("keeps live messages unchanged when the durable suffix fence rejects cleanup", async () => {
    const f = fixture(true);
    const fenceError = new Error("concurrent transcript append");
    vi.spyOn(f.sessionManager, "removeTrailingEntriesAsync").mockRejectedValue(fenceError);
    await expect(removeTrailingMidTurnPrecheckAssistantError(f)).rejects.toBe(fenceError);
    expect(f.activeSession.agent.state.messages).toBe(f.messages);
    expect(f.activeSession.agent.state.messages).toEqual([f.user, f.error]);
  });

  it.each([
    { ...cleanups[0], persistedError: false, change: "replace" },
    { ...cleanups[0], persistedError: true, change: "append" },
    { ...cleanups[0], persistedError: true, change: "reset" },
    { ...cleanups[1], persistedError: false, change: "replace-prefix" },
    { ...cleanups[1], persistedError: false, change: "reset" },
    { ...cleanups[1], persistedError: true, change: "reset" },
  ])(
    "preserves newer $change state during $name cleanup (persisted error=$persistedError)",
    async ({ run, persistedError, change }) => {
      const f = fixture(persistedError);
      const newer: AgentMessage = { role: "user", content: "newer question", timestamp: 3 };
      const remove = f.sessionManager.removeTrailingEntriesAsync.bind(f.sessionManager);
      let published: AgentMessage[] | undefined;
      let expected: AgentMessage[] | undefined;
      let removedCount: number | undefined;
      vi.spyOn(f.sessionManager, "removeTrailingEntriesAsync").mockImplementation(
        async (...args) => {
          removedCount = await remove(...args);
          if (change === "replace") {
            f.activeSession.agent.state.messages = [newer];
          } else if (change === "append") {
            f.messages.push(newer);
          } else if (change === "replace-prefix") {
            f.messages[0] = newer;
          } else {
            f.sessionManager.resetLeaf();
          }
          published = f.activeSession.agent.state.messages;
          expected = published.slice();
          return removedCount;
        },
      );

      const failure = await run(f).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(removedCount).toBe(persistedError ? 1 : 0);
      expect(failure).toMatchObject(
        persistedError
          ? {
              name: "SessionSuffixCommittedError",
              cause: { message: expect.stringContaining("changed") },
            }
          : { message: expect.stringContaining("changed") },
      );
      expect(isRecordedModelFallbackStop(failure)).toBe(persistedError);
      expect(f.activeSession.agent.state.messages).toBe(published);
      expect(f.activeSession.agent.state.messages).toEqual(expected);
      expect(f.sessionManager.getEntries()).toHaveLength(1);
      if (change === "reset") {
        expect(f.sessionManager.getLeafId()).toBeNull();
      }
    },
  );

  it("rechecks active messages after reading the committed compaction context", async () => {
    const f = fixture(true);
    const newer: AgentMessage = { role: "user", content: "newer after read", timestamp: 3 };
    const prepare = f.sessionManager[sessionManagerPrepareHistoryRead].bind(f.sessionManager);
    vi.spyOn(f.sessionManager, sessionManagerPrepareHistoryRead).mockImplementation((signal) => {
      const history = prepare(signal);
      return {
        ...history,
        readContext: async () => {
          const context = await history.readContext();
          f.messages.push(newer);
          return context;
        },
      };
    });

    const failure = await normalizeCompactionRecoveryTranscriptTail(f).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      name: "SessionSuffixCommittedError",
      cause: { message: "Active session messages changed before publication" },
    });
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    expect(f.activeSession.agent.state.messages).toBe(f.messages);
    expect(f.activeSession.agent.state.messages).toEqual([f.user, f.error, newer]);
    expect(f.sessionManager.buildSessionContext().messages).toEqual([f.user]);
  });
});
