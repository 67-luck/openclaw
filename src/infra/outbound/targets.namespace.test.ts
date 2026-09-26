import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
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

type NamespacePluginOptions = {
  listGroups: NonNullable<NonNullable<ChannelPlugin["directory"]>["listGroups"]>;
  messaging?: ChannelPlugin["messaging"];
  outbound?: ChannelPlugin["outbound"];
};

function createNamespacePlugin(options: NamespacePluginOptions): ChannelPlugin {
  return {
    ...createTestChannelPlugin({
      id: "alpha",
      label: "Alpha",
      outbound: options.outbound ?? { deliveryMode: "direct" },
      messaging:
        options.messaging ??
        ({
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => {
            const trimmed = raw.trim();
            return trimmed.startsWith("C") ? trimmed : `@${trimmed}`;
          },
          targetResolver: { looksLikeId: () => true, hint: "<channel>" },
          resolveOutboundSessionRoute: ({ target }) => ({
            sessionKey: `main:alpha:group:${target}`,
            baseSessionKey: `main:alpha:group:${target}`,
            peer: { kind: "group", id: target },
            chatType: "group",
            from: `alpha:group:${target}`,
            to: target,
          }),
        } satisfies NonNullable<ChannelPlugin["messaging"]>),
    }),
    directory: { listGroups: options.listGroups },
  };
}

async function resolveNamespaceHeartbeat(plugin: ChannelPlugin) {
  setActivePluginRegistry(createTargetsTestRegistry([plugin]));
  mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
  return await resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg: { channels: { alpha: {} } } as OpenClawConfig,
    agentId: "main",
    heartbeat: { target: "alpha", to: "alpha" },
  });
}

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
    const resolved = await resolveNamespaceHeartbeat(createNamespacePlugin({ listGroups }));

    expect(resolved).toMatchObject({ channel: "alpha", to: "C123456" });
    expect(listGroups).toHaveBeenCalledWith(expect.objectContaining({ query: "alpha" }));
  });

  it("rejects unmatched heartbeat channel namespaces before delivery", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({ listGroups: vi.fn().mockResolvedValue([]) }),
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it("fails closed when heartbeat namespace directory lookup throws", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockRejectedValue(new Error("directory unavailable")),
      }),
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it("fails closed when heartbeat namespace directory matches are ambiguous", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([
          { kind: "group", id: "C1", name: "alpha" },
          { kind: "group", id: "C2", name: "alpha" },
        ]),
      }),
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it.each([
    {
      name: "preserves an outbound-resolver target after a miss",
      entries: [],
      expected: { channel: "alpha", to: "@alpha" },
      outboundCalls: 1,
    },
    {
      name: "uses an exact directory destination",
      entries: [{ kind: "group", id: "C123456", name: "alpha" }],
      expected: { channel: "alpha", to: "C123456" },
      outboundCalls: 0,
    },
  ])(
    "validates heartbeat namespaces without optional messaging hooks: $name",
    async ({ entries, expected, outboundCalls }) => {
      const outboundResolveTarget = vi.fn(() => ({ ok: true as const, to: "@alpha" }));
      const resolved = await resolveNamespaceHeartbeat(
        createNamespacePlugin({
          listGroups: vi.fn().mockResolvedValue(entries),
          outbound: { deliveryMode: "direct", resolveTarget: outboundResolveTarget },
          messaging: { targetPrefixes: ["a"] },
        }),
      );

      expect(resolved).toMatchObject(expected);
      expect(outboundResolveTarget).toHaveBeenCalledTimes(outboundCalls);
    },
  );

  it("carries an exact directory target without a session-route hook", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: { hint: "<channel>" },
        },
      }),
    );

    expect(resolved).toMatchObject({ channel: "alpha", to: "C123456" });
  });

  it("preserves an explicit plugin-native heartbeat destination after a directory miss", async () => {
    const listGroups = vi.fn().mockResolvedValue([]);
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups,
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => raw.trim(),
          targetResolver: { looksLikeId: () => true, hint: "<nick>" },
        },
      }),
    );

    expect(resolved).toMatchObject({ channel: "alpha", to: "alpha" });
    expect(listGroups).toHaveBeenCalledWith(expect.objectContaining({ query: "alpha" }));
  });
});
