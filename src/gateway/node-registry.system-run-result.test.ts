import { describe, expect, it } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";

describe("system.run result reconciliation", () => {
  it("records a received result for terminal-event authorization", async () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {});
    const runId = "run-result-received";
    const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId, sessionKey, turnSourceAccountId: "work" },
      timeoutMs: 0,
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };

    expect(
      registry.handleInvokeResult({
        id: request.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
        payloadJSON: JSON.stringify({ stdout: "done" }),
      }),
    ).toBe(true);
    await expect(invoke).resolves.toMatchObject({ ok: true });
    expect(
      registry.authorizeSystemRunEventWithState({
        nodeId: "node-1",
        connId: "conn-1",
        runId,
        sessionKey,
        terminal: true,
      }),
    ).toEqual({
      invokeResultReceived: true,
      invocationSessionKey: sessionKey,
      turnSourceAccountId: "work",
    });
    registry.unregister("conn-1");
  });
});

it.each([
  {
    name: "captured shared session",
    sessionKey: "agent:main:main",
    source: true,
    accountId: "work",
    expectedAccount: "work",
  },
  {
    name: "captured default account",
    sessionKey: "agent:main:main",
    source: true,
    accountId: undefined,
    expectedAccount: "default",
  },
  {
    name: "untrusted payload hints",
    sessionKey: "agent:main:main",
    source: false,
    accountId: "work",
    expectedAccount: undefined,
  },
  {
    name: "sessionless dispatch",
    sessionKey: undefined,
    source: true,
    accountId: "work",
    expectedAccount: undefined,
  },
])("retains only host-bound route custody for $name", async (test) => {
  const registry = new NodeRegistry();
  const frames: string[] = [];
  registerNodeSession(registry, makeClient("capture-conn", "capture-node", frames), {});
  const source = {
    channel: "telegram",
    to: "-100123:topic:42",
    accountId: test.accountId,
    threadId: "42",
  };
  try {
    const invoke = registry.invoke({
      nodeId: "capture-node",
      command: "system.run",
      timeoutMs: 0,
      params: {
        runId: "capture-run",
        sessionKey: test.sessionKey,
        turnSourceChannel: "telegram",
        turnSourceTo: "forged-owner",
        turnSourceAccountId: "personal",
      },
      ...(test.source ? { turnSource: source } : {}),
    });
    source.to = "mutated-owner";
    const frame = JSON.parse(frames[0]!).payload;
    registry.handleInvokeResult({
      id: frame.id,
      nodeId: "capture-node",
      connId: "capture-conn",
      ok: true,
    });
    await invoke;
    const authorization = registry.authorizeSystemRunEventWithState({
      nodeId: "capture-node",
      connId: "capture-conn",
      runId: "capture-run",
      sessionKey: "agent:main:main",
      terminal: true,
    });
    expect(authorization).not.toBeNull();
    expect(authorization?.invocationDeliveryContext).toEqual(
      test.expectedAccount
        ? {
            channel: "telegram",
            to: "-100123:topic:42",
            accountId: test.expectedAccount,
            threadId: "42",
          }
        : undefined,
    );
  } finally {
    registry.unregister("capture-conn");
  }
});
