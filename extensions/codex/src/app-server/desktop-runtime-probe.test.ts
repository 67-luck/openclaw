import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexComputerUseConfig } from "./config.js";
import { probeCodexDesktopRuntime } from "./desktop-runtime-probe.js";

const fake = vi.hoisted(() => ({
  start: vi.fn(),
  initialize: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  closeAndWait: vi.fn(),
  marketplace: vi.fn(),
  service: vi.fn(),
  bridge: vi.fn(),
  readiness: vi.fn(),
  tempRoot: vi.fn(),
  getServerVersion: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/temp-path", () => ({ resolvePreferredOpenClawTmpDir: fake.tempRoot }));
vi.mock("./client.js", () => ({ CodexAppServerClient: { start: fake.start } }));
vi.mock("./computer-use-marketplace.js", () => ({
  ensureCodexManagedBundledMarketplace: fake.marketplace,
}));
vi.mock("./computer-use-service.js", () => ({ ensureCodexComputerUseServiceApp: fake.service }));
vi.mock("./computer-use-node-repl.js", () => ({
  resolveCodexComputerUseNodeReplStartArgs: fake.bridge,
  assertCodexDesktopComputerUseProbeSupported: vi.fn(),
}));
vi.mock("./computer-use.js", () => ({ readCodexComputerUseStatus: fake.readiness }));

function probeHome(): string {
  const home: unknown = fake.start.mock.calls[0]?.[0]?.env?.CODEX_HOME;
  if (typeof home !== "string" || !home) {
    throw new Error("Expected the probe to start with a disposable Codex home");
  }
  return home;
}

describe("disposable selected-runtime validation", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    vi.resetAllMocks();
    fake.tempRoot.mockReturnValue(dirs.make("codex-probe-private-"));
    fake.start.mockResolvedValue(fake);
    fake.getServerVersion.mockReturnValue("0.160.0");
    fake.closeAndWait.mockResolvedValue({ exited: true, cleanup: "closed" });
    fake.request.mockImplementation(async (method) =>
      method === "model/list"
        ? {
            data: [
              {
                id: "test-model",
                model: "test-model",
                displayName: "Test model",
                description: "Fixture model",
                defaultReasoningEffort: "medium",
                hidden: true,
                isDefault: false,
                inputModalities: ["text"],
                supportedReasoningEfforts: [],
              },
            ],
          }
        : {},
    );
    fake.marketplace.mockImplementation(async ({ codexHome }) => {
      const marketplace = path.join(codexHome, "marketplace");
      await fs.mkdir(marketplace);
      return marketplace;
    });
    fake.service.mockImplementation(async ({ codexHome }) => ({
      status: "installed",
      targetPath: path.join(codexHome, "computer-use", "Codex Computer Use.app"),
    }));
    fake.bridge.mockImplementation(async ({ args }) => args);
    fake.readiness.mockResolvedValue({ ready: true, liveTest: { ok: true } });
  });

  async function fixture(requiresComputerUse = false) {
    const root = dirs.make("codex-probe-test-");
    const appBundlePath = path.join(root, "ChatGPT.app");
    const command = requiresComputerUse
      ? path.join(appBundlePath, "Contents/Resources/codex")
      : path.join(root, "cli", "bin", "codex.js");
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "synthetic executable", { mode: 0o700 });
    if (requiresComputerUse) {
      const plugin = path.join(
        appBundlePath,
        "Contents/Resources/plugins/openai-bundled/plugins/computer-use/.codex-plugin",
      );
      await fs.mkdir(plugin, { recursive: true });
      await fs.writeFile(path.join(plugin, "plugin.json"), '{"version":"1.0.0"}');
    }
    const codexHome = path.join(root, "real-home");
    await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, "auth.json"), "fixture-not-a-real-secret");
    const controller = new AbortController();
    const agent = {
      model: "test-model",
      codexHome,
      computerUse: resolveCodexComputerUseConfig({
        pluginConfig: { computerUse: { enabled: requiresComputerUse, autoInstall: true } },
      }),
      requiresComputerUse,
    };
    return {
      appBundlePath: requiresComputerUse ? appBundlePath : undefined,
      command: requiresComputerUse ? undefined : command,
      agents: [agent] as const,
      signal: controller.signal,
      assertCurrent: vi.fn(),
      controller,
      root,
    };
  }

  it("uses hidden metadata without credentials or inference and joins the client before cleanup", async () => {
    const f = await fixture();
    fake.closeAndWait.mockImplementation(async () => {
      const home = probeHome();
      await expect(fs.stat(home)).resolves.toBeDefined();
      await expect(fs.stat(path.join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
      return { exited: true, cleanup: "closed" };
    });
    await probeCodexDesktopRuntime(f);
    expect(fake.request).toHaveBeenCalledWith(
      "model/list",
      expect.objectContaining({ includeHidden: true }),
      expect.anything(),
    );
    expect(fake.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(probeHome()).not.toBe(f.agents[0].codexHome);
    await expect(fs.stat(probeHome())).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(f.agents[0].codexHome, "auth.json"), "utf8")).resolves.toBe(
      "fixture-not-a-real-secret",
    );
  });

  it("qualifies the selected package launcher under retained process-tree ownership", async () => {
    const f = await fixture();
    await probeCodexDesktopRuntime(f);
    expect(fake.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: f.command,
        env: { HOME: probeHome(), CODEX_HOME: probeHome(), USERPROFILE: probeHome() },
      }),
      expect.any(Function),
      { signal: f.signal, ownership: "retained-tree" },
    );
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
    await expect(fs.stat(probeHome())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a native version that differs from the acquired package metadata", async () => {
    const f = await fixture();
    await expect(probeCodexDesktopRuntime({ ...f, expectedVersion: "0.161.0" })).rejects.toThrow(
      "does not match its official package metadata",
    );
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
  });

  it("rejects a missing selected model and still joins the process", async () => {
    const f = await fixture();
    fake.request.mockResolvedValue({ data: [] });
    await expect(probeCodexDesktopRuntime(f)).rejects.toThrow("test-model is missing");
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
  });

  // Computer Use inspects a real macOS executable; shared protocol tests above use package CLI.
  it.runIf(process.platform !== "win32")(
    "canonicalizes temporary home and marketplace aliases before native config admission",
    async () => {
      const f = await fixture(true);
      const physical = path.join(f.root, "physical");
      const alias = path.join(f.root, "alias");
      await fs.mkdir(physical);
      await fs.symlink(physical, alias, "dir");
      fake.tempRoot.mockReturnValue(alias);
      fake.closeAndWait.mockImplementation(async () => {
        expect(probeHome()).toBe(await fs.realpath(probeHome()));
        const source = fake.readiness.mock.calls[0]?.[0]?.defaultBundledMarketplacePath;
        expect(source).toBe(await fs.realpath(source));
        expect(await fs.readFile(path.join(probeHome(), "config.toml"), "utf8")).toContain(
          JSON.stringify(source),
        );
        return { exited: true, cleanup: "closed" };
      });
      await probeCodexDesktopRuntime(f);
      expect(fake.readiness).toHaveBeenCalledOnce();
    },
  );

  it.runIf(process.platform !== "win32")(
    "requires actual Computer Use readiness, not just a signed CLI and plugin",
    async () => {
      const f = await fixture(true);
      fake.readiness.mockResolvedValue({
        ready: false,
        liveTest: { ok: false },
        message: "native bridge failed",
      });
      await expect(probeCodexDesktopRuntime(f)).rejects.toThrow("native bridge failed");
      expect(fake.readiness).toHaveBeenCalledWith(
        expect.objectContaining({
          overrides: expect.objectContaining({ autoInstall: false, autoRepair: false }),
        }),
      );
      expect(fake.closeAndWait).toHaveBeenCalledOnce();
    },
  );

  it.runIf(process.platform !== "win32")(
    "validates the retained service when automatic native installation is disabled",
    async () => {
      const f = await fixture(true);
      f.agents[0].computerUse.autoInstall = false;
      const wrapper = path.join(f.agents[0].codexHome, ".tmp/bundled-marketplaces/openai-bundled");
      await fs.mkdir(wrapper, { recursive: true });
      await fs.symlink(
        path.join(f.root, "ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins"),
        path.join(wrapper, "plugins"),
      );
      const config = `[plugins."computer-use@openai-bundled"]\nenabled=true\n[marketplaces.openai-bundled]\nsource_type="local"\nsource=${JSON.stringify(wrapper)}\n`;
      await fs.writeFile(path.join(f.agents[0].codexHome, "config.toml"), config);
      await probeCodexDesktopRuntime(f);
      expect(fake.service).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAppCandidates: [
            path.join(f.agents[0].codexHome, "computer-use/Codex Computer Use.app"),
          ],
        }),
      );
      expect(fake.service).toHaveBeenCalledWith(
        expect.objectContaining({ codexHome: probeHome() }),
      );
      expect(probeHome()).not.toBe(f.agents[0].codexHome);
      expect(await fs.readFile(path.join(f.agents[0].codexHome, "config.toml"), "utf8")).toBe(
        config,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not certify a different retained source when automatic installation is disabled",
    async () => {
      const f = await fixture(true);
      f.agents[0].computerUse.autoInstall = false;
      const retained = path.join(f.root, "retained-marketplace");
      await fs.mkdir(path.join(retained, "plugins/computer-use/.codex-plugin"), {
        recursive: true,
      });
      // Matching version strings do not prove the retained bytes or ownership match.
      await fs.writeFile(
        path.join(retained, "plugins/computer-use/.codex-plugin/plugin.json"),
        '{"version":"1.0.0"}',
      );
      const config = `[marketplaces.openai-bundled]\nsource_type="local"\nsource=${JSON.stringify(retained)}\n`;
      await fs.writeFile(path.join(f.agents[0].codexHome, "config.toml"), config);
      await expect(probeCodexDesktopRuntime(f)).rejects.toThrow(
        "autoInstall is disabled and its retained marketplace differs",
      );
      expect(fake.start).not.toHaveBeenCalled();
      expect(fake.service).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.agents[0].codexHome, "config.toml"), "utf8")).toBe(
        config,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not certify custom integrations using the official fixture",
    async () => {
      const f = await fixture(true);
      f.agents[0].computerUse.marketplacePath = "/custom/marketplace";
      await expect(probeCodexDesktopRuntime(f)).rejects.toThrow("custom source");
      expect(fake.start).not.toHaveBeenCalled();
    },
  );

  it("closes an in-flight raw client and prevents later validation after cancellation", async () => {
    const f = await fixture();
    fake.initialize.mockImplementation(async () => f.controller.abort(new Error("owner closed")));
    await expect(probeCodexDesktopRuntime(f)).rejects.toThrow("owner closed");
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
    expect(fake.readiness).not.toHaveBeenCalled();
  });

  it.each(["running", "uncertain", "rejected"] as const)(
    "retains private state and rejects publication when native shutdown is %s",
    async (outcome) => {
      const f = await fixture();
      if (outcome === "rejected") {
        fake.closeAndWait.mockRejectedValue(new Error("shutdown failed"));
      } else {
        fake.closeAndWait.mockResolvedValue({
          exited: outcome !== "running",
          cleanup: "uncertain",
        });
      }
      await expect(probeCodexDesktopRuntime(f)).rejects.toMatchObject({
        code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
      });
      const home = probeHome();
      try {
        await expect(fs.stat(home)).resolves.toBeDefined();
      } finally {
        // The fake owns no processes; only the retained test fixture is removed.
        await fs.rm(path.dirname(home), { recursive: true, force: true });
      }
    },
  );
});
