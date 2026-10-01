import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

export function createContext(env?: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    getPluginStateCapacity() {
      return getPluginStateCapacityForTests("matrix", env);
    },
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctorForTests("matrix", options, entries);
    },
    openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> =>
      createPluginStateKeyedStoreForTests<T>("matrix", options),
  };
}

export function createMigrationParams(stateDir: string) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    config: {} as OpenClawConfig,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: createContext(env),
  };
}

export function accountStorageRoot(
  stateDir: string,
  accountId = "default",
  token = "0123456789abcdef",
) {
  return path.join(stateDir, "matrix", "accounts", accountId, "matrix.example.org__bot", token);
}

export function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

export function useMatrixDoctorMigrationTestState() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      cleanup();
    }),
  );

  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  return tempDirs;
}
