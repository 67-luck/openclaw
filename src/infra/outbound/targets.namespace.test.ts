import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveHeartbeatDeliveryTargetWithSessionRoute } from "./targets.js";
import { createTestChannelPlugin, createTargetsTestRegistry } from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-resolution.js")>()),
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

describe("outbound channel namespace targets", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    mocks.resolveOutboundChannelPlugin.mockReset();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("preserves exact heartbeat directory destinations before rejecting channel namespaces", async () => {
    const listGroups = vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]);
    const plugin = {
      ...createTestChannelPlugin({
        id: "alpha",
        label: "Alpha",
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) =>
            to
              ? { ok: true as const, to: `@${to.trim()}` }
              : { ok: false as const, error: new Error("target required") },
        },
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: { hint: "<channel>" },
          resolveOutboundSessionRoute: ({ target }) => ({
            sessionKey: `main:alpha:group:${target}`,
            baseSessionKey: `main:alpha:group:${target}`,
            peer: { kind: "group", id: target },
            chatType: "group",
            from: `alpha:group:${target}`,
            to: target,
          }),
        },
      }),
      directory: { listGroups },
    };
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: {} } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "alpha", to: "alpha" },
    });

    expect(resolved).toMatchObject({ channel: "alpha", to: "C123456" });
    expect(listGroups).toHaveBeenCalledWith(expect.objectContaining({ query: "alpha" }));
  });
});
