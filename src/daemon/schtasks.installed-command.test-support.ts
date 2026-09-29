import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { formatCommandOutput } from "../process/command-error.js";
import type { InstalledUpdateRetirementBinding } from "./schtasks.installed-retirement-observation.test-support.js";
import { readRelatedProcessDiagnostics } from "./schtasks.integration-observation.test-support.js";

type ServiceObservation = "install" | "status";
export const PUBLISHED_UPDATE_ACCEPTANCE_MS = 360_000;
export const MAX_SETTLEMENT_OBSERVATION_MS = 480_000;
export type InstalledPublishedCommandStart = Readonly<{
  launcherPid: number;
  commandPid: number;
  commandStartedAtMs: number;
  commandSpawnedAtMs: number;
}>;

export function captureInstalledUpdateProcesses(
  context: SupportRedactionContext,
  needles: string[],
  progress: Pick<UpdateRunRecord, "runId" | "phase" | "status">,
  reason: "terminal" | "elapsed-300s" | "follow-up" | "before-physical-cutoff",
  retirementBinding?: InstalledUpdateRetirementBinding,
  censusRuntime?: Parameters<typeof readRelatedProcessDiagnostics>[2],
) {
  const sample = {
    runId: progress.runId,
    phase: progress.phase,
    status: progress.status,
    reason,
    capturedAtMs: Date.now(),
  };
  try {
    const capture = censusRuntime
      ? readRelatedProcessDiagnostics(needles, retirementBinding, censusRuntime)
      : retirementBinding
        ? readRelatedProcessDiagnostics(needles, retirementBinding)
        : readRelatedProcessDiagnostics(needles);
    return { ...sample, ...projectInstalledUpdateProcessCapture(context, capture) };
  } catch {
    return { ...sample, unavailable: "Process observation could not be read" };
  }
}

/** All native consumers retain this selected projection, never the host-wide envelope. */
export function projectInstalledUpdateProcessCapture(
  context: SupportRedactionContext,
  capture: ReturnType<typeof readRelatedProcessDiagnostics>,
) {
  const safeText = (value: string) => redactSupportString(value, context, { maxLength: 2_000 });
  const retirement = capture.retirement;
  return {
    ok: capture.ok,
    truncated: capture.truncated,
    ...(capture.error ? { unavailable: safeText(capture.error) } : {}),
    ...(retirement
      ? {
          retirement: {
            ...retirement,
            moduleReportedPaths: retirement.moduleReportedPaths?.map(safeText),
            moduleComparisonKeys: retirement.moduleComparisonKeys?.map(safeText),
            expectedAddon: retirement.expectedAddon
              ? {
                  ...retirement.expectedAddon,
                  canonicalPath: safeText(retirement.expectedAddon.canonicalPath),
                }
              : undefined,
            backups: retirement.backups?.map((backup) =>
              Object.assign({}, backup, { root: safeText(backup.root) }),
            ),
          },
        }
      : {}),
    ...(capture.fileIo ? { fileIo: capture.fileIo } : {}),
    processes: capture.processes.map((process) => ({
      pid: process.ProcessId,
      parentPid: process.ParentProcessId,
      createdAt: process.CreationDate,
      userModeTime100ns: process.UserModeTime,
      kernelModeTime100ns: process.KernelModeTime,
      readOperationCount: process.ReadOperationCount,
      writeOperationCount: process.WriteOperationCount,
      otherOperationCount: process.OtherOperationCount,
      commandLine: process.CommandLine ? safeText(process.CommandLine) : null,
    })),
  };
}

