import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});
registerAgentSessionLoopTestLifecycle();

it.each([
  { storage: "persisted", selection: "branches" },
  { storage: "persisted", selection: "target" },
  { storage: "detached", selection: "target" },
] as const)(
  "navigates $storage $selection with complete 5 MiB tool results",
  async ({ storage, selection }) => {
    const directory = dirs.make("openclaw-navigation-oversized-");
    const target = {
      agentId: "main",
      sessionId: "navigation-oversized",
      sessionKey: "agent:main:navigation-oversized",
      storePath: path.join(directory, "sessions.json"),
    };
    if (storage === "persisted") {
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    }
    const manager =
      storage === "persisted"
        ? await SessionManager.openAsync(target, directory)
        : SessionManager.inMemory();
    const shared = manager.appendMessage(makeUserMessage("shared root", 1));
    const appendTool = (id: string) => {
      manager.appendMessage(
        createAssistant(
          testModel,
          [{ type: "toolCall", id, name: "read", arguments: {} }],
          "toolUse",
        ),
      );
      const message = {
        role: "toolResult" as const,
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text" as const, text: id }],
        details: { bytes: "x".repeat(5 * 1024 * 1024) },
        isError: false,
        timestamp: 2,
      };
      return { id: manager.appendMessage(message), message };
    };
    const selectedTool = appendTool("selected-tool");
    const selectedId =
      selection === "target"
        ? selectedTool.id
        : manager.appendMessage(
            createAssistant(testModel, [{ type: "text", text: "selected answer" }]),
          );
    manager.branch(shared);
    const abandonedTool = selection === "branches" ? appendTool("abandoned-tool") : undefined;
    manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "current answer" }]));
    const { session } = await createTestSession({
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });

    await expect(
      session.navigateTree(selectedId, { label: "selected bookmark" }),
    ).resolves.toMatchObject({ cancelled: false });

    expect(manager.getLabel(selectedId)).toBe("selected bookmark");
    expect(session.messages).toContainEqual(selectedTool.message);
    if (abandonedTool) {
      expect(session.messages).not.toContainEqual(abandonedTool.message);
      expect(manager.getEntry(abandonedTool.id)).toMatchObject({ message: abandonedTool.message });
    }
    if (storage === "persisted") {
      const reopened = await SessionManager.openAsync(target, directory);
      expect(reopened.getLabel(selectedId)).toBe("selected bookmark");
      expect(reopened.getEntry(selectedTool.id)).toMatchObject({ message: selectedTool.message });
      expect(reopened.buildSessionContext().messages).toEqual(session.messages);
    }
  },
);
