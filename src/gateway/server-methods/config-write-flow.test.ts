import { beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";

const configMocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
}));
const secretsMocks = vi.hoisted(() => ({
  activeSnapshot: null as {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
  } | null,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    replaceConfigFile: configMocks.replaceConfigFile,
    resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
  };
});

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets/runtime-state.js")>();
  return {
    ...actual,
    getActiveSecretsRuntimeSnapshotState: () => secretsMocks.activeSnapshot,
  };
});

import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  shouldAwaitGatewayConfigApplication,
} from "./config-write-flow.js";

it("awaits transcript additions and title edits only when the reload owner can apply them", () => {
  const previousConfig: OpenClawConfig = {
    transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title: "Before" }] },
  };
  const nextConfig: OpenClawConfig = {
    transcripts: { autoStart: [{ providerId: "fixture", sessionId: "daily", title: "After" }] },
  };
  const params = { previousConfig, nextConfig, changedPaths: ["transcripts.autoStart"] };
  expect(shouldAwaitGatewayConfigApplication(params)).toBe(true);
  expect(shouldAwaitGatewayConfigApplication({ ...params, previousConfig: {} })).toBe(true);
  expect(
    shouldAwaitGatewayConfigApplication({
      ...params,
      changedPaths: [...params.changedPaths, "gateway.port"],
    }),
  ).toBe(false);
  expect(
    shouldAwaitGatewayConfigApplication({
      ...params,
      nextConfig: { ...nextConfig, gateway: { reload: { mode: "off" } } },
    }),
  ).toBe(false);
});

it.each(["hybrid", "off"] as const)(
  "hot-applies cold-storage settings with reload mode %s",
  (mode) => {
    expect(
      shouldAwaitGatewayConfigApplication({
        previousConfig: {},
        nextConfig: {
          gateway: { reload: { mode } },
          session: { maintenance: { coldStorage: { enabled: true, afterDays: 7 } } },
        },
        changedPaths: [
          "session.maintenance.coldStorage.enabled",
          "session.maintenance.coldStorage.afterDays",
        ],
      }),
    ).toBe(true);
  },
);

