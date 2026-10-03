import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi, type Mock } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  getLeasedSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

/** Registers under the shared suite's auth and physical-client cleanup owner. */
export function registerSharedClientDesktopStartupTests({
  mocks,
  createInitializingClientHarness,
  createStartOptions,
  sendInitializeResult,
}: {
  mocks: {
    desktopGeneration?: { epoch: number; fingerprint: string };
    desktopGenerationCurrent: boolean;
    waitForCodexDesktopGeneration: Mock;
    readCodexDesktopGenerationCandidates: Mock;
    resolveManagedCodexAppServerStartOptions: Mock;
    resolveCodexComputerUseNodeReplStartArgs: Mock;
  };
  createInitializingClientHarness: () => ReturnType<typeof createClientHarness>;
  createStartOptions: (options: Partial<CodexAppServerStartOptions>) => CodexAppServerStartOptions;
  sendInitializeResult: (
    harness: ReturnType<typeof createClientHarness>,
    version: string,
  ) => Promise<void>;
}) {
  it.each(["resolved-managed", "config"] as const)(
    "only prepares owned desktop commands without a generation service (%s)",
    async (commandSource) => {
      const harness = createInitializingClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const originalArgs = ["app-server"];
      const bridgeArgs = ["app-server", "-c", "mcp_servers.node_repl.enabled=true"];
      mocks.resolveCodexComputerUseNodeReplStartArgs.mockResolvedValue(bridgeArgs);
      const client = await getLeasedSharedCodexAppServerClient({
        timeoutMs: 1_000,
        agentDir: "/tmp/openclaw-agent",
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          commandSource,
          args: originalArgs,
          headers: {},
        },
      });
      expect(readCodexAppServerClientDesktopGeneration(client)).toBeUndefined();
      if (commandSource === "resolved-managed") {
        expect(mocks.resolveCodexComputerUseNodeReplStartArgs).toHaveBeenCalledOnce();
        expect(startSpy).toHaveBeenCalledWith(
          expect.objectContaining({ args: bridgeArgs }),
          expect.any(Function),
        );
      } else {
        expect(mocks.resolveCodexComputerUseNodeReplStartArgs).not.toHaveBeenCalled();
        expect(startSpy).toHaveBeenCalledWith(
          expect.objectContaining({ args: originalArgs }),
          expect.any(Function),
        );
      }
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    },
  );

  it.each([
    {
      name: "explicitly named official marketplace",
      computerUse: { enabled: true, marketplaceName: "openai-bundled" },
      nativeEnabled: false,
      ownsBridge: true,
    },
    {
      name: "native-only official plugin",
      computerUse: { enabled: false },
      nativeEnabled: true,
      ownsBridge: true,
    },
    ...[
      { marketplaceName: "custom-marketplace" },
      { pluginName: "custom-plugin" },
      { mcpServerName: "custom-server" },
      { marketplaceSource: "https://example.invalid/plugins" },
      { marketplacePath: "/custom/marketplace.json" },
    ].map((integration) => ({
      name: `custom ${Object.keys(integration)[0]} with an enabled native plugin`,
      computerUse: { enabled: true, ...integration },
      nativeEnabled: true,
      ownsBridge: false,
    })),
  ])("respects startup ownership for $name", async ({ computerUse, nativeEnabled, ownsBridge }) => {
    await withTempDir("codex-native-ownership-", async (agentDir) => {
      const nativeConfig = path.join(agentDir, "codex-home", "config.toml");
      if (nativeEnabled) {
        await fs.mkdir(path.dirname(nativeConfig), { recursive: true });
        await fs.writeFile(nativeConfig, '[plugins."computer-use@openai-bundled"]\nenabled=true\n');
      }
      const harness = createInitializingClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const originalArgs = ["app-server"];
      const bridgeArgs = ["app-server", "-c", "mcp_servers.node_repl.enabled=true"];
      mocks.resolveCodexComputerUseNodeReplStartArgs.mockResolvedValue(bridgeArgs);
      const client = await getLeasedSharedCodexAppServerClient({
        timeoutMs: 1_000,
        agentDir,
        pluginConfig: { computerUse },
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          commandSource: "resolved-managed",
          args: originalArgs,
          headers: {},
        },
      });
      if (ownsBridge) {
        expect(mocks.resolveCodexComputerUseNodeReplStartArgs).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            codexHome: path.dirname(nativeConfig),
            enabled: computerUse.enabled,
          }),
        );
      } else {
        expect(mocks.resolveCodexComputerUseNodeReplStartArgs).not.toHaveBeenCalled();
      }
      expect(startSpy).toHaveBeenCalledWith(
        expect.objectContaining({ args: ownsBridge ? bridgeArgs : originalArgs }),
        expect.any(Function),
      );
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
    });
  });

  it("rejects a lost generation snapshot through the existing bounded selection retry classifier", async () => {
    mocks.desktopGeneration = { epoch: 1, fingerprint: "superseded" };
    mocks.readCodexDesktopGenerationCandidates.mockReturnValue(undefined);
    await expect(
      getLeasedSharedCodexAppServerClient({
        agentDir: "/tmp/openclaw-agent",
        timeoutMs: 1_000,
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "codex",
          commandSource: "managed",
          managedCommandOrder: "desktop-first",
          args: ["app-server"],
          headers: {},
        },
      }),
    ).rejects.toMatchObject({ code: "CODEX_APP_SERVER_START_SELECTION_CHANGED" });
    expect(mocks.resolveManagedCodexAppServerStartOptions).not.toHaveBeenCalled();
  });

  it("waits for a dirty desktop generation before reusing a warm managed client", async () => {
    const generation = { epoch: 1, fingerprint: "desktop-x" };
    mocks.desktopGeneration = generation;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const config = {};
    const startOptions: CodexAppServerStartOptions = createStartOptions({
      homeScope: "agent",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
    });
    const options = { config, startOptions, agentDir: "/tmp/openclaw-agent" };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    const first = await firstAcquire;
    expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledWith(
      expect.any(Object),
      { desktopCandidates: mocks.readCodexDesktopGenerationCandidates.mock.results[0]?.value },
    );
    const dirty = createDeferred<typeof generation>();
    mocks.desktopGenerationCurrent = false;
    mocks.waitForCodexDesktopGeneration.mockReturnValue(dirty.promise);
    let settled = false;
    const secondAcquire = getLeasedSharedCodexAppServerClient(options).then((client) => {
      settled = true;
      return client;
    });

    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(startSpy).toHaveBeenCalledOnce();
    } finally {
      mocks.desktopGenerationCurrent = true;
      dirty.resolve(generation);
      await secondAcquire;
    }
    await expect(secondAcquire).resolves.toBe(first);
    expect(startSpy).toHaveBeenCalledOnce();
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
  });
}
