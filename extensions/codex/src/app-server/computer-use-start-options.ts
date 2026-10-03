/** Desktop startup composes generation ownership with the official native bridge. */
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { resolveCodexComputerUseNodeReplStartArgs } from "./computer-use-node-repl.js";
import type {
  CodexAppServerStartOptions,
  ResolvedCodexComputerUseConfig,
} from "./config-contracts.js";
import { resolveCodexComputerUseConfig } from "./config-runtime.js";
import { isManagedCodexDesktopCommand } from "./managed-binary.js";

export async function prepareManagedCodexComputerUseStartOptions(
  startOptions: CodexAppServerStartOptions,
  computerUseConfig: ResolvedCodexComputerUseConfig,
  agentDir?: string,
): Promise<CodexAppServerStartOptions> {
  if (
    (startOptions.commandSource !== "managed" &&
      startOptions.commandSource !== "resolved-managed") ||
    !isManagedCodexDesktopCommand(startOptions.command) ||
    computerUseConfig.pluginName !== "computer-use" ||
    computerUseConfig.mcpServerName !== "computer-use" ||
    computerUseConfig.marketplaceSource ||
    computerUseConfig.marketplacePath ||
    (computerUseConfig.marketplaceName && computerUseConfig.marketplaceName !== "openai-bundled")
  ) {
    return startOptions;
  }
  const args = await resolveCodexComputerUseNodeReplStartArgs({
    appServerCommand: startOptions.command,
    codexHome: resolveCodexAppServerLocalHomeDir(startOptions, agentDir),
    args: startOptions.args,
    // The native plugin can be enabled independently of OpenClaw's hint.
    enabled: computerUseConfig.enabled,
  });
  return args === startOptions.args ? startOptions : { ...startOptions, args };
}

export function shouldTrackDesktopGeneration(
  startOptions: CodexAppServerStartOptions,
  pluginConfig: unknown,
): boolean {
  if (startOptions.transport !== "stdio") {
    return false;
  }
  // A managed package process can publish desktop-owned Computer Use artifacts,
  // so both share one generation. Custom operator commands remain independent.
  if (
    resolveCodexComputerUseConfig({ pluginConfig }).enabled &&
    (startOptions.commandSource === "managed" || startOptions.commandSource === "resolved-managed")
  ) {
    return true;
  }
  return (
    startOptions.commandSource === "managed" &&
    (startOptions.managedCommandOrder ?? "package-first") === "desktop-first"
  );
}
