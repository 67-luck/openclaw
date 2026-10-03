import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import {
  resetSessionControllerStateForTest,
  rpcSourceTesting,
} from "../sessions/session-lifecycle-admission.test-support.js";
import {
  markChatAbortTerminalPersistenceError,
  waitForChatAbortControllerRemoval,
  waitForChatAbortTerminalPersistence,
} from "./chat-abort-lifecycle-internal.js";
import { abortChatRunById, registerChatAbortController } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";

afterEach(() => {
  resetSessionControllerStateForTest();
});

function registeredRun(options: { runId?: string; sessionKey?: string; sessionId?: string } = {}) {
  const runId = options.runId ?? "terminal-drain";
  const sessionKey = options.sessionKey ?? "agent:main:terminal";
  const sessionId = options.sessionId ?? "terminal-session";
  const registration = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: `/synthetic/${runId}/sessions`,
      sessionKey,
      incarnation: sessionId,
    }),
    runId,
    sessionId,
    sessionKey,
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
  "does not retire a replacement persistence owner when an older write is %s",
  async (outcome) => {
    const { entry, registration } = registeredRun();
    const previous = createDeferred();
    const current = createDeferred();
    entry.adapter.projectSessionTerminalPersistence = previous.promise;
    registration.cleanup();
    entry.adapter.projectSessionTerminalPersistence = current.promise;
    if (outcome === "fulfilled") {
      previous.resolve();
    } else {
      previous.reject(new Error("older terminal write failed"));
    }
    await previous.promise.catch(() => {});
    await Promise.resolve();
    expect(entry.adapter.projectSessionTerminalPersistence).toBe(current.promise);

    const joined = waitForChatAbortTerminalPersistence(entry);
    current.resolve();
    await expect(joined).resolves.toBeUndefined();
  },
);

it("waits for every selected controller source without draining unrelated registrations", async () => {
  const first = registeredRun({
    runId: "first-tail",
    sessionKey: "agent:main:first-tail",
    sessionId: "first-session",
  });
  const sibling = registeredRun({
    runId: "sibling-tail",
    sessionKey: "agent:main:sibling-tail",
    sessionId: "sibling-session",
  });
  const unrelated = registeredRun({
    runId: "unrelated-tail",
    sessionKey: "agent:main:unrelated-tail",
    sessionId: "unrelated-session",
  });
  let drained = false;
  const result = waitForChatAbortControllerRemoval({
    targets: [
      { runId: first.runId, entry: first.entry },
      { runId: sibling.runId, entry: sibling.entry },
    ],
    timeoutMs: 1_000,
  }).then((settled) => {
    drained = true;
    return settled;
  });

  first.registration.cleanup();
  await first.entry.input.settlement.promise;
  expect(drained).toBe(false);
  expect(rpcSourceTesting.get(sibling.runId)).toBe(sibling.entry);
  expect(rpcSourceTesting.get(unrelated.runId)).toBe(unrelated.entry);

  sibling.registration.cleanup();
  expect(await result).toBe(true);
  expect(rpcSourceTesting.has(first.runId)).toBe(false);
  expect(rpcSourceTesting.has(sibling.runId)).toBe(false);
  expect(rpcSourceTesting.get(unrelated.runId)).toBe(unrelated.entry);
  unrelated.registration.cleanup();
});
