import { vi } from "vitest";

export function createUpdateCliConfigMock() {
  const readConfigFileSnapshot = vi.fn();
  return {
    createConfigIO: (
      options: {
        pluginValidation?: string;
        observe?: boolean;
        suppressFutureVersionWarning?: boolean;
      } = {},
    ) => ({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: await readConfigFileSnapshot({
          ...(options.pluginValidation === "skip" ? { skipPluginValidation: true } : {}),
          ...(options.observe !== undefined ? { observe: options.observe } : {}),
          ...(options.suppressFutureVersionWarning !== undefined
            ? { suppressFutureVersionWarning: options.suppressFutureVersionWarning }
            : {}),
        }),
        writeOptions: {},
      }),
    }),
    assertConfigWriteAllowedInCurrentMode: () => {
      if (process.env.OPENCLAW_NIX_MODE === "1") {
        throw new Error(
          [
            "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
            "Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
            "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
            "OpenClaw Nix overview: https://docs.openclaw.ai/install/nix",
          ].join("\n"),
        );
      }
    },
    ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ConfigMutationConflictError";
      }
    },
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    readConfigFileSnapshot,
    readSourceConfigBestEffort: vi.fn(),
    mutateConfigFileWithRetry: vi.fn(),
    replaceConfigFile: vi.fn(),
    resolveGatewayPort: vi.fn(() => 18789),
  };
}
