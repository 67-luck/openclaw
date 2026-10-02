import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerHasSourceCustody,
} from "../state/openclaw-state-maintenance-context.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import { createUpdateStateInspectionDiagnostics } from "./update-candidate-state.diagnostics.js";
import {
  finishStateInspection,
  withUpdateStateInspectionWork,
} from "./update-candidate-state.process.js";
import {
  readUpdateStateDatabaseSizes,
  readUpdateStateDatabaseSizesInProcess,
} from "./update-candidate-state.sizes.js";
import type {
  UpdateDatabaseGenerations,
  UpdateDatabaseObservations,
} from "./update-database-generations.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

export async function runUpdateStateInspectionWorker(params: {
  input: { stateDir: string; config: OpenClawConfig; env?: NodeJS.ProcessEnv } & Record<
    string,
    unknown
  >;
  nodeRunner: string;
  root?: string;
  signal?: AbortSignal;
  sourceEnv: NodeJS.ProcessEnv;
  stagingRoot: string;
  databases: Awaited<ReturnType<typeof readUpdateStateDatabaseSizes>>;
  timeoutMs?: number;
  readOnlySource?: string;
  ioBudget?: "probe" | "deadline";
}) {
  const selectedUrl = resolveRuntimeWorkerUrl({
    ...(params.readOnlySource
      ? runtimeProcessEntrypoints.sqliteReadOnly
      : runtimeProcessEntrypoints.updateCandidateState),
    root: params.root,
  });
  // Default inspection belongs to this updater; explicit roots select the target's runtime.
  const source =
    params.root === undefined
      ? captureRuntimeWorkerSource(selectedUrl)
      : { moduleUrl: selectedUrl };
  const workerUrl = source.moduleUrl;
  const sourceTsconfigPath = /\.[cm]?ts$/.test(fileURLToPath(workerUrl))
    ? fileURLToPath(new URL("../../tsconfig.json", workerUrl))
    : undefined;
  const inspection = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase:
      params.input.mode === "versions" ? "schema inspection startup" : "shared database discovery",
    paths: params.readOnlySource
      ? [params.readOnlySource]
      : params.input.mode === "versions"
        ? params.databases.map((database) => database.path)
        : [path.resolve(params.input.stateDir, "state", "openclaw.sqlite")],
  });
  try {
    const timeoutMs = Math.max(
      params.timeoutMs ?? 0,
      resolveAggregateSqliteInspectionTimeoutMs("state schema inspection", params.databases),
    );
    const run = (signal: AbortSignal | undefined) =>
      runUtf8CommandWithTimeout(
        [
          params.nodeRunner,
          ...resolveRuntimeWorkerArgv(workerUrl, params.nodeRunner),
          ...(params.readOnlySource
            ? [SQLITE_READONLY_CHILD_ARG, "sync", params.readOnlySource, params.stagingRoot]
            : []),
        ],
        {
          cwd: os.tmpdir(),
          input: params.readOnlySource
            ? undefined
            : JSON.stringify({
                ...params.input,
                env: {
                  HOME: params.sourceEnv.HOME,
                  OPENCLAW_HOME: params.sourceEnv.OPENCLAW_HOME,
                  USERPROFILE: params.sourceEnv.USERPROFILE,
                  OPENCLAW_AGENT_DIR: params.sourceEnv.OPENCLAW_AGENT_DIR,
                  PI_CODING_AGENT_DIR: params.sourceEnv.PI_CODING_AGENT_DIR,
                },
              }),
          baseEnv: params.sourceEnv,
          env: {
            XDG_CACHE_HOME: params.stagingRoot,
            ...(sourceTsconfigPath ? { TSX_TSCONFIG_PATH: sourceTsconfigPath } : {}),
          },
          killGraceMs: 500,
          killProcessTree: true,
          maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
          outputCapture: { stdout: "head", stderr: "discard" },
          terminateOnOutputLimit: { stdout: true },
          onOutputChunk: inspection.onOutputChunk,
          signal,
          ...(params.ioBudget === "deadline" ? { timeoutMs } : {}),
        },
      );
    const work = withUpdateStateInspectionWork(
      () =>
        params.ioBudget === "deadline"
          ? run(params.signal)
          : withUpdateCandidateIoBudget(
              {
                directory: params.stagingRoot,
                bytes: params.databases.reduce(
                  (total, database) => total + Number(database.sizeBytes ?? 0),
                  0,
                ),
                timeoutMs,
                signal: params.signal,
                nodeRunner: params.nodeRunner,
                env: params.sourceEnv,
              },
              run,
            ),
      params.signal,
    );
    source.runtimeGeneration?.retain(work, async () => {
      await work.catch((error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
      });
    });
    const result = await work;
    return { ...result, stderr: inspection.stderr(), inspection };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw inspection.failure(error);
    }
    params.signal?.throwIfAborted();
    throw inspection.failure(error);
  }
}

