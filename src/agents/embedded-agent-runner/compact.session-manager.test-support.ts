import { vi } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../sessions/session-manager.js";

export function createCompactionSessionManagerMock(messages: unknown[]) {
  const open = (target: Parameters<typeof SessionManager.open>[0]) =>
    SessionManager.fromEntries([
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: target.sessionId,
        cwd: process.cwd(),
      },
      ...messages.map((message, index) => ({
        type: "message",
        id: `compaction-message-${index}`,
        parentId: index === 0 ? null : `compaction-message-${index - 1}`,
        timestamp: new Date(index).toISOString(),
        message,
      })),
    ]);
  return {
    open: vi.fn(open),
    openAsync: vi.fn(async (target: Parameters<typeof SessionManager.openAsync>[0]) =>
      open(target),
    ),
  };
}
