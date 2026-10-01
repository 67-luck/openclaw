import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  bindSessionControllerTarget,
  captureSessionTarget,
  isSessionControllerWorkActive,
  isSessionMutationActive,
} from "../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  seedSessionEntry,
  seedTranscriptRows,
} from "./server.sessions.compaction-fixtures.test-support.js";
import { embeddedRunMock } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => vi.useRealTimers());

async function createCompactionSession(sessionId: string) {
  const sessionKey = "agent:main:main";
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({ entry: sessionStoreEntry(sessionId), sessionKey, storePath });
  await seedTranscriptRows({ sessionId, sessionKey, storePath, totalLines: 3 });
  return { storePath, sessionId, sessionKey };
}

test("sessions.compact preempts an abortable controller run before compacting", async () => {
  const { storePath, sessionId, sessionKey } = await createCompactionSession(
    "sess-compact-queued-work",
  );
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: ["main", sessionId],
    incarnation: sessionId,
    agentId: "main",
  });
  const started = createDeferred();
  let interrupted = false;
  const activeRun = withSessionTurn(
    { sessionKey, sessionId, target },
    async (_operation, signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => {
          interrupted = true;
          resolve();
        }),
      );
    },
  );
  await started.promise;

  try {
    const compacted = await directSessionReq("sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(true);
    expect(interrupted).toBe(true);
    await activeRun;
    expect(isSessionControllerWorkActive(storePath, [sessionId])).toBe(false);
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expectNoSessionQueueCleanup();
  } finally {
    await activeRun;
  }
});

test("sessions.compact preserves its active-run error when controller preemption times out", async () => {
  const { sessionId, sessionKey, storePath } =
    await createCompactionSession("sess-compact-timeout");
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: ["main", sessionId],
    incarnation: sessionId,
    agentId: "main",
  });
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    target,
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  const preemptAttempted = createDeferred();
  vi.spyOn(operation, "abort").mockImplementation(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preemptAttempted.resolve();
    return false;
  });
  const compaction = directSessionReq("sessions.compact", { key: "main" });
  void compaction.catch(() => {});
  try {
    await preemptAttempted.promise;
    expect(isSessionMutationActive(storePath, target.aliases)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    expect(await compaction).toEqual({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Session main has an active run; retry after it finishes.",
      },
    });
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
  } finally {
    operation.complete();
    await compaction.catch(() => undefined);
  }
});
