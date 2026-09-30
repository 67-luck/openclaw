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
    ).toEqual({ invokeResultReceived: true, turnSourceAccountId: "work" });
    registry.unregister("conn-1");
  });
});
