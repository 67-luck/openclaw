import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import * as callerContext from "./gateway-caller-context.js";
import * as gatewayContext from "./in-process-gateway.js";
import { createSessionsStopTool } from "./sessions-stop-tool.js";

afterEach(() => vi.restoreAllMocks());

const requester = "agent:main:dashboard:requester";
const target = "agent:main:dashboard:target";
const config: OpenClawConfig = { agents: { entries: { main: { default: true }, other: {} } } };

function setup(
  options: {
    config?: OpenClawConfig;
    requester?: string;
    sandboxed?: boolean;
    owned?: boolean;
  } = {},
) {
  const caller = vi.spyOn(callerContext, "getGatewayToolCallerIdentity").mockReturnValue({
    agentId: "main",
    sessionKey: options.requester ?? requester,
  });
  const authority = vi
    .spyOn(callerContext, "captureGatewayToolCallerAssertion")
    .mockReturnValue(vi.fn());
  const hosted = vi.spyOn(gatewayContext, "hasInProcessGatewayToolContext").mockReturnValue(true);
  const callGateway = vi
    .fn()
    .mockImplementation(
      async ({
        method,
        params,
      }: {
        method: string;
        params?: { key?: string; spawnedBy?: string };
      }) => {
        const input = params ?? {};
        if (method === "sessions.resolve") {
          return input.spawnedBy && !options.owned
            ? {}
            : { key: input.key, agentId: input.key?.startsWith("agent:other:") ? "other" : "main" };
        }
        if (method === "sessions.abort") {
          return { ok: true, abortedRunId: "run-target", status: "aborted" };
        }
        throw new Error("Unexpected method: " + method);
      },
    );
  const tool = createSessionsStopTool({
    agentSessionKey: options.requester ?? requester,
    config: options.config ?? config,
    sandboxed: options.sandboxed,
    callGateway,
  });
  return { tool, callGateway, caller, authority, hosted };
}

function abortRequests(callGateway: ReturnType<typeof setup>["callGateway"]) {
  return callGateway.mock.calls.filter(([request]) => request.method === "sessions.abort");
}

