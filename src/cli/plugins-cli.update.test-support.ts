import path from "node:path";
import { afterEach, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock } from "./plugins-cli-test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export function createManagedNpmUpdatePaths() {
  const root = tempDirs.make("plugin-update-load-path-");
  return {
    previousInstallPath: path.join(root, "npm", "projects", "brave-v1", "node_modules", "brave"),
    nextInstallPath: path.join(root, "npm", "projects", "brave-v2", "node_modules", "brave"),
    customPath: path.join(root, "custom-plugin"),
  };
}

export function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

export function writtenIndexCustody() {
  const options =
    writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls.at(-1)?.[1];
  if (!options) {
    throw new Error("expected an index write before registry refresh");
  }
  return {
    filePath: options.filePath,
    lease: {
      ...options.lease,
      // Refresh wraps the guards while retaining the original lease owner and signal.
      assertOwned: expect.any(Function),
      assertOwnedInTransaction: expect.any(Function),
    },
  };
}
