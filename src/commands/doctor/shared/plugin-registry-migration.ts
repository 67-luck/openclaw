// Doctor migration from legacy shipped plugin install config into persisted install registry.
import fs from "node:fs";
import {
  extractShippedPluginInstallConfigRecords,
  inspectShippedPluginInstallConfigRecords,
  stripShippedPluginInstallConfigRecords,
} from "../../../config/plugin-install-config-migration.js";
import {
  copyPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../../../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "../../../plugins/installed-plugin-index-record-state.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type LoadInstalledPluginIndexParams,
} from "../../../plugins/installed-plugin-index.js";

type PluginRegistryDoctorMigrationPreflight =
  | {
      /** Migration action selected before reading or writing registry state. */
      action: "skip-existing";
      /** Persisted plugin index path that migration will inspect or write. */
      filePath: string;
      /** Authoritative pre-repair generation used to detect a real inventory change. */
      current: InstalledPluginIndex;
    }
  | {
      action: "initialize" | "migrate";
      filePath: string;
    };

type PluginRegistryDoctorMigrationResult =
  | {
      status: "skip-existing" | "dry-run";
      migrated: false;
      preflight: PluginRegistryDoctorMigrationPreflight;
    }
  | {
      status: "migrated";
      migrated: true;
      preflight: PluginRegistryDoctorMigrationPreflight;
      current: InstalledPluginIndex;
    };

export class InvalidPluginInstallRecordStateError extends Error {}

function invalidPersistedInstallRecordMessage(filePath: string): string {
  return [
    `Persisted plugin install records are invalid at ${filePath}.`,
    "Stop the Gateway, back up this database, delete only the config_machine_state row with state_key='plugins.installedIndex' using SQLite tooling, then rerun `openclaw doctor --fix` to rebuild it.",
  ].join(" ");
}

const INVALID_CONFIG_INSTALL_RECORD_MESSAGE =
  "plugins.installs contains invalid records. Back up openclaw.json, correct or remove the invalid retired plugins.installs record, then rerun `openclaw doctor --fix`.";

export type PluginRegistryDoctorMigrationParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  };

/** Decide whether Doctor should migrate the plugin registry in this environment. */
export function preflightPluginRegistryDoctorMigration(
  params: PluginRegistryDoctorMigrationParams = {},
): PluginRegistryDoctorMigrationPreflight {
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const persistedState = inspectPersistedInstalledPluginIndexInstallRecordsSync(params);
  if (persistedState.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(invalidPersistedInstallRecordMessage(filePath));
  }
  const configInstallState = params.config
    ? inspectShippedPluginInstallConfigRecords(params.config)
    : undefined;
  if (configInstallState?.status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const pathExists = params.existsSync ?? fs.existsSync;
  if (pathExists(filePath)) {
    const currentRegistry = readPersistedInstalledPluginIndexSync(params);
    if (currentRegistry) {
      return {
        action: "skip-existing",
        filePath,
        current: currentRegistry,
      };
    }
    // Install records without a readable index is a half-written registry, not a fresh root:
    // report it as a migration so doctor keeps warning and rebuilds from what survived.
    if (persistedState.status !== "missing") {
      return { action: "migrate", filePath };
    }
  }
  const hasConfigInstallRecords =
    configInstallState?.status === "valid" && Object.keys(configInstallState.records).length > 0;
  // Only a caller that supplied config can prove nothing is left to migrate. Without config, or with
  // retired plugins.installs records still present, stay on "migrate" so the warning is not lost.
  return {
    action: params.config && !hasConfigInstallRecords ? "initialize" : "migrate",
    filePath,
  };
}

async function readMigrationConfig(
  params: PluginRegistryDoctorMigrationParams,
): Promise<OpenClawConfig> {
  if (params.config) {
    return params.config;
  }
  if (params.readConfig) {
    return await params.readConfig();
  }
  const configModule = await import("../../../config/config.js");
  return await configModule.readBestEffortConfig();
}

/** Persist Doctor's migrated plugin registry from legacy config/install records when needed. */
export async function migratePluginRegistryForDoctor(
  params: PluginRegistryDoctorMigrationParams = {},
): Promise<PluginRegistryDoctorMigrationResult> {
  const preflight = preflightPluginRegistryDoctorMigration(params);
  if (preflight.action === "skip-existing") {
    return { status: "skip-existing", migrated: false, preflight };
  }
  if (params.dryRun) {
    return { status: "dry-run", migrated: false, preflight };
  }

  const rawConfig = await readMigrationConfig(params);
  if (inspectShippedPluginInstallConfigRecords(rawConfig).status === "invalid") {
    throw new InvalidPluginInstallRecordStateError(INVALID_CONFIG_INSTALL_RECORD_MESSAGE);
  }
  const config = stripShippedPluginInstallConfigRecords(rawConfig) as OpenClawConfig;
  const durableInstallRecords =
    params.installRecords ?? (await loadInstalledPluginIndexInstallRecords(params));
  const installRecords = copyPluginInstallRecordMap(
    extractShippedPluginInstallConfigRecords(rawConfig),
  );
  for (const [pluginId, record] of Object.entries(durableInstallRecords)) {
    setPluginInstallRecordMapEntry(installRecords, pluginId, record);
  }
  const migrationParams = {
    ...params,
    config,
    installRecords,
  };
  const candidateIndex = loadInstalledPluginIndex({
    ...migrationParams,
  });
  const current: InstalledPluginIndex = {
    ...candidateIndex,
    refreshReason: "migration",
  };
  await writePersistedInstalledPluginIndex(current, params);
  return {
    status: "migrated",
    migrated: true,
    preflight,
    current,
  };
}
