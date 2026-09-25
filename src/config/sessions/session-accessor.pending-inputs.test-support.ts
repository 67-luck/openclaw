import { afterEach, beforeEach } from "vitest";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { withSessionPendingInputRelocation } from "./session-accessor.sqlite-pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

export function usePendingInputsFixture() {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-");
  const sessionKey = "agent:main:pending-inputs";
  const sessionId = "pending-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const message = (runId: string, content = "Continue the task"): PersistedUserTurnMessage => ({
    role: "user",
    content,
    timestamp: 100,
    idempotencyKey: `${runId}:user`,
  });
  const readEventId = (event: unknown) => {
    if (!event || typeof event !== "object" || !("id" in event)) {
      return undefined;
    }
    return typeof event.id === "string" ? event.id : undefined;
  };
  const stage = async (
    runId: string,
    options: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
  ) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      message: message(runId),
      assertCurrent: () => {},
      ...options,
    });
    if (receipt) {
      receipts.push(receipt);
    }
    return receipt!;
  };
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));
  const createRelocation =
    (receipt: SessionPendingInputReceipt) => (sourceInputId: string, eventId: string) =>
      withSessionPendingInputRelocation(sourceInputId, receipt.message, () =>
        appendTranscriptMessageSync(scope(), {
          eventId,
          idempotencyLookup: "caller-checked",
          message: receipt.message,
          parentId: null,
        }),
      );

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });
  return {
    fixture,
    sessionKey,
    sessionId,
    receipts,
    scope,
    database,
    message,
    readEventId,
    stage,
    promote,
    createRelocation,
  };
}
