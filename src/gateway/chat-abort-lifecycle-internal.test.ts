import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import {
  bindChatAbortTerminalDispatch,
  isCurrentChatAbortExecution,
  markChatAbortTerminalPersistenceError,
  runWithChatAbortExecution,
  waitForChatAbortControllerRemoval,
} from "./chat-abort-lifecycle-internal.js";
import { abortChatRunById, registerChatAbortController } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";

afterEach(() => {
  rpcSourceTesting.clear();
});

function registeredRun() {
  const runId = "terminal-drain";
  const registration = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: "/synthetic/terminal-drain/sessions",
      sessionKey: "agent:main:terminal",
      incarnation: "terminal-session",
    }),
    runId,
    sessionId: "terminal-session",
    sessionKey: "agent:main:terminal",
    timeoutMs: 60_000,
  });
  const entry = registration.entry;
  if (!entry) {
    throw new Error("Expected a registered run");
  }
  const drain = () =>
    waitForChatAbortControllerRemoval({
      targets: [{ runId, entry }],
      timeoutMs: 1_000,
    });
  return { runId, entry, registration, drain };
}

it.each(
  ["settled", "pending", "writing", "failed"].flatMap((state) =>
    [false, true].map((alreadyRemoved) => ({ state, alreadyRemoved })),
  ),
)(
  "checks $state terminal ownership when alreadyRemoved=$alreadyRemoved",
  async ({ state, alreadyRemoved }) => {
    const { runId, entry, drain } = registeredRun();
    if (state === "pending") {
      entry.adapter.projectSessionTerminalPending = true;
    } else if (state === "writing") {
      entry.adapter.projectSessionTerminalPersistence = new Promise<void>(() => {});
    } else if (state === "failed") {
      markChatAbortTerminalPersistenceError(entry, new Error("terminal write failed"));
    }
    if (alreadyRemoved) {
      rpcSourceTesting.deleteExpected(runId, entry);
    }
    const result = drain();
    rpcSourceTesting.deleteExpected(runId, entry);
    expect(await result).toBe(state === "settled");
  },
);

it("finishes an empty selection without draining unrelated registrations", async () => {
  const { runId } = registeredRun();
  expect(await waitForChatAbortControllerRemoval({ targets: [], timeoutMs: 1_000 })).toBe(true);
  expect(rpcSourceTesting.has(runId)).toBe(true);
});

it("releases the reserved terminal owner when no lifecycle subscriber adopts it", async () => {
  const { runId, entry, drain } = registeredRun();
  const result = drain();
  expect(
    abortChatRunById(
      {
        chatRunState: createChatRunState(),
        removeChatRun: () => undefined,
        agentRunSeq: new Map(),
        broadcast: () => {},
        nodeSendToSession: () => {},
      },
      { runId, sessionKey: getRpcSourceIdentity(entry).sessionKey },
    ),
  ).toEqual({ aborted: true });
  expect(await result).toBe(true);
  expect(rpcSourceTesting.has(runId)).toBe(false);
});

it.each(["fulfilled", "rejected"] as const)(
  "drains a promise-only registration after it is %s",
  async (outcome) => {
    const { runId, entry, registration, drain } = registeredRun();
    const persistence = createDeferred();
    entry.adapter.projectSessionTerminalPersistence = persistence.promise;
    const result = drain();
    registration.cleanup();
    expect(rpcSourceTesting.get(runId)).toBe(entry);
    if (outcome === "fulfilled") {
      persistence.resolve();
    } else {
      persistence.reject(new Error("terminal write failed"));
    }
    expect(await result).toBe(outcome === "fulfilled");
    expect(rpcSourceTesting.has(runId)).toBe(false);
  },
);

it.each(
  (["settled", "pending", "writing", "failed", "dispatch-failed"] as const).flatMap((state) =>
    [false, true].map((unbounded) => ({ state, unbounded })),
  ),
)(
  "self-drain preserves $state terminal ownership and still joins its sibling (unbounded=$unbounded)",
  async ({ state, unbounded }) => {
    const { entries, runId, entry, registration } = registeredRun();
    const sibling = registerChatAbortController({
      chatAbortControllers: entries,
      runId: "sibling-tail",
      sessionId: entry.sessionId,
      sessionKey: entry.sessionKey,
      kind: "agent",
      timeoutMs: 60_000,
    });
    const siblingEntry = sibling.entry!;
    const releaseSibling = createDeferred();
    const selectedSibling = createDeferred();
    const siblingWork = runWithChatAbortExecution(
      siblingEntry,
      async () => {
        sibling.cleanup();
        await releaseSibling.promise;
      },
      sibling.cleanup,
    );
    const terminalWrite = createDeferred();
    void terminalWrite.promise.catch(() => {});
    let drainDone = false;
    const ownWork = runWithChatAbortExecution(
      entry,
      async () => {
        if (state === "pending") {
          entry.projectSessionTerminalPending = true;
        }
        if (state === "writing") {
          entry.projectSessionTerminalPersistence = terminalWrite.promise;
        }
        if (state === "failed") {
          markChatAbortTerminalPersistenceError(entry, new Error("write failed"));
        }
        if (state === "dispatch-failed") {
          bindChatAbortTerminalDispatch([entry], Promise.resolve(), {
            failure: { error: new Error("terminal dispatch failed") },
          });
        }
        const waitOptions = unbounded
          ? { timeoutMs: null, signal: new AbortController().signal }
          : { timeoutMs: 1_000 };
        const draining = waitForChatAbortControllerRemoval({
          entries,
          targets: [
            { runId, entry },
            { runId: "sibling-tail", entry: siblingEntry },
          ],
          ...waitOptions,
        });
        selectedSibling.resolve();
        expect(await draining).toBe(state === "settled");
        drainDone = true;
        entry.projectSessionTerminalPending = false;
        entry.projectSessionTerminalPersistence = undefined;
        markChatAbortTerminalPersistenceError(entry, undefined);
        registration.cleanup();
      },
      registration.cleanup,
    );
    await selectedSibling.promise;
    expect(drainDone).toBe(false);
    releaseSibling.resolve();
    if (state === "writing") {
      terminalWrite.reject(new Error("terminal write failed"));
    }
    await Promise.all([ownWork, siblingWork]);
    expect(entries.size).toBe(0);
  },
);