function captureCommandOutput(
  kind: ServiceObservation | "published-update",
  stdout: string,
  truncated: boolean,
  diagnostic: (value: string) => string,
  requireTerminalResult = false,
) {
  if (truncated) {
    return { kind, unavailable: "capture limit exceeded; output withheld" };
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = asOptionalRecord(JSON.parse(stdout));
  } catch {
    return { kind, unavailable: "response is not JSON" };
  }
  if (!value) {
    return { kind, unavailable: "response is not a JSON object" };
  }
  // Live terminal admission uses the published UpdateRunResult shape; final
  // command diagnostics still retain useful partial error responses.
  if (
    requireTerminalResult &&
    (typeof value.status !== "string" ||
      !["ok", "error", "skipped"].includes(value.status) ||
      typeof value.mode !== "string" ||
      !["git", "pnpm", "bun", "npm", "unknown"].includes(value.mode) ||
      !Array.isArray(value.steps) ||
      typeof value.durationMs !== "number" ||
      !Number.isFinite(value.durationMs))
  ) {
    return { kind, unavailable: "response is not a terminal update result" };
  }
  // Only these fixed diagnostic fields may cross into retained evidence, never config/auth/argv.
  const fields = (input: unknown, keys: string[]) => {
    const source = asOptionalRecord(input);
    return Object.fromEntries(
      keys.map((key) => {
        const field = source?.[key];
        return [
          key,
          typeof field === "string"
            ? diagnostic(field)
            : typeof field === "number" || typeof field === "boolean" || field === null
              ? field
              : undefined,
        ];
      }),
    );
  };
  if (kind === "published-update") {
    return {
      kind,
      ...fields(value, ["status", "mode", "reason", "durationMs"]),
      before: fields(value.before, ["version", "buildId", "sha"]),
      after: fields(value.after, ["version", "buildId", "sha"]),
      recovery: fields(value.recovery, [
        "serviceRestartSafe",
        "reason",
        "version",
        "buildId",
        "packageRollbackVerified",
      ]),
      steps: Array.isArray(value.steps)
        ? value.steps.slice(0, 40).map((entry: unknown) => {
            const step = asOptionalRecord(entry);
            return Object.assign(
              fields(step, ["name", "exitCode", "durationMs", "signal", "killed", "termination"]),
              step?.exitCode !== 0 ? fields(step, ["stdoutTail", "stderrTail"]) : {},
              {
                failureFacts: Array.isArray(step?.failureFacts)
                  ? step.failureFacts
                      .slice(0, 8)
                      .map((fact: unknown) => fields(fact, ["check", "code", "message"]))
                  : undefined,
              },
            );
          })
        : undefined,
      stepsOmitted: Array.isArray(value.steps) ? Math.max(0, value.steps.length - 40) : 0,
    };
  }
  const service = asOptionalRecord(value.service);
  const common = { kind };
  if (kind === "install") {
    return {
      ...common,
      ...fields(value, ["action", "ok", "result", "message", "error"]),
      service: fields(service, ["label", "loaded", "loadedText", "notLoadedText"]),
      warnings: Array.isArray(value.warnings)
        ? value.warnings
            .slice(0, 5)
            .filter((warning): warning is string => typeof warning === "string")
            .map(diagnostic)
        : undefined,
    };
  }
  const runtime = asOptionalRecord(service?.runtime);
  const rpc = asOptionalRecord(value.rpc);
  return {
    ...common,
    service: {
      ...fields(service, ["loaded", "inspectionReason"]),
      loadState: fields(service?.loadState, ["status", "detail", "inspectionReason"]),
      runtime: {
        ...fields(runtime, [
          "status",
          "state",
          "pid",
          "detail",
          "inspectionReason",
          "missingUnit",
          "lastRunTime",
          "lastRunResult",
        ]),
        inspectionFailure: fields(runtime?.inspectionFailure, ["code", "detail", "timeoutMs"]),
      },
    },
    rpc: {
      ...fields(rpc, ["ok", "kind", "url", "error", "gatewayReached"]),
      server: fields(rpc?.server, ["version", "buildId"]),
    },
    gateway: fields(value.gateway, ["port", "version", "bindMode", "bindHost", "probeUrl"]),
    port: fields(value.port, ["port", "status"]),
  };
}

export type CompletedTerminalJsonObservation = Readonly<{
  kind: "completed-terminal-JSON-observed";
  stdoutRevision: number;
  observedAtMs: number;
  projection: ReturnType<typeof captureCommandOutput>;
}>;

export function createInstalledTerminalJsonCapture(
  diagnostic: (value: string) => string,
  onChange?: (fact: CompletedTerminalJsonObservation | undefined) => void,
) {
  let stdoutRevision = 0;
  let examined = false;
  let fact: CompletedTerminalJsonObservation | undefined;
  let valid = false;
  const invalidate = () => {
    if (valid) {
      valid = false;
      onChange?.(undefined);
    }
  };
  return {
    // Call once per nonempty stdout chunk, after the caller bounds its accumulated capture.
    observe(stdout: string, truncated: boolean, observedAtMs: number) {
      stdoutRevision++;
      invalidate();
      // The published writer emits an unindented root closing line plus newline.
      // Inspect only the bounded suffix; nested closing lines are indented.
      if (!examined && !truncated && /\n\}\r?\n$/u.test(stdout.slice(-4))) {
        examined = true;
        const projection = captureCommandOutput(
          "published-update",
          stdout,
          false,
          diagnostic,
          true,
        );
        if (!("unavailable" in projection)) {
          fact = Object.freeze({
            kind: "completed-terminal-JSON-observed",
            stdoutRevision,
            observedAtMs,
            projection,
          });
          valid = true;
          onChange?.(fact);
        }
      }
    },
    // A different stream can exhaust the command's shared capture limit.
    invalidate,
    current: () => (valid ? fact : undefined),
    final(stdout: string, truncated: boolean) {
      if (truncated) {
        invalidate();
      }
      return {
        publishedUpdate:
          valid && fact?.stdoutRevision === stdoutRevision
            ? fact.projection
            : captureCommandOutput("published-update", stdout, truncated, diagnostic),
        ...(fact
          ? {
              completedTerminalJson: {
                fact,
                validAtJoin: valid,
                stdoutRevisionAtJoin: stdoutRevision,
              },
            }
          : {}),
      };
    },
  };
}