describe("commitGatewayConfigWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.resolveConfigSnapshotHash.mockReturnValue("missing-config-revision");
    configMocks.replaceConfigFile.mockResolvedValue({
      nextConfig: {},
      persistedHash: "persisted-hash",
    });
    secretsMocks.activeSnapshot = null;
  });

  it("carries a missing file revision into the lock-time compare-and-swap", async () => {
    const snapshot = {
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      hash: "missing-config-revision",
      sourceConfig: {},
    };

    await commitGatewayConfigWrite({
      snapshot: snapshot as never,
      writeOptions: {},
      nextConfig: {} satisfies OpenClawConfig,
    });

    expect(configMocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "missing-config-revision",
        sourceConfig: {},
      }),
    );
  });

  const voicePolicyConfig: OpenClawConfig = {
    talk: {
      realtime: {
        appLaunchPolicies: [
          {
            id: "calculator",
            agentId: "main",
            originatingDeviceId: "widget",
            nodeId: "node",
            appId: "linux-desktop:fixture.desktop",
            appRevision: "a".repeat(64),
            expiresAtMs: 2_000_000_000_000,
          },
        ],
      },
    },
  };
  const voiceWrite = () => ({
    snapshot: {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      hash: "base",
      sourceConfig: {},
    } as Parameters<typeof commitGatewayConfigWrite>[0]["snapshot"],
    writeOptions: {},
    nextConfig: voicePolicyConfig,
    client: sharingPolicyClient({ deviceId: "operator", scopes: ["operator.admin"] }),
    hasCurrentClientAuthority: () => true,
  });

  it("rejects reusable voice authority from missing or model-delegated operator intent", async () => {
    await expect(commitGatewayConfigWrite({ ...voiceWrite(), client: undefined })).rejects.toThrow(
      "explicit authenticated operator",
    );
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:test", fullPermission: true },
      async () => {
        await expect(commitGatewayConfigWrite(voiceWrite())).rejects.toThrow(
          "explicit authenticated operator",
        );
      },
    );
    expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("requires current operator authority at the actual config commit guard", async () => {
    let active = true;
    configMocks.replaceConfigFile.mockImplementationOnce(async (params) => {
      active = false;
      params.writeOptions.assertConfigPathForWrite();
      throw new Error("unreachable");
    });
    await expect(
      commitGatewayConfigWrite({ ...voiceWrite(), hasCurrentClientAuthority: () => active }),
    ).rejects.toThrow("explicit authenticated operator");
  });

  it("acknowledges a voice-policy write only after committed runtime application", async () => {
    let applicationClaim: ReturnType<
      NonNullable<ReturnType<typeof getRuntimeConfigWriteApplication>>["claim"]
    >;
    configMocks.replaceConfigFile.mockImplementationOnce(async (params) => {
      expect(params.writeOptions.runtimeRefresh.requireImmediateApplication).toBe(true);
      applicationClaim = getRuntimeConfigWriteApplication(params.writeOptions)!.claim();
      return { nextConfig: voicePolicyConfig, persistedHash: "voice-policy" };
    });
    let completed = false;
    const write = commitGatewayConfigWrite(voiceWrite()).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    applicationClaim!.settle("applied");
    await expect(write).resolves.toMatchObject({ hash: "voice-policy" });
  });

  it("returns the managed runtime application claimed during the write", async () => {
    configMocks.replaceConfigFile.mockImplementationOnce(async (params) => {
      const application = getRuntimeConfigWriteApplication(params.writeOptions);
      const claim = application?.claim();
      claim?.settle("applied");
      return {
        nextConfig: { hooks: { enabled: true } },
        persistedHash: "persisted-hash",
      };
    });

    const result = await commitGatewayConfigWrite({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        hash: "base-hash",
        sourceConfig: {},
      } as never,
      writeOptions: {},
      nextConfig: { hooks: { enabled: true } },
      awaitRuntimeApplication: true,
    });

    await expect(result.application).resolves.toBe("applied");
  });

  it("returns an unclaimed required application when no managed reloader is installed", async () => {
    const result = await commitGatewayConfigWrite({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        hash: "base-hash",
        sourceConfig: {},
      } as never,
      writeOptions: {},
      nextConfig: { hooks: { enabled: true } },
      awaitRuntimeApplication: true,
    });

    await expect(result.application).resolves.toBe("unclaimed");
  });
});

describe("didActiveSharedGatewayAuthChange", () => {
  beforeEach(() => {
    secretsMocks.activeSnapshot = null;
  });

  it("preserves runtime-only auth fields absent from the active secrets source", () => {
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "runtime-token" } },
    };
    secretsMocks.activeSnapshot = {
      sourceConfig: {},
      config: {},
    };

    expect(
      didActiveSharedGatewayAuthChange({ fallbackPrev: runtimeConfig, next: runtimeConfig }),
    ).toBe(false);
  });

  it("does not trust active secret values from a stale authored source", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token", token: "token-a" } } },
      config: { gateway: { auth: { mode: "token", token: "token-a" } } },
    };
    const current: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "token-b" } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: current,
        fallbackSource: current,
        next: { gateway: { auth: { mode: "token", token: "token-a" } } },
      }),
    ).toBe(true);
  });

  it("preserves runtime-only siblings beside authored shared auth fields", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token" } } },
      config: { gateway: { auth: { mode: "token" } } },
    };
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "runtime-token" } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: runtimeConfig,
        fallbackSource: { gateway: { auth: { mode: "token" } } },
        next: runtimeConfig,
      }),
    ).toBe(false);
  });

  it("uses active secret-expanded values when the authored source still matches", () => {
    const tokenRef = {
      source: "env" as const,
      provider: "default",
      id: "GATEWAY_TOKEN",
    };
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token", token: tokenRef } } },
      config: { gateway: { auth: { mode: "token", token: "old-token" } } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: { gateway: { auth: { mode: "token", token: tokenRef } } },
        fallbackSource: { gateway: { auth: { mode: "token", token: tokenRef } } },
        next: { gateway: { auth: { mode: "token", token: "new-token" } } },
      }),
    ).toBe(true);
  });
});
