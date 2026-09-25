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
          normalizeTarget: (raw) => raw.trim(),
          targetResolver: { looksLikeId: () => true, hint: "<channel>" },
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

  it("rejects unmatched heartbeat channel namespaces before delivery", async () => {
    const plugin = {
      ...createTestChannelPlugin({
        id: "alpha",
        label: "Alpha",
        outbound: { deliveryMode: "direct" },
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => raw.trim(),
          targetResolver: { looksLikeId: () => true, hint: "<channel>" },
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
      directory: { listGroups: vi.fn().mockResolvedValue([]) },
    };
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: {} } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "alpha", to: "alpha" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it("fails closed when heartbeat namespace directory lookup throws", async () => {
    const plugin = {
      ...createTestChannelPlugin({
        id: "alpha",
        label: "Alpha",
        outbound: { deliveryMode: "direct" },
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => raw.trim(),
          targetResolver: { looksLikeId: () => true, hint: "<channel>" },
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
      directory: { listGroups: vi.fn().mockRejectedValue(new Error("directory unavailable")) },
    };
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: {} } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "alpha", to: "alpha" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it("fails closed when heartbeat namespace directory matches are ambiguous", async () => {
    const plugin = {
      ...createTestChannelPlugin({
        id: "alpha",
        label: "Alpha",
        outbound: { deliveryMode: "direct" },
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => raw.trim(),
          targetResolver: { looksLikeId: () => true, hint: "<channel>" },
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
      directory: {
        listGroups: vi.fn().mockResolvedValue([
          { kind: "group", id: "C1", name: "alpha" },
          { kind: "group", id: "C2", name: "alpha" },
        ]),
      },
    };
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);

    const resolved = await resolveHeartbeatDeliveryTargetWithSessionRoute({
      cfg: { channels: { alpha: {} } } as OpenClawConfig,
      agentId: "main",
      heartbeat: { target: "alpha", to: "alpha" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });
});