type CommandSettlement = {
  startedAtMs: number;
  observedAtMs?: number;
  launcherReadyAtMs?: number;
  commandSpawnedAtMs?: number;
  commandPid?: number;
  exitAtMs?: number;
  closeAtMs?: number;
  stdout: { lastDataAtMs?: number; closeAtMs?: number };
  stderr: { lastDataAtMs?: number; closeAtMs?: number };
};

export type CommandRecord = {
  args: string[];
  launcherPid: number | null;
  beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
  code: number | null;
  signal: string | null;
  joined: boolean;
  elapsedMs: number;
  settlement?: CommandSettlement;
  naturalSettlementObservation?: {
    acceptanceLimitMs: number;
    physicalLimitMs: number;
    acceptanceExceeded: boolean;
  };
  failureOutput?: { stdout: string; stderr: string; captureTruncated: boolean };
  serviceOutput?: ReturnType<typeof captureCommandOutput>;
  publishedUpdate?: ReturnType<typeof captureCommandOutput>;
  completedTerminalJson?: {
    fact: CompletedTerminalJsonObservation;
    validAtJoin: boolean;
    stdoutRevisionAtJoin: number;
  };
};
export async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  records: CommandRecord[],
  expectedExit = 0,
  signal?: AbortSignal,
  options: {
    expectedStderr?: readonly string[];
    observeService?: ServiceObservation;
    commandBudget?: "published-update";
    physicalObservationLimitMs?: number;
    onStarted?: (facts: InstalledPublishedCommandStart) => void;
    onCompletedTerminalJson?: (fact: CompletedTerminalJsonObservation | undefined) => void;
  } = {},
) {
  const { expectedStderr = [], observeService } = options;
  const physicalLimitMs = options.physicalObservationLimitMs;
  if (physicalLimitMs !== undefined) {
    assert.equal(options.commandBudget, "published-update");
    assert.ok(
      Number.isFinite(physicalLimitMs) &&
        physicalLimitMs > PUBLISHED_UPDATE_ACCEPTANCE_MS &&
        physicalLimitMs <= MAX_SETTLEMENT_OBSERVATION_MS,
      "Natural-settlement observation requires a physical limit above acceptance and at most 480000ms",
    );
  }
  const started = performance.now();
  const settlement: CommandSettlement | undefined =
    options.commandBudget === "published-update"
      ? { startedAtMs: Date.now(), stdout: {}, stderr: {} }
      : undefined;
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const redaction = { env, stateDir: env.OPENCLAW_STATE_DIR ?? cwd };
  const diagnostic = (value: string) => {
    // A truncated capture may have lost the field name needed for redaction.
    if (truncated) {
      return "[output withheld: capture limit exceeded]";
    }
    const normalized = stripAnsi(value)
      .split(/\r\n|[\r\n]/u)
      .map((line) => sanitizeForLog(line.replaceAll("\t", " ")))
      .join("\n");
    return formatCommandOutput(
      redactSupportString(normalized, redaction, { maxLength: Number.MAX_SAFE_INTEGER }),
      2_000,
    );
  };
  const terminalJsonCapture =
    options.commandBudget === "published-update" && options.onCompletedTerminalJson
      ? createInstalledTerminalJsonCapture(diagnostic, options.onCompletedTerminalJson)
      : undefined;
  let code: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
  let result: number | undefined;
  let failure: Error | undefined;
  try {
    result = await runManagedCommand({
      bin: process.execPath,
      args,
      env,
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs:
        physicalLimitMs ??
        (options.commandBudget === "published-update" ? PUBLISHED_UPDATE_ACCEPTANCE_MS : 180_000),
      signal,
      onReady(launched) {
        child = launched;
        if (settlement) {
          settlement.observedAtMs = Date.now();
          launched.on("message", (message: unknown) => {
            const control = asOptionalRecord(message);
            if (typeof control?.job !== "string") {
              return;
            }
            if (control.type === "ready") {
              settlement.launcherReadyAtMs ??= Date.now();
            } else if (
              control.type === "spawned" &&
              typeof control.pid === "number" &&
              Number.isSafeInteger(control.pid) &&
              control.pid > 0
            ) {
              if (settlement.commandPid === undefined) {
                settlement.commandSpawnedAtMs = Date.now();
                settlement.commandPid = control.pid;
                if (typeof launched.pid === "number") {
                  options.onStarted?.(
                    Object.freeze({
                      launcherPid: launched.pid,
                      commandPid: control.pid,
                      commandStartedAtMs: settlement.startedAtMs,
                      commandSpawnedAtMs: settlement.commandSpawnedAtMs,
                    }),
                  );
                }
              }
            }
          });
          launched.once("close", () => {
            settlement.closeAtMs = Date.now();
          });
          for (const stream of ["stdout", "stderr"] as const) {
            launched[stream]?.once("close", () => {
              settlement[stream].closeAtMs = Date.now();
            });
          }
        }
        launched.stdout?.on("data", (chunk: Buffer) => {
          if (settlement) {
            settlement.stdout.lastDataAtMs = Date.now();
          }
          stdout += chunk.toString();
          if (stdout.length > 262144) {
            truncated = true;
            stdout = stdout.slice(-262144);
          }
          if (chunk.length > 0) {
            terminalJsonCapture?.observe(stdout, truncated, Date.now());
          }
        });
        launched.stderr?.on("data", (chunk: Buffer) => {
          if (settlement) {
            settlement.stderr.lastDataAtMs = Date.now();
          }
          stderr += chunk.toString();
          if (stderr.length > 262144) {
            truncated = true;
            stderr = stderr.slice(-262144);
            terminalJsonCapture?.invalidate();
          }
        });
        launched.once("exit", (exitCode, receivedSignal) => {
          if (settlement) {
            settlement.exitAtMs = Date.now();
          }
          code = exitCode;
          exitSignal = receivedSignal;
          beforeCleanup = inspectManagedProcessGroup(launched, { errorPolicy: "indeterminate" });
        });
      },
    });
  } catch (error) {
    failure = toErrorObject(error, "Installed Scheduled Task fixture failed");
  }
  const elapsedMs = performance.now() - started;
  const naturalSettlementObservation =
    physicalLimitMs === undefined
      ? undefined
      : {
          acceptanceLimitMs: PUBLISHED_UPDATE_ACCEPTANCE_MS,
          physicalLimitMs,
          acceptanceExceeded: elapsedMs > PUBLISHED_UPDATE_ACCEPTANCE_MS,
        };
  if (naturalSettlementObservation?.acceptanceExceeded) {
    const acceptanceFailure = new assert.AssertionError({
      message: "Published update exceeded the original 360000ms acceptance limit; observation only",
      actual: elapsedMs,
      expected: PUBLISHED_UPDATE_ACCEPTANCE_MS,
      operator: "<=",
    });
    failure = failure
      ? new AggregateError(
          [acceptanceFailure, failure],
          "Published update failed acceptance and its physical observation command failed",
        )
      : acceptanceFailure;
  }
  const afterCleanup = child
    ? inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })
    : undefined;
  const stderrMatches = expectedStderr.every((expected) => stderr.includes(expected));
  const failed =
    failure ||
    afterCleanup !== "dead" ||
    beforeCleanup !== "dead" ||
    truncated ||
    exitSignal !== null ||
    code !== expectedExit ||
    result !== expectedExit ||
    !stderrMatches;
  const failureOutput = failed
    ? {
        stdout: diagnostic(stdout),
        stderr: diagnostic(stderr),
        captureTruncated: truncated,
      }
    : undefined;
  records.push({
    args,
    launcherPid: child?.pid ?? null,
    code,
    signal: exitSignal,
    beforeCleanup,
    joined: afterCleanup === "dead" && !hasUnjoinedWork(failure),
    elapsedMs,
    ...(settlement ? { settlement } : {}),
    ...(naturalSettlementObservation ? { naturalSettlementObservation } : {}),
    ...(failureOutput ? { failureOutput } : {}),
    ...(observeService
      ? { serviceOutput: captureCommandOutput(observeService, stdout, truncated, diagnostic) }
      : {}),
    ...(options.commandBudget === "published-update"
      ? (terminalJsonCapture?.final(stdout, truncated) ?? {
          publishedUpdate: captureCommandOutput("published-update", stdout, truncated, diagnostic),
        })
      : {}),
  });
  if (child && afterCleanup !== "dead") {
    // Keep the existing fixture lifetime's claim when physical cleanup is uncertain.
    throw Object.assign(
      new Error("Installed command descendant cleanup is unverified", { cause: failure }),
      {
        processTreeState: "indeterminate",
      },
    );
  }
  if (failure) {
    throw failure;
  }
  assert.equal(beforeCleanup, "dead", "Installed command required descendant cleanup after exit");
  assert.equal(truncated, false, "Command output was truncated");
  assert.equal(exitSignal, null);
  const details = failureOutput ? JSON.stringify(failureOutput, null, 2) : "";
  assert.equal(code, expectedExit, details);
  assert.equal(result, expectedExit, details);
  assert.equal(
    stderrMatches,
    true,
    `Command stderr did not match expected diagnostics.\n${details}`,
  );
  return stdout;
}