export function parseUpdateStateInspectionWorker<T>(
  result: Awaited<ReturnType<typeof runUpdateStateInspectionWorker>>,
  schema: z.ZodType<T>,
): T {
  if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
    const signal = result.signal ? `, signal ${result.signal}` : "";
    throw result.inspection.failure(
      result.stderr ||
        (result.outputLimitExceeded ? "Worker output exceeded its capture limit" : result.stdout),
      `${result.termination}${signal}`,
    );
  }
  try {
    return schema.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw result.inspection.failure(error);
  }
}

type UpdateDatabaseInspectionOptions = {
  env?: NodeJS.ProcessEnv;
  root?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  acquisition?: UpdateRecoveryCaptureAcquisition;
};

/** Raw fingerprint reads need their own process so descriptor closes cannot release caller locks. */
export function readUpdateDatabaseGenerationsIsolated(
  paths: readonly string[],
  options: UpdateDatabaseInspectionOptions = {},
): Promise<UpdateDatabaseGenerations> {
  return readUpdateDatabaseInspectionIsolated(
    paths,
    options,
    "database-generations",
    z.record(z.string(), z.nullable(z.string().regex(/^[a-f0-9]{64}$/u))),
  );
}

export function readUpdateDatabaseObservationsIsolated(
  paths: readonly string[],
  options: UpdateDatabaseInspectionOptions = {},
): Promise<UpdateDatabaseObservations> {
  const hash = z.string().regex(/^[a-f0-9]{64}$/u);
  return readUpdateDatabaseInspectionIsolated(
    paths,
    options,
    "database-observations",
    z.record(
      z.string(),
      z.union([
        z.strictObject({ generation: hash, contentVersion: hash }),
        z.strictObject({ generation: z.null(), contentVersion: z.null() }),
      ]),
    ),
  );
}

async function readUpdateDatabaseInspectionIsolated<T extends Record<string, unknown>>(
  paths: readonly string[],
  options: UpdateDatabaseInspectionOptions,
  mode: "database-generations" | "database-observations",
  schema: z.ZodType<T>,
): Promise<T> {
  const scope = getOpenClawDatabaseMaintenanceScope();
  const maintenanceOwner =
    options.acquisition?.mode === "maintenance-owner" &&
    paths.every((pathname) => maintenanceOwnerHasSourceCustody(scope, pathname));
  const { root, timeoutMs, env: sourceEnv = process.env, signal: caller } = options;
  const controller = new AbortController();
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  const stagingRoot = await createSqliteSnapshotStagingDirectory(
    resolvePrivateSqliteSnapshotStagingRoot(sourceEnv),
    root !== undefined,
    signal,
  );
  const inspection = (async () => {
    let outcome: { value: T } | { cause: unknown };
    try {
      const worker = { nodeRunner: process.execPath, sourceEnv, stagingRoot, timeoutMs, signal };
      const observations = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          root,
          ...(maintenanceOwner ? { ioBudget: "deadline" as const } : {}),
          input: {
            mode,
            paths,
            stateDir: resolveStateDir(sourceEnv),
            config: {},
          },
          databases: maintenanceOwner
            ? await readUpdateStateDatabaseSizesInProcess(paths, signal)
            : await readUpdateStateDatabaseSizes(paths, worker),
        }),
        schema,
      );
      if (
        Object.keys(observations).length !== new Set(paths).size ||
        paths.some((pathname) => !Object.hasOwn(observations, pathname))
      ) {
        throw new Error("Database generation worker did not return the supplied inventory.");
      }
      outcome = { value: observations };
    } catch (cause) {
      outcome = { cause };
    }
    return finishStateInspection(stagingRoot, outcome);
  })();
  return retainSnapshotWork(inspection, () => controller.abort());
}
