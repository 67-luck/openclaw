import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  HealthCheck,
  HealthCheckContext,
  HealthRepairContext,
  HealthFinding,
  PluginRuntimeMaintenanceContextV1,
} from "openclaw/plugin-sdk/health";
import type {
  OpenClawPluginServiceV2,
  OpenClawPluginServiceContextV2,
  PluginServiceSchedulerV1,
} from "openclaw/plugin-sdk/plugin-entry";
import { commandProcessCleanup } from "openclaw/plugin-sdk/process-runtime";
import { resolveCodexAppServerLocalHomeDir } from "./app-server/auth-start-options.js";
import { codexConfigEnablesNativeComputerUse } from "./app-server/config-reviewer-policy.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
  resolveCodexComputerUseConfig,
} from "./app-server/config.js";
import {
  resolveMacOSDesktopCodexAppPathCandidateForBundle,
  resolveMacOSDesktopCodexAppBundlePath,
  resolveMacOSDesktopCodexAppPathCandidates,
} from "./app-server/desktop-app-paths.js";
import { updateCodexDesktopApp } from "./app-server/desktop-app-update.js";
import {
  probeCodexDesktopRuntime,
  type CodexDesktopRuntimeProbeAgent,
} from "./app-server/desktop-runtime-probe.js";
import { resolveManagedCodexAppServerStartOptions } from "./app-server/managed-binary.js";

const CHECK_ID = "codex/selected-runtime";
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000;

type DesktopTarget = {
  path: string;
  appBundlePath?: string;
  command?: string;
  agents: CodexDesktopRuntimeProbeAgent[];
};

type MaintenanceDependencies = {
  platform?: NodeJS.Platform;
  resolveCommand?: typeof resolveManagedCodexAppServerStartOptions;
  updateApp?: typeof updateCodexDesktopApp;
  probe?: typeof probeCodexDesktopRuntime;
  updateCli?: typeof import("./app-server/managed-cli-update.js").updateCodexManagedCli;
};

function finding(target: DesktopTarget, message: string): HealthFinding {
  return {
    checkId: CHECK_ID,
    source: "codex",
    severity: "warning",
    path: target.path,
    message,
    fixHint: "Run openclaw plugins update codex to retry selected-runtime maintenance.",
  };
}