it.each(["before waiting", "while waiting"] as const)(
  "cancels an unbounded removal wait %s without retiring raw execution",
  async (when) => {
    const { entries, runId, entry, registration } = registeredRun();
    const finish = createDeferred();
    const execution = runWithChatAbortExecution(
      entry,
      async () => {
        registration.cleanup();
        await finish.promise;
      },
      registration.cleanup,
    );
    const cancellation = new AbortController();
    const reason = new Error("Removal wait owner retired");
    if (when === "before waiting") {
      cancellation.abort(reason);
    }
    try {
      const draining = waitForChatAbortControllerRemoval({
        entries,
        targets: [{ runId, entry }],
        timeoutMs: null,
        signal: cancellation.signal,
      });
      const rejected = expect(draining).rejects.toMatchObject({
        name: "AbortError",
        cause: reason,
      });
      if (when === "while waiting") {
        cancellation.abort(reason);
      }
      await rejected;
      expect(entries.get(runId)).toBe(entry);
      expect(entry.executionSettlement?.status).toBe("pending");
      expect(entry.controller.signal.aborted).toBe(false);

      const resumed = waitForChatAbortControllerRemoval({
        entries,
        targets: [{ runId, entry }],
        timeoutMs: null,
        signal: new AbortController().signal,
      });
      finish.resolve();
      await execution;
      expect(await resumed).toBe(true);
      expect(entries.has(runId)).toBe(false);
    } finally {
      finish.resolve();
      await execution;
    }
  },
);

it("does not let an inherited continuation exclude a rejected execution owner", async () => {
  const { entries, runId, entry, registration } = registeredRun();
  const resume = createDeferred();
  let inherited: Promise<boolean> | undefined;
  const failure = new Error("execution disposal rejected");
  const execution = runWithChatAbortExecution(
    entry,
    async () => {
      inherited = resume.promise.then(() => isCurrentChatAbortExecution(entry));
      registration.cleanup();
      throw failure;
    },
    registration.cleanup,
  );
  await expect(execution).rejects.toBe(failure);
  resume.resolve();
  expect(await inherited).toBe(false);
  expect(entries.get(runId)).toBe(entry);
  expect(entry.executionSettlement?.status).toBe("rejected");
});

it("settles an expired timeout receipt while retaining pending raw execution", async () => {
  const { entries, runId, entry, registration } = registeredRun();
  const finish = createDeferred();
  const execution = runWithChatAbortExecution(
    entry,
    async () => {
      await finish.promise;
      registration.cleanup();
    },
    registration.cleanup,
  );
  let receipts = 0;
  expect(
    registration.deferTimeoutCompletion(() => {
      receipts += 1;
    }),
  ).toBe(true);
  const receipt = entry.pendingTimeoutCompletion;
  if (!receipt) {
    throw new Error("Expected the owned timeout receipt");
  }
  receipt.expiresAtMs = 0;
  try {
    expect(removeChatAbortControllerEntry(entries, runId, entry)).toBe(false);
    expect(receipts).toBe(1);
    expect(entries.get(runId)).toBe(entry);
    expect(entry.executionSettlement?.status).toBe("pending");
    expect(entry.pendingTimeoutCompletion).toBeUndefined();
  } finally {
    finish.resolve();
    await execution;
  }
  expect(entries.has(runId)).toBe(false);
  expect(receipts).toBe(1);
});

it("rejects public Stop after logical cleanup while retaining raw disposal", async () => {
  const { entries, runId, entry, registration } = registeredRun();
  const finish = createDeferred();
  const execution = runWithChatAbortExecution(
    entry,
    async () => {
      registration.cleanup();
      await finish.promise;
    },
    registration.cleanup,
  );
  const events: string[] = [];
  try {
    expect(entry.executionSettlement?.status).toBe("pending");
    expect(
      abortChatRunById(
        {
          chatAbortControllers: entries,
          chatRunState: createChatRunState(),
          agentRunSeq: new Map(),
          removeChatRun: () => undefined,
          broadcast: () => events.push("broadcast"),
          nodeSendToSession: () => events.push("node"),
        },
        { runId, sessionKey: entry.sessionKey, stopReason: "rpc" },
      ),
    ).toEqual({ aborted: false });
    expect(entry.controller.signal.aborted).toBe(false);
    expect(entries.get(runId)).toBe(entry);
    expect(events).toEqual([]);
  } finally {
    finish.resolve();
    await execution;
  }
  expect(entries.has(runId)).toBe(false);
});

it("joins its own terminal write without waiting for its own raw completion", async () => {
  const { entries, runId, entry, registration } = registeredRun();
  const persistence = createDeferred();
  await runWithChatAbortExecution(
    entry,
    async () => {
      entry.projectSessionTerminalPersistence = persistence.promise;
      registration.cleanup();
      const draining = waitForChatAbortControllerRemoval({
        entries,
        targets: [{ runId, entry }],
        timeoutMs: 1_000,
      });
      persistence.resolve();
      expect(await draining).toBe(true);
      expect(entry.executionSettlement?.status).toBe("pending");
    },
    registration.cleanup,
  );
  expect(entries.has(runId)).toBe(false);
});
