import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import {
  markChatAbortTerminalPersistenceError,
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
