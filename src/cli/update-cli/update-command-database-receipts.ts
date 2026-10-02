import { sha256Hex } from "../../infra/crypto-digest.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import type { UpdateDatabaseWriteReceipt } from "../../infra/update-database-generations.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";

export function recordUpdateDatabaseWrites(
  backup: UpdateDatabaseBackup,
  writes: UpdateDatabaseWriteReceipt | undefined,
  step: UpdateStepResult,
  runId?: string,
) {
  const paths = Object.keys(backup.sourceGenerations).toSorted();
  let receipt: UpdateStepResult | undefined;
  if (
    !writes ||
    JSON.stringify(Object.keys(writes.generations).toSorted()) !== JSON.stringify(paths)
  ) {
    step.warnings = [
      ...(step.warnings ?? []),
      "Doctor did not provide complete database write-generation evidence; rollback requires the last verified generation to remain unchanged.",
    ];
  } else {
    const expected = backup.migration?.to ?? backup.sourceGenerations;
    // Released Doctor receipts bind their input through unchanged; new ones also report that input.
    const from = writes.fromGenerations ?? expected;
    const fingerprint = sha256Hex(
      JSON.stringify(paths.map((file) => [file, writes.generations[file]])),
    );
    const diagnostics = [
      `Doctor interval ${step.name}; backup ${backup.directory}; from SHA-256 ${sha256Hex(JSON.stringify(paths.map((file) => [file, from[file]])))} to SHA-256 ${fingerprint}.`,
      `Post-migration write inventory: ${paths.length} databases; SHA-256 ${fingerprint}. Snapshots: ${backup.directory}.`,
      ...paths.map(
        (file) => `Database write fingerprint: ${file}; ${writes.generations[file] ?? "absent"}`,
      ),
    ];
    receipt = {
      name: "database migration writes",
      command: "record Doctor database write fingerprints",
      cwd: backup.directory,
      durationMs: 0,
      exitCode: 0,
      diagnostics,
    };
    step.databaseWrites = writes;
    step.diagnostics = [...(step.diagnostics ?? []), ...diagnostics];
    const attribution = writes.attribution;
    const contentVersions = { ...attribution?.beforeContentVersions };
    const attributedPaths = new Set<string>();
    const attributed =
      attribution !== undefined &&
      runId === attribution.runId &&
      attribution.unattributedPaths.length === 0 &&
      Object.keys(attribution.beforeContentVersions).length === paths.length &&
      Object.keys(attribution.afterContentVersions).length === paths.length &&
      paths.every(
        (file) =>
          Object.hasOwn(attribution.beforeContentVersions, file) &&
          Object.hasOwn(attribution.afterContentVersions, file),
      ) &&
      attribution.writes.length > 0 &&
      attribution.writes.every((write) => {
        if (
          !Object.hasOwn(contentVersions, write.path) ||
          contentVersions[write.path] !== write.fromContentVersion
        ) {
          return false;
        }
        contentVersions[write.path] = write.toContentVersion;
        attributedPaths.add(write.path);
        return true;
      }) &&
      paths.every(
        (file) =>
          contentVersions[file] === attribution.afterContentVersions[file] &&
          (writes.generations[file] === from[file] || attributedPaths.has(file)),
      );
    const unchanged =
      writes.unchanged && paths.every((file) => writes.generations[file] === from[file]);
    if ((!unchanged && !attributed) || paths.some((file) => from[file] !== expected[file])) {
      backup.restoreRefusal ??= "databases changed after snapshot capture; the writer is unknown";
    } else if (!backup.restoreRefusal) {
      backup.migration = {
        name: step.name,
        backup: backup.directory,
        from,
        to: writes.generations,
      };
    }
    if (attribution) {
      // The run step links the persisted migration receipt, including refused chains.
      receipt.diagnostics?.push(
        `Update migration attribution: ${attribution.writes.length} transaction(s) for run ${attribution.runId}; restoration ${attributed ? "verified" : "refused"}.`,
      );
    }
  }
  if (backup.restoreRefusal) {
    step.warnings = [
      ...(step.warnings ?? []),
      `Automatic database restoration unavailable: ${backup.restoreRefusal}. Snapshots retained at ${backup.directory}.`,
    ];
  }
  return receipt;
}
