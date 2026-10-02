import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readReleasedAgentTranscriptRows,
  seedReleasedAgentTranscript,
} from "./session-manager-hydration.release.test-support.js";
import * as messageRuntime from "./session-manager-message-runtime.js";

it("reopens a released-source agent transcript and preserves it across SDK/worker append and replay", async () => {
  await withOpenClawTestState({ label: "released-agent-transcript" }, async (state) => {
    const released = seedReleasedAgentTranscript(state.path("custom-agent.sqlite"));
    const { target, entries, raw } = released;
    const original = readReleasedAgentTranscriptRows(target.storePath, target.sessionId);
    expect(original.events.map((row) => row.event_json)).toEqual(raw);
    expect(original.projection).toEqual({
      indexed_seq: 3,
      leaf_event_id: "released-result",
      active_event_count: 3,
      active_message_count: 3,
      needs_rebuild: 0,
    });
    expect(original.active).toEqual(
      entries.map((_, index) => ({
        event_seq: index + 1,
        active_position: index,
        message_position: index,
        context_eligible: 1,
      })),
    );
    expect(original.search).toEqual([
      { message_id: "released-user", role: "user", text: "released input" },
    ]);
    const createRuntime = messageRuntime.createSessionManagerMessageRuntime;
    let workerAppends = 0;
    const runtimeSpy = vi
      .spyOn(messageRuntime, "createSessionManagerMessageRuntime")
      .mockImplementation((params) => {
        const runtime = createRuntime(params);
        return {
          ...runtime,
          async append(...args) {
            workerAppends += 1;
            return await runtime.append(...args);
          },
        };
      });
    try {
      const manager = await SessionManager.openAsync(target);
      expect(manager.getHeader()).toEqual(released.header);
      expect(manager.getEntries()).toEqual(entries);
      const bounded = await SessionManager.openBoundedAsync(target, {
        maxBytes: 4096,
        maxEvents: 3,
      });
      expect(bounded.getEntries()).toEqual(entries);
      const assistant = entries[1]!.message;
      if (assistant.role !== "assistant") {
        throw new Error("Released assistant fixture changed");
      }
      const appendedAssistant = manager.appendMessage({
        ...assistant,
        timestamp: 4,
        content: [{ type: "toolCall", id: "current-call", name: "read", arguments: {} }],
      });
      expect(workerAppends).toBe(0);
      const result = {
        role: "toolResult" as const,
        toolCallId: "current-call",
        toolName: "read",
        content: [{ type: "text" as const, text: "current worker result" }],
        isError: false,
        timestamp: 5,
        idempotencyKey: "released-fixture-result",
      };
      const appendedResult = await manager.appendMessageAsync(result);
      expect(workerAppends).toBe(1);
      expect(manager.getEntries().map((entry) => [entry.id, entry.parentId])).toEqual([
        ...entries.map((entry) => [entry.id, entry.parentId]),
        [appendedAssistant, "released-result"],
        [appendedResult, appendedAssistant],
      ]);
      const appended = readReleasedAgentTranscriptRows(target.storePath, target.sessionId);
      expect(appended.events.slice(0, raw.length)).toEqual(original.events);
      expect(appended.identities.slice(0, raw.length)).toEqual(original.identities);
      expect(appended.generation).toEqual(original.generation);
      expect(await manager.appendMessageAsync(result)).toBe(appendedResult);
      expect(workerAppends).toBe(2);
      expect(readReleasedAgentTranscriptRows(target.storePath, target.sessionId)).toEqual(appended);
      expect((await SessionManager.openAsync(target)).getEntries()).toEqual(manager.getEntries());
      expect(manager.getSessionTarget()?.storePath).toBe(target.storePath);
      expect(fs.existsSync(path.join(state.agentDir("main"), "openclaw-agent.sqlite"))).toBe(false);
    } finally {
      runtimeSpy.mockRestore();
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    }
  });
});