/** Fresh operation-owned checks, never registered in the process-wide Doctor registry. */
export function createCodexRuntimeMaintenanceChecks(
  operation: PluginRuntimeMaintenanceContextV1,
  deps: MaintenanceDependencies = {},
): readonly HealthCheck[] {
  const assertCurrent = () => {
    operation.signal.throwIfAborted();
    operation.assertCurrent();
  };
  const probe = deps.probe ?? probeCodexDesktopRuntime;
  const updateApp = deps.updateApp ?? updateCodexDesktopApp;
  const completed = new Map<string, string>();

  async function selectTargets(ctx: HealthCheckContext): Promise<DesktopTarget[]> {
    assertCurrent();
    if (ctx.cfg.plugins?.enabled === false || ctx.cfg.plugins?.entries?.codex?.enabled === false) {
      return [];
    }
    const env = ctx.env ?? process.env;
    const pluginConfig = ctx.cfg.plugins?.entries?.codex?.config;
    const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig, env });
    if (runtime.start.transport !== "stdio" || runtime.start.commandSource !== "managed") {
      return [];
    }
    const computerUse = resolveCodexComputerUseConfig({ pluginConfig, env });
    const targets = new Map<string, DesktopTarget>();
    for (const agentId of listAgentIds(ctx.cfg)) {
      const model = resolveDefaultModelForAgent({ cfg: ctx.cfg, agentId });
      if (
        resolveEffectiveAgentRuntime({
          cfg: ctx.cfg,
          provider: model.provider,
          modelId: model.model,
          agentId,
        }) !== "codex"
      ) {
        continue;
      }
      const agentDir = resolveAgentDir(ctx.cfg, agentId, env);
      const start = resolveCodexAppServerStartOptionsForAgent({
        startOptions: runtime.start,
        agentDir,
        env,
      });
      const selected = await (deps.resolveCommand ?? resolveManagedCodexAppServerStartOptions)(
        start,
        { pluginRoot: operation.pluginRoot, env, platform: deps.platform },
      );
      assertCurrent();
      const desktop =
        resolveMacOSDesktopCodexAppPathCandidates(deps.platform ?? process.platform).find(
          (candidate) => candidate.appServerCommandPath === selected.command,
        ) ??
        resolveMacOSDesktopCodexAppPathCandidateForBundle(
          resolveMacOSDesktopCodexAppBundlePath(selected.command) ?? "",
          { platform: deps.platform ?? process.platform },
        );
      const key = desktop?.appBundlePath ?? "managed-cli";
      const target = targets.get(key) ?? {
        path: key,
        ...(desktop ? { appBundlePath: desktop.appBundlePath } : { command: selected.command }),
        agents: [],
      };
      target.agents.push({
        model: model.model,
        codexHome: resolveCodexAppServerLocalHomeDir(start, agentDir, env),
        startArgs: start.args,
        selectedAppServerCommand: selected.command,
        computerUse,
        requiresComputerUse:
          computerUse.enabled ||
          codexConfigEnablesNativeComputerUse({
            agentDir,
            homeScope: start.homeScope,
            codexHome: start.codexHome,
            env,
            pluginNames: start.managedComputerUsePluginNames ?? [computerUse.pluginName],
          }),
      });
      targets.set(key, target);
    }
    return [...targets.values()];
  }

  return [
    {
      id: CHECK_ID,
      source: "codex",
      kind: "plugin",
      description: "Update and verify the managed Codex runtime selected for conversations.",
      async detect(ctx, scope) {
        const targets = await selectTargets(ctx);
        const findings: HealthFinding[] = [];
        for (const target of targets) {
          // Acquisition already qualified the immutable generation before CAS. Verify
          // the resolver observes that selection without spawning a second probe.
          if (!scope || completed.get(target.path) !== (target.appBundlePath ?? target.command)) {
            findings.push(
              finding(target, "The selected managed Codex runtime needs an update check."),
            );
          }
        }
        return findings;
      },
      async repair(ctx, findings) {
        assertCurrent();
        if (ctx.dryRun) {
          return {
            status: "skipped",
            reason: "Dry run; no runtime download or selection change.",
            changes: [],
          };
        }
        const selectedPaths = new Set(findings.map((item) => item.path));
        const targets = (await selectTargets(ctx)).filter((target) =>
          selectedPaths.has(target.path),
        );
        const changes: string[] = [];
        const warnings: string[] = [];
        for (const target of targets) {
          try {
            if (target.appBundlePath) {
              const result = await updateApp({
                appBundlePath: target.appBundlePath,
                env: ctx.env,
                signal: operation.signal,
                assertCurrent,
                validateCandidate: async ({ appBundlePath }) => {
                  await probe({
                    ...target,
                    appBundlePath,
                    signal: operation.signal,
                    assertCurrent,
                  });
                },
              });
              assertCurrent();
              completed.set(result.appBundlePath, result.appBundlePath);
              changes.push(
                result.status === "updated"
                  ? `Selected verified Codex desktop ${result.oldVersion} -> ${result.newVersion}. Existing sessions retain their original generation.`
                  : `Selected Codex desktop is current (${result.newVersion}).`,
              );
              warnings.push(...(result.warnings ?? []));
            } else {
              const updateCli =
                deps.updateCli ??
                (await import("./app-server/managed-cli-update.js")).updateCodexManagedCli;
              const result = await updateCli({
                env: ctx.env,
                signal: operation.signal,
                assertCurrent,
                validateCandidate: async (command, expectedVersion) => {
                  await probe({
                    ...target,
                    command,
                    expectedVersion,
                    signal: operation.signal,
                    assertCurrent,
                  });
                },
              });
              assertCurrent();
              completed.set(target.path, result.command ?? target.command!);
              changes.push(
                `Managed Codex CLI ${result.status === "updated" ? "selected" : "is current"}: ${result.version}. Existing sessions retain their original generation.`,
              );
              warnings.push(...(result.warnings ?? []));
            }
          } catch (error) {
            if (commandProcessCleanup.isUncertain(error)) {
              throw error;
            }
            assertCurrent();
            warnings.push(
              `Selected Codex update failed for ${target.path}: ${coerceErrorMessage(error)}`,
            );
          }
        }
        return {
          status: warnings.length > 0 ? "failed" : "repaired",
          changes,
          warnings,
        };
      },
    },
  ];
}

