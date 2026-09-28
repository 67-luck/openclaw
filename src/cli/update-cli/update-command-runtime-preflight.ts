import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { compare, minVersion, Range, satisfies as satisfiesRange, validRange, valid } from "semver";
import { detectCurrentSqliteCapabilities, nodeRuntimeFailure } from "../../../node-sqlite.mjs";
import { SUPPORTED_NODE_VERSION_RANGE } from "../../../node-version.mjs";
import { resolveNodeRuntimeInfo } from "../../daemon/runtime-paths.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { tryReadJson } from "../../infra/json-files.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import {
  createUpdateFailureFact,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import {
  createRuntimeUpdateRecoverySteps,
  formatUpdateRecoverySteps,
  type UpdateRecoveryStep,
} from "../../shared/update-outcome.js";
import { resolveNodeVersionManager } from "../../shared/version-manager-path.js";
import { formatCliCommand } from "../command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import { resolveNodeRunner } from "./shared.js";
import type { PackageRuntimeRecovery } from "./update-command-node-runtime-resolution.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { resolveServiceRecoveryContext } from "./update-command-service-env.js";
import { gatewayServiceCommandUsesRoot } from "./update-command-service-plan.js";

export type PackageRuntimePreflight = {
  nodeRunner?: string;
  replacedNodeRunner?: string;
  targetVersion?: string;
};

export async function resolvePackageRuntimePreflight(params: {
  channel?: UpdateChannel;
  requestedChannel?: UpdateChannel | null;
  target?: { version: string; nodeEngine: string | null };
  installedRoot?: string;
  timeoutMs?: number;
  nodeRunner?: string;
  root?: string;
  shouldRestart?: boolean;
  alreadyCurrent?: boolean;
  service?: PreManagedServiceStop;
  invocationCwd?: string;
  /** An already-current source checkout retains its launcher across a global-prefix switch. */
  sourceRoot?: string;
  fallbackNodeRunner?: string;
  runtimeRecovery?: PackageRuntimeRecovery;
}): Promise<
  Result<PackageRuntimePreflight, string> & {
    failureFacts?: UpdateFailureFact[];
    recoverySteps?: UpdateRecoveryStep[];
  }
> {
  return await withCommandProcessScope(async () => {
    const nodeRunner = normalizeOptionalString(
      params.alreadyCurrent &&
        !(
          params.service?.serviceUpdateVerdict?.kind === "owned" &&
          params.service.serviceUpdateVerdict.requiresInstallRootRefresh
        )
        ? (params.service?.serviceNodeRunner ?? params.nodeRunner)
        : params.nodeRunner,
    );
    const unchanged = (): PackageRuntimePreflight => (nodeRunner ? { nodeRunner } : {});
    let target = params.target;
    if (!target && params.installedRoot) {
      const manifest = asNullableRecord(
        await tryReadJson<unknown>(path.join(params.installedRoot, "package.json"), {
          maxBytes: 1024 * 1024,
        }),
      );
      const version = normalizeOptionalString(manifest?.version);
      if (!version) {
        return resultError(
          "Cannot inspect the installed OpenClaw runtime requirement; repair its package.json before retrying openclaw update.",
        );
      }
      target = {
        version,
        nodeEngine: normalizeOptionalString(asNullableRecord(manifest?.engines)?.node) ?? null,
      };
    }
    if (!target) {
      return ok(unchanged());
    }
    // The current Bun already passed its startup guard; Node engines do not apply.
    if (!nodeRunner && process.versions.bun) {
      return ok({ ...unchanged(), targetVersion: target.version });
    }
    const runtime = await resolvePackageRuntimeForPreflight({
      nodeRunner,
      timeoutMs: params.timeoutMs,
    });
    const satisfies = runtime.failure
      ? false
      : nodeVersionSatisfiesEngine(runtime.version, target.nodeEngine);
    const targetVersion = target.version;
    const unchangedRuntime = { ...unchanged(), targetVersion };
    if (satisfies === true) {
      return ok(unchangedRuntime);
    }
    const canRefreshCurrentService =
      params.service?.running &&
      params.service.serviceUpdateVerdict?.kind === "owned" &&
      params.service.serviceUpdateVerdict.refreshDefinition;
    const fallbackNodeRunner =
      params.fallbackNodeRunner ??
      (params.shouldRestart &&
      !process.versions.bun &&
      nodeRunner &&
      (params.alreadyCurrent
        ? canRefreshCurrentService
        : await gatewayServiceCommandUsesRoot({ root: params.root }))
        ? resolveNodeRunner()
        : undefined);
    if (nodeRunner && fallbackNodeRunner && fallbackNodeRunner !== nodeRunner) {
      const fallbackRuntime = await resolvePackageRuntimeForPreflight({
        nodeRunner: fallbackNodeRunner,
        timeoutMs: params.timeoutMs,
      });
      const fallbackSatisfies = fallbackRuntime.failure
        ? false
        : nodeVersionSatisfiesEngine(fallbackRuntime.version, target.nodeEngine);
      if (fallbackSatisfies === true) {
        return ok({
          nodeRunner: fallbackNodeRunner,
          replacedNodeRunner: nodeRunner,
          targetVersion,
        });
      }
    }
    if (satisfies !== false) {
      return ok(unchangedRuntime);
    }
    if (params.runtimeRecovery && target.nodeEngine) {
      const { resolveTargetNodeRuntime } =
        await import("./update-command-node-runtime-resolution.js");
      const recovered = await resolveTargetNodeRuntime({
        engine: target.nodeEngine,
        recovery: params.runtimeRecovery,
        timeoutMs: params.timeoutMs,
      });
      if (recovered) {
        return ok({
          nodeRunner: recovered,
          replacedNodeRunner: nodeRunner ?? resolveNodeRunner(),
          targetVersion,
        });
      }
    }
    const runtimeLabel = runtime.nodeRunner
      ? `Node ${runtime.version ?? "unknown"} at ${runtime.nodeRunner}`
      : `Node ${runtime.version ?? "unknown"}`;
    const engineRange = target.nodeEngine ? validRange(target.nodeEngine) : null;
    const minimum = engineRange
      ? (minVersion(engineRange)?.version ?? "unspecified")
      : "unspecified";
    const recommendation = minimumSupportedNodeVersion(engineRange ?? "*");
    const requirement = target.nodeEngine ? `Node ${target.nodeEngine}` : "a working Node runtime";
    const verdict = params.service?.serviceUpdateVerdict;
    const context =
      verdict?.kind === "owned" && params.service?.serviceEnv
        ? resolveServiceRecoveryContext({
            serviceEnv: params.service.serviceEnv,
            serviceDefinitionEnv: params.service.serviceDefinitionEnv,
            invocationCwd: params.invocationCwd,
          })
        : undefined;
    const env = context?.env ?? params.service?.serviceEnv ?? process.env;
    const recoveryVersion = valid(targetVersion);
    const recoveryChannel =
      params.requestedChannel ??
      (params.channel === "extended-stable" ? params.channel : undefined);
    const recoveryTarget = [
      "openclaw update",
      recoveryChannel ? `--channel ${recoveryChannel}` : "",
      params.sourceRoot || params.channel === "extended-stable" ? "" : `--tag ${recoveryVersion}`,
    ]
      .filter(Boolean)
      .join(" ");
    const retainedRoot = params.sourceRoot ?? params.root ?? params.installedRoot;
    const retainedEntry = retainedRoot ? path.resolve(retainedRoot, "openclaw.mjs") : undefined;
    const continuation = retainedEntry
      ? formatCliCommand(recoveryTarget, env).replace(
          /^openclaw\b/,
          () =>
            `node ${process.platform === "win32" ? quotePowerShellArg(retainedEntry) : quoteCliArg(retainedEntry)}`,
        )
      : undefined;
    const recoverySteps =
      recommendation && recoveryVersion
        ? createRuntimeUpdateRecoverySteps({
            nodeVersion: recommendation,
            targetVersion: recoveryVersion,
            manager: resolveNodeVersionManager(
              await tryRealpathOrResolve(runtime.nodeRunner ?? resolveNodeRunner()),
              env,
            ),
            container: isContainerEnvironment(),
            contextCommand: context?.command,
            continuation,
          })
        : undefined;
    if (
      recoverySteps?.at(-1)?.kind === "continue-update" &&
      params.alreadyCurrent &&
      nodeRunner &&
      params.service?.serviceNodeRunner &&
      !canRefreshCurrentService
    ) {
      recoverySteps.splice(-1, 0, {
        kind: "select-runtime",
        instruction: `The Gateway service still selects ${nodeRunner}. Before continuing, have its deployment owner select Node ${recommendation} in the service definition while retaining its installation, service account, and state/config selectors. Switching the shell runtime alone does not update that service definition.`,
      });
    }
    const upgrade = recoverySteps
      ? `Recovery:\n${formatUpdateRecoverySteps(recoverySteps)}`
      : recommendation
        ? "Select a published OpenClaw version before installing it under a supported Node runtime."
        : `No Node version satisfies both this range and this updater's supported range (${SUPPORTED_NODE_VERSION_RANGE}). This candidate version cannot be run by this updater with a supported Node release; install a supported Node and select a compatible OpenClaw target.`;
    return {
      ...(recoverySteps ? { recoverySteps } : {}),
      ...resultError<PackageRuntimePreflight, string>(
        [
          `openclaw@${targetVersion} requires ${requirement}; selected runtime is ${runtimeLabel}.`,
          ...(runtime.failure ? [runtime.failure] : []),
          upgrade,
        ].join("\n"),
      ),
      failureFacts: [
        createUpdateFailureFact({
          check: "node-runtime",
          code: "node-runtime-preflight",
          affectedKey: "engines.node",
          message: `Target package: openclaw@${valid(targetVersion) ?? "unknown"}; Minimum Node engine: ${minimum}; Running Node: ${valid(runtime.version ?? "") ?? "unknown"}`,
        }),
      ],
    };
  });
}

function minimumSupportedNodeVersion(engineRange: string): string | undefined {
  const candidate = new Range(engineRange);
  return new Range(SUPPORTED_NODE_VERSION_RANGE).set
    .flatMap((supported) =>
      candidate.set.flatMap((required) => {
        const intersection = [...supported, ...required].map((entry) => entry.value).join(" ");
        const minimum = minVersion(intersection);
        if (!minimum) {
          return [];
        }
        // Node's release contract excludes prereleases, even when engines allow them.
        const release = `${minimum.major}.${minimum.minor}.${minimum.patch}`;
        return satisfiesRange(release, intersection) ? [release] : [];
      }),
    )
    .toSorted(compare)[0];
}

async function resolvePackageRuntimeForPreflight(params: {
  nodeRunner?: string;
  timeoutMs?: number;
}): Promise<{ version: string | null; nodeRunner?: string; failure: string | null }> {
  const nodeRunner = normalizeOptionalString(params.nodeRunner);
  if (!nodeRunner) {
    const version = process.versions.node ?? null;
    return {
      version,
      failure: nodeRuntimeFailure(version, await detectCurrentSqliteCapabilities()),
    };
  }
  const runtime = await resolveNodeRuntimeInfo(
    nodeRunner,
    process.env,
    params.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
  );
  return {
    version: runtime.status === "probe-failed" ? null : runtime.version,
    failure:
      runtime.status === "probe-failed" ? runtime.error.message : (runtime.capabilityError ?? null),
    nodeRunner,
  };
}

async function tryRealpathOrResolve(value: string): Promise<string> {
  return await fs.realpath(path.resolve(value)).catch(() => path.resolve(value));
}
