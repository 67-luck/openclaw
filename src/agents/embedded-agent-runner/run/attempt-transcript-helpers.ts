import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  hasSessionTranscriptMessage,
  resolveSessionTranscriptRuntimeTarget,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { resolveQuotaSuspensionEntryMaintenance } from "../../../config/sessions/store-maintenance.js";
import type { SessionEntry as ConfigSessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  committedSessionPublicationError,
  prepareSessionMessagePublication,
} from "../../sessions/agent-session-publication.js";
import { sessionManagerPrepareHistoryRead } from "../../sessions/session-manager-history.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { canContinueFromMessage, trimToContinuableTail } from "./compaction-timeout.js";
import { isMidTurnPrecheckAssistantError } from "./midturn-precheck.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;

type TranscriptCleanupParams = {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: AttemptSessionManager;
};

function prepareCleanupPublication(params: TranscriptCleanupParams) {
  const history = params.sessionManager[sessionManagerPrepareHistoryRead]();
  const publication = prepareSessionMessagePublication(() => params.activeSession.agent.state);
  return {
    messages: params.activeSession.agent.state.messages,
    publish: publication.publish,
    assertCurrent(removedEntries: number) {
      if (removedEntries > 0) {
        history.assertNavigationCurrent();
      } else {
        history.assertCurrent();
      }
      publication.assertCurrent();
    },
    throwFailure(cause: unknown, removedEntries: number): never {
      if (removedEntries === 0) {
        throw cause;
      }
      const error = committedSessionPublicationError(
        "Transcript cleanup committed, but context publication failed; do not replay the cleanup",
        cause,
      );
      error.name = "SessionSuffixCommittedError";
      publication.invalidateIfCurrent(error);
      throw error;
    },
  };
}

export async function rewindRejectedFinalizationEntry(
  sessionManager: AttemptSessionManager,
  rejectedEntryId: string,
): Promise<() => void> {
  return await withSessionManagerWrite(sessionManager, async () => {
    const history = sessionManager[sessionManagerPrepareHistoryRead]();
    const rejectedEntry = await history.readEntryNavigation(rejectedEntryId);
    if (rejectedEntry?.type !== "message" || rejectedEntry.messageRole !== "assistant") {
      throw new Error(
        `before_agent_finalize persisted assistant entry is missing or invalid ` +
          `(entry=${rejectedEntryId})`,
      );
    }
    history.assertCurrent();
    // The resident parent can skip evicted results; only canonical ancestry may select the retry.
    await sessionManager.appendLeafControlAsync({
      targetId: rejectedEntry.canonicalParentId,
      appendParentId: rejectedEntry.canonicalParentId,
    });
    try {
      history.assertNavigationCurrent();
      return history.assertNavigationCurrent;
    } catch (cause) {
      throw committedSessionPublicationError(
        "Finalization rewind committed, but navigation publication failed; do not replay the rewind",
        cause,
      );
    }
  });
}

export async function removeTrailingMidTurnPrecheckAssistantError(
  params: TranscriptCleanupParams,
): Promise<void> {
  const publication = prepareCleanupPublication(params);
  const preserveTrailing = (entry: ReturnType<AttemptSessionManager["getEntries"]>[number]) =>
    entry.type === "custom" ||
    entry.type === "label" ||
    entry.type === "session_info" ||
    (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message));
  // New guarded writes omit the signal. Retain cleanup for an already-persisted legacy error.
  const removedEntries = await params.sessionManager.removeTrailingEntriesAsync(
    (entry) => entry.type === "message" && isMidTurnPrecheckAssistantError(entry.message),
    { preserveTrailing },
  );
  try {
    publication.assertCurrent(removedEntries);
    if (isMidTurnPrecheckAssistantError(publication.messages.at(-1))) {
      publication.publish(publication.messages.slice(0, -1));
    }
  } catch (cause) {
    publication.throwFailure(cause, removedEntries);
  }
}

