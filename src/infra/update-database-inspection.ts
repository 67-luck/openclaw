import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import { finishStateInspection } from "./update-candidate-state.process.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import type {
  UpdateDatabaseGenerations,
  UpdateDatabaseWriteInspection,
  UpdateDatabasePostimages,
} from "./update-database-generations.js";

type InspectionOptions = {
  env?: NodeJS.ProcessEnv;
  root?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};
const GenerationSchema = z.record(
  z.string(),
  z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
);
const WriteInspectionSchema = z.object({
  generations: GenerationSchema,
  images: z.record(
    z.string(),
    z
      .string()
      .regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/u)
      .nullable(),
  ),
});

/** Descriptor closes stay in an isolated process. Preserve size-derived budgets,
 * worker settlement, inventory checking and staging cleanup for both readers. */
async function inspect<T>(
  paths: readonly string[],
  options: InspectionOptions,
  schema: z.ZodType<T>,
  mode: "generations" | "images" | "postimages",
  inventories: (result: T) => Array<Record<string, unknown>>,
): Promise<T> {
  const sourceEnv = options.env ?? process.env;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const stagingRoot = await createSqliteSnapshotStagingDirectory(
    resolvePrivateSqliteSnapshotStagingRoot(sourceEnv),
    options.root !== undefined,
    signal,
  );
  const inspection = (async () => {
    let outcome: { value: T } | { cause: unknown };
    try {
      const worker = {
        nodeRunner: process.execPath,
        sourceEnv,
        stagingRoot,
        timeoutMs: options.timeoutMs,
        signal,
      };
      const result = parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          ...worker,
          root: options.root,
          input: {
            mode: "database-generations",
            paths,
            includeImages: mode === "images",
            includePostimages: mode === "postimages",
            stateDir: resolveStateDir(sourceEnv),
            config: {},
          },
          databases: await readUpdateStateDatabaseSizes(paths, worker),
        }),
        schema,
      );
      if (
        inventories(result).some(
          (inventory) =>
            Object.keys(inventory).length !== new Set(paths).size ||
            paths.some((pathname) => !Object.hasOwn(inventory, pathname)),
        )
      ) {
        throw new Error("Database generation worker did not return the supplied inventory.");
      }
      outcome = { value: result };
    } catch (cause) {
      outcome = { cause };
    }
    return finishStateInspection(stagingRoot, outcome);
  })();
  return retainSnapshotWork(inspection, () => controller.abort());
}

export function readUpdateDatabaseGenerationsIsolated(
  paths: readonly string[],
  options: InspectionOptions = {},
): Promise<UpdateDatabaseGenerations> {
  return inspect(paths, options, GenerationSchema, "generations", (result) => [result]);
}

export function readUpdateDatabaseWriteInspectionIsolated(
  paths: readonly string[],
  options: InspectionOptions = {},
): Promise<UpdateDatabaseWriteInspection> {
  return inspect(paths, options, WriteInspectionSchema, "images", (result) => [
    result.generations,
    result.images,
  ]);
}

export function readUpdateDatabasePostimagesIsolated(
  paths: readonly string[],
  options: InspectionOptions = {},
): Promise<UpdateDatabasePostimages> {
  const schema = z.record(
    z.string(),
    z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      sizeBytes: z.number().int().nonnegative(),
      sidecars: z.boolean(),
    }),
  );
  return inspect(paths, options, schema, "postimages", (result) => [result]);
}