describe("sessions_stop", () => {
  it.each(["caller", "authority", "hosted"] as const)(
    "rejects missing %s before target lookup or transport fallback",
    async (missing) => {
      const fixture = setup();
      if (missing === "caller") {
        fixture.caller.mockReturnValue(undefined);
      }
      if (missing === "authority") {
        fixture.authority.mockReturnValue(undefined);
      }
      if (missing === "hosted") {
        fixture.hosted.mockReturnValue(false);
      }
      await expect(fixture.tool.execute("unadmitted", { sessionKey: target })).rejects.toThrow(
        /requires.*admitted Gateway/,
      );
      expect(fixture.callGateway).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, false])(
    "stops without changing the conversation; clearQueued=%s",
    async (clearQueued) => {
      const { tool, callGateway } = setup();
      const result = await tool.execute("stop", { sessionKey: target, clearQueued });
      expect(result.details).toEqual({ ok: true, abortedRunId: "run-target", status: "aborted" });
      expect(abortRequests(callGateway)).toEqual([
        [
          {
            method: "sessions.abort",
            agentToolCaller: {
              agentId: "main",
              sessionKey: requester,
              assertCurrent: expect.any(Function),
            },
            params: { key: target, agentId: "main", clearQueued: clearQueued ?? true },
            signal: undefined,
          },
        ],
      ]);
    },
  );

  it("keeps a run-specific stop narrow", async () => {
    const { tool, callGateway } = setup();
    await tool.execute("stop", { sessionKey: target, runId: "run-exact" });
    expect(abortRequests(callGateway)[0]?.[0].params).toEqual({
      key: target,
      agentId: "main",
      runId: "run-exact",
    });
    await expect(
      tool.execute("invalid", { sessionKey: target, runId: "run-exact", clearQueued: true }),
    ).rejects.toThrow("clearQueued");
    expect(abortRequests(callGateway)).toHaveLength(1);
  });

  it.each(["current", requester, "openclaw-control-ui"])(
    "rejects self-stop through %s",
    async (sessionKey) => {
      const { tool, callGateway } = setup();
      await expect(tool.execute("stop", { sessionKey })).rejects.toThrow("Cannot stop");
      expect(abortRequests(callGateway)).toEqual([]);
    },
  );

  it("rejects an incognito target before any Gateway call", async () => {
    const { tool, callGateway } = setup();
    await expect(
      tool.execute("private", { sessionKey: "agent:main:dashboard:incognito-private" }),
    ).rejects.toThrow("not visible");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rejects a session-id alias of the caller", async () => {
    const { tool, callGateway } = setup();
    callGateway.mockResolvedValueOnce({ key: requester, agentId: "main" });
    await expect(tool.execute("self", { sessionKey: "caller-session-id" })).rejects.toThrow(
      "Cannot stop",
    );
    expect(abortRequests(callGateway)).toEqual([]);
  });

  it("rejects a main alias of the caller", async () => {
    const { tool, callGateway } = setup({ requester: "agent:main:main" });
    await expect(tool.execute("stop", { sessionKey: "main" })).rejects.toThrow("Cannot stop");
    expect(abortRequests(callGateway)).toEqual([]);
  });

  it.each(["self", "tree", "agent"] as const)(
    "preserves %s visibility restrictions",
    async (visibility) => {
      const { tool, callGateway } = setup({
        config: { ...config, tools: { sessions: { visibility } } },
      });
      await expect(
        tool.execute("stop", { sessionKey: "agent:other:dashboard:target" }),
      ).rejects.toThrow("visibility is restricted");
      expect(abortRequests(callGateway)).toEqual([]);
    },
  );

  it("does not treat an existing host-scoped grant as stop permission", async () => {
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(() => ({
      expectedSessionId: "send-only",
    }));
    try {
      const { tool, callGateway } = setup({
        config: { ...config, tools: { sessions: { visibility: "self" } } },
      });
      await expect(tool.execute("stop", { sessionKey: target })).rejects.toThrow("current session");
      expect(abortRequests(callGateway)).toEqual([]);
    } finally {
      unregister();
    }
  });

  it.each([false, true])("sandboxed caller only stops owned children (owned=%s)", async (owned) => {
    const { tool, callGateway } = setup({ sandboxed: true, owned });
    const result = tool.execute("stop", { sessionKey: "agent:main:subagent:child" });
    if (owned) {
      await expect(result).resolves.toMatchObject({ details: { status: "aborted" } });
    } else {
      await expect(result).rejects.toThrow("current session tree");
    }
    expect(abortRequests(callGateway)).toHaveLength(owned ? 1 : 0);
  });

  it("preserves cross-agent policy even when visibility is all", async () => {
    const { tool, callGateway } = setup({
      config: { ...config, tools: { agentToAgent: { enabled: false } } },
    });
    await expect(
      tool.execute("stop", { sessionKey: "agent:other:dashboard:target" }),
    ).rejects.toThrow("disabled");
    expect(abortRequests(callGateway)).toEqual([]);
  });

  it("keeps explicit ownership of a global target separate from the caller", async () => {
    const { tool, callGateway } = setup({
      requester: "global",
      config: { ...config, session: { scope: "global" } },
    });
    await tool.execute("stop", { sessionKey: "global", agentId: "other" });
    expect(abortRequests(callGateway)[0]?.[0].params).toMatchObject({
      key: "global",
      agentId: "other",
    });
  });

  it("carries the resolved target agent instead of the caller", async () => {
    const { tool, callGateway } = setup();
    await tool.execute("stop", { sessionKey: "agent:other:dashboard:target" });
    expect(abortRequests(callGateway)[0]?.[0].params).toMatchObject({ agentId: "other" });
  });

  it("preserves idle and partial-stop receipts, and propagates Gateway denials", async () => {
    const { tool, callGateway } = setup();
    const idle = { ok: true, abortedRunId: null, status: "no-active-run" };
    callGateway.mockResolvedValueOnce({ key: target, agentId: "main" }).mockResolvedValueOnce(idle);
    expect((await tool.execute("idle", { sessionKey: target })).details).toEqual(idle);
    const partial = {
      ok: true,
      abortedRunId: "run-target",
      status: "aborted",
      warning: "One descendant is still stopping",
    };
    callGateway
      .mockResolvedValueOnce({ key: target, agentId: "main" })
      .mockResolvedValueOnce(partial);
    expect((await tool.execute("partial", { sessionKey: target })).details).toEqual(partial);
    const denied = new Error("Session is not writable");
    callGateway
      .mockResolvedValueOnce({ key: target, agentId: "main" })
      .mockRejectedValueOnce(denied);
    await expect(tool.execute("denied", { sessionKey: target })).rejects.toBe(denied);
  });
});