export async function normalizeCompactionRecoveryTranscriptTail(
  params: TranscriptCleanupParams,
): Promise<number> {
  const publication = prepareCleanupPublication(params);

  // This is the single recovery owner for compaction exits that hand control
  // back to a continuation. AgentCore rejects assistant tails before providers run.
  const removedEntries = await params.sessionManager.removeTrailingEntriesAsync(
    (entry) => entry.type === "message" && !canContinueFromMessage(entry.message),
    {
      preserveTrailing: (entry) =>
        entry.type === "custom" ||
        entry.type === "label" ||
        entry.type === "session_info" ||
        (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
    },
  );
  try {
    publication.assertCurrent(removedEntries);
    if (removedEntries > 0) {
      const history = params.sessionManager[sessionManagerPrepareHistoryRead]();
      const context = await history.readContext();
      history.assertCurrent();
      publication.assertCurrent(removedEntries);
      publication.publish(sanitizeCompactionReplayMessages(context.messages));
    } else {
      const { messages } = publication;
      const continuableMessages = trimToContinuableTail(messages) ?? [];
      publication.publish(
        continuableMessages.length === messages.length ? messages : continuableMessages,
      );
    }
  } catch (cause) {
    publication.throwFailure(cause, removedEntries);
  }
  return removedEntries;
}

// Applies quota-resume TTL maintenance to only the active attempt session.
export async function loadAttemptSessionEntryAfterQuotaMaintenance(
  params: { agentId: string; storePath: string; sessionKey: string },
  assertCurrent: () => void,
): Promise<ConfigSessionEntry | undefined> {
  const entry = await readSessionEntryInWorker(params, assertCurrent);
  assertCurrent();
  if (!entry?.quotaSuspension) {
    return entry;
  }
  const now = Date.now();
  const maintenance = resolveQuotaSuspensionEntryMaintenance({ entry, now });
  if (!maintenance.patch) {
    return entry;
  }
  const updated = await patchSessionEntryCore(
    params,
    (currentEntry) =>
      resolveQuotaSuspensionEntryMaintenance({
        entry: currentEntry,
        now,
      }).patch,
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
      assertCommitAllowed: assertCurrent,
    },
  );
  assertCurrent();
  return updated ?? entry;
}

export async function resolveAttemptTrajectorySessionFile(params: {
  agentId: string;
  config?: OpenClawConfig;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): Promise<string> {
  const storePath =
    params.sessionTarget?.storePath ??
    resolveSessionStorePathCore(params.config?.session?.store, { agentId: params.agentId });
  if (!storePath || !params.sessionKey) {
    return params.sessionFile;
  }
  return (
    await resolveSessionTranscriptRuntimeTarget({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath,
    })
  ).sessionKey;
}

type ExistingAttemptTranscriptState = {
  hasBootstrapTranscriptState: boolean;
};

export async function resolveExistingAttemptTranscriptState(params: {
  agentId: string;
  config?: OpenClawConfig;
  sessionFile: string;
  sessionManager?: EmbeddedRunAttemptParams["sessionManager"];
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): Promise<ExistingAttemptTranscriptState> {
  // The supplied manager owns this transcript; a borrowed durable identity is not its history.
  if (params.sessionManager) {
    return {
      hasBootstrapTranscriptState: params.sessionManager
        .getEntries()
        .some((entry) => entry.type === "message"),
    };
  }
  const agentId = normalizeOptionalString(params.sessionTarget?.agentId) ?? params.agentId;
  const storePath =
    normalizeOptionalString(params.sessionTarget?.storePath) ??
    resolveSessionStorePathCore(params.config?.session?.store, { agentId });
  const sessionId = normalizeOptionalString(params.sessionTarget?.sessionId) ?? params.sessionId;
  const sessionKey =
    normalizeOptionalString(params.sessionTarget?.sessionKey) ??
    normalizeOptionalString(params.sessionKey);
  let hasBootstrapTranscriptState = false;
  if (storePath && sessionKey) {
    try {
      hasBootstrapTranscriptState = await hasSessionTranscriptMessage({
        agentId,
        sessionId,
        sessionKey,
        storePath,
      });
    } catch {
      hasBootstrapTranscriptState = false;
    }
  }
  return { hasBootstrapTranscriptState };
}