/** The plugin service lifetime owns automatic invocation of the manual maintenance path. */
export function createCodexRuntimeMaintenanceService(params: {
  pluginRoot?: string;
  getConfig: () => OpenClawPluginServiceContextV2["config"];
}): OpenClawPluginServiceV2 & { getScheduler: () => PluginServiceSchedulerV1 | undefined } {
  let context: OpenClawPluginServiceContextV2 | undefined;
  return {
    apiVersion: 2,
    id: "codex-runtime-maintenance",
    getScheduler: () => context?.scheduler,
    start(ctx) {
      context = ctx;
      let failures = 0;
      const schedule = (delayMs: number) =>
        ctx.scheduler.schedule({
          id: "stable-runtime-update",
          delayMs,
          run: async () => {
            const cfg = params.getConfig();
            const assertCurrent = () => {
              ctx.scheduler.signal.throwIfAborted();
              if (context !== ctx || params.getConfig() !== cfg) {
                throw new Error("Codex maintenance service retired.");
              }
            };
            try {
              assertCurrent();
              // Match the host's explicit non-updating/rehearsal environments.
              if (
                process.env.OPENCLAW_NO_AUTO_UPDATE === "1" ||
                process.env.OPENCLAW_NIX_MODE === "1"
              ) {
                return;
              }
              if (!params.pluginRoot) {
                throw new Error(
                  "Codex maintenance needs the installed plugin root; reload the Codex plugin.",
                );
              }
              const checks = createCodexRuntimeMaintenanceChecks({
                operation: "update",
                pluginRoot: params.pluginRoot,
                signal: ctx.scheduler.signal,
                assertCurrent,
              });
              const healthContext: HealthRepairContext = {
                mode: "fix",
                cfg,
                env: process.env,
                runtime: {
                  log: (...args) => ctx.logger.info(args.map(String).join(" ")),
                  error: (...args) => ctx.logger.error(args.map(String).join(" ")),
                  exit: (code) => {
                    throw new Error(`Unexpected maintenance exit ${code}`);
                  },
                },
              };
              for (const check of checks) {
                const findings = await check.detect(healthContext);
                assertCurrent();
                if (findings.length && check.repair) {
                  const result = await check.repair(healthContext, findings);
                  assertCurrent();
                  if (result.status === "failed") {
                    throw new Error(result.warnings?.join("; ") || "Codex maintenance failed.");
                  }
                  for (const change of result.changes) {
                    ctx.logger.info(change);
                  }
                }
              }
              failures = 0;
              ctx.serviceHealth?.clearFailure();
            } catch (error) {
              if (ctx.scheduler.signal.aborted || context !== ctx) {
                return;
              }
              failures++;
              ctx.serviceHealth?.reportFailure(error);
              ctx.logger.warn(
                `Automatic Codex runtime update retained the working selection: ${coerceErrorMessage(error)}`,
              );
            }
            if (context === ctx && !ctx.scheduler.signal.aborted) {
              schedule(
                failures
                  ? Math.min(MAINTENANCE_INTERVAL_MS, 30 * 60_000 * 2 ** Math.min(failures - 1, 6))
                  : MAINTENANCE_INTERVAL_MS,
              );
            }
          },
        });
      schedule(60_000);
    },
    async stop() {
      const retiring = context;
      context = undefined;
      retiring?.scheduler.beginClose();
      await retiring?.scheduler.stop();
    },
  };
}
