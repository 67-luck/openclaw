import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { Mock } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { sessionManagerNavigate } from "../../sessions/session-manager-navigation.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../sessions/session-manager.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;

export type SessionManagerMocks = {
  getSessionTarget: Mock<() => undefined>;
  getSessionId: Mock<() => string>;
  getAppendParentId: Mock<() => string | null>;
  getHeader: UnknownMock;
  getLeafId: Mock<() => string | null>;
  getLeafEntry: UnknownMock;
  getEntry: UnknownMock;
  getEntries: UnknownMock;
  getBranch: UnknownMock;
  getToolResultProjectionEntries: UnknownMock;
  getBoundaryCount: UnknownMock;
  branchAsync: UnknownMock;
  resetLeafAsync: UnknownMock;
  navigate: Mock<SessionManager[typeof sessionManagerNavigate]>;
  buildSessionContext: Mock<() => { messages: AgentMessage[] }>;
  appendThinkingLevelChange: UnknownMock;
  appendModelChange: UnknownMock;
  appendCustomEntryAsync: UnknownMock;
  appendMessageAsync: UnknownMock;
  appendSessionInfoAsync: UnknownMock;
  appendLabelChangeAsync: UnknownMock;
  flushPendingPersistence: UnknownMock;
  flushPendingToolResultsAsync: UnknownMock;
  clearPendingToolResults: UnknownMock;
  reloadPersistedTranscriptAsync: UnknownMock;
  clearNextUserMessagePersistenceSuppression: UnknownMock;
  removeTrailingEntriesAsync: UnknownMock;
};

export function createSessionManagerFixture(mocks: SessionManagerMocks, messages: AgentMessage[]) {
  const manager = SessionManager.fromEntries([
    {
      type: "session",
      id: "embedded-session",
      version: CURRENT_SESSION_VERSION,
      cwd: process.cwd(),
      timestamp: new Date(0).toISOString(),
    },
    ...messages.map((message, index) => ({
      type: "message",
      id: `fixture-message-${index}`,
      parentId: index === 0 ? null : `fixture-message-${index - 1}`,
      timestamp: new Date(index).toISOString(),
      message,
    })),
  ]);
  const getBranch = manager.getBranch.bind(manager);
  const buildSessionContext = manager.buildSessionContext.bind(manager);
  mocks.getBranch.mockImplementation((fromId: unknown) =>
    getBranch(typeof fromId === "string" ? fromId : undefined),
  );
  mocks.buildSessionContext.mockImplementation(buildSessionContext);
  mocks.navigate.mockImplementation(async (branchFromId) => {
    // Synthetic branch IDs select the fixture's already-prepared post-repair view.
    if (branchFromId === null) {
      await mocks.resetLeafAsync();
    } else {
      await mocks.branchAsync(branchFromId);
    }
    return { assertCurrent: () => undefined, restoreIfCurrent: () => undefined };
  });
  return Object.assign(manager, mocks, { [sessionManagerNavigate]: mocks.navigate });
}

export function createCompletedAssistantStream() {
  return {
    async result() {
      return { role: "assistant", content: "done" };
    },
    [Symbol.asyncIterator]() {
      return (async function* () {})();
    },
  };
}

export function readMockSessionCacheTtlTimestamp(
  sessionManager: {
    appendCustomEntryAsync?: { mock?: { calls?: unknown[][] } };
  },
  context?: { provider?: string; modelId?: string },
): number | null {
  const calls = sessionManager.appendCustomEntryAsync?.mock?.calls ?? [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const [customType, data] = calls[index] ?? [];
    if (customType !== "openclaw.cache-ttl") {
      continue;
    }
    const entry = asOptionalObjectRecord(data);
    if (
      context?.provider &&
      normalizeOptionalLowercaseString(entry?.provider) !==
        normalizeOptionalLowercaseString(context.provider)
    ) {
      continue;
    }
    if (
      context?.modelId &&
      normalizeOptionalLowercaseString(entry?.modelId) !==
        normalizeOptionalLowercaseString(context.modelId)
    ) {
      continue;
    }
    const timestamp = entry?.timestamp;
    return typeof timestamp === "number" ? timestamp : null;
  }
  return null;
}

export function resetSessionManagerMocks(
  sessionManager: SessionManagerMocks,
  messages: AgentMessage[] = [],
) {
  sessionManager.getSessionTarget.mockReset().mockReturnValue(undefined);
  sessionManager.getSessionId.mockReset().mockReturnValue("embedded-session");
  sessionManager.getAppendParentId.mockReset().mockReturnValue(null);
  sessionManager.getHeader.mockReset().mockReturnValue({ version: 3 });
  sessionManager.getLeafId.mockReset().mockReturnValue(null);
  sessionManager.getLeafEntry.mockReset().mockReturnValue(null);
  sessionManager.getEntry.mockReset().mockReturnValue(undefined);
  sessionManager.getEntries.mockReset().mockReturnValue([]);
  sessionManager.getBranch.mockReset().mockReturnValue([]);
  sessionManager.getBoundaryCount.mockReset().mockReturnValue(0);
  sessionManager.branchAsync.mockReset();
  sessionManager.resetLeafAsync.mockReset();
  sessionManager.navigate.mockReset();
  sessionManager.clearNextUserMessagePersistenceSuppression.mockReset();
  sessionManager.buildSessionContext.mockReset().mockReturnValue({ messages });
  sessionManager.appendThinkingLevelChange.mockReset();
  sessionManager.appendModelChange.mockReset();
  sessionManager.appendCustomEntryAsync.mockReset();
  sessionManager.appendMessageAsync.mockReset();
  sessionManager.appendSessionInfoAsync.mockReset();
  sessionManager.appendLabelChangeAsync.mockReset();
  sessionManager.flushPendingPersistence.mockReset();
  sessionManager.reloadPersistedTranscriptAsync.mockReset();
  return createSessionManagerFixture(sessionManager, messages);
}
