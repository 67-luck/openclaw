import path from "node:path";
import { isTrustedInspectionCommand } from "../infra/exec-approvals-policy.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import {
  hasPosixShellStartupBeforeInlineCommand,
  POSIX_PARSEABLE_SHELL_WRAPPERS,
} from "../infra/shell-wrapper-resolution.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";
import { wrapPosixCommandWithPathPrepend } from "./bash-tools.exec-path-prepend.js";
import { buildGitHubExecLaunchArgv } from "./github-exec-launch.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";
import { getShellConfig } from "./shell-utils.js";

/** A pinned reader cannot attest startup code or a PATH-selected shell transport. */
export function canBindHostInspection(
  params: Pick<ProcessGatewayAllowlistParams, "command" | "workdir" | "env" | "trustedSafeBinDirs">,
): boolean {
  // Generic file-inspection bindings currently require a POSIX authorization plan.
  if (process.platform === "win32") {
    return false;
  }
  const { shell, args } = getShellConfig();
  const argv = [shell, ...args, params.command];
  return (
    path.isAbsolute(shell) &&
    POSIX_PARSEABLE_SHELL_WRAPPERS.has(path.basename(shell)) &&
    !hasPosixShellStartupBeforeInlineCommand(argv) &&
    isTrustedInspectionCommand(
      resolveCommandResolutionFromArgv(argv, params.workdir, params.env) ?? undefined,
      params.trustedSafeBinDirs,
    )
  );
}

export async function prepareHostExecSpawn(params: {
  command: string;
  execCommand?: string;
  workdir: string;
  env: Record<string, string>;
  pathPrepend?: string[];
  githubProfileDir?: string;
  usePty: boolean;
}) {
  const { shell, args: shellArgs } = getShellConfig();
  const commandWithPathPrepend = wrapPosixCommandWithPathPrepend(
    params.execCommand ?? params.command,
    params.env,
    params.pathPrepend,
  );
  const commandWithShellSnapshot = await maybeWrapCommandWithShellSnapshot({
    // A bound execution plan must not load aliases/functions or replace its PATH.
    enabled: params.execCommand === undefined,
    command: commandWithPathPrepend,
    shell,
    shellArgs,
    cwd: params.workdir,
    env: params.env,
  });
  const shellArgv = [shell, ...shellArgs, commandWithShellSnapshot];
  return {
    mode: params.usePty ? ("pty" as const) : ("child" as const),
    argv: params.githubProfileDir
      ? buildGitHubExecLaunchArgv(shellArgv, params.githubProfileDir)
      : shellArgv,
    env: params.env,
    cwd: params.workdir,
    stdinMode: params.usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
  };
}
