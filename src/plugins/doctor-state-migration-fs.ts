// Shared filesystem helpers for plugin doctor legacy-state migrations.
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { hasErrnoCode } from "../infra/errno.js";

/** True when the legacy-state path exists and is a regular file. */
export async function legacyStateFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Renames a migrated legacy source to `<path>.migrated`, recording the outcome in the
 * doctor changes/warnings lists. Never throws: a failed archive records a warning
 * so a later doctor run can retry without losing migrated data. Verified
 * completion captures and checks the source before committing migration receipts;
 * failed completion restores it exclusively and retains the captured archive.
 */
export async function archiveLegacyStateSource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
  verifiedCompletion?: {
    expectedBytes: Uint8Array;
    complete: () => Promise<void>;
  };
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  let capturedPath: string | undefined;
  try {
    if (params.verifiedCompletion) {
      const archiveExists = await archivePathExists(archivedPath);
      const targetPath = archiveExists ? await firstFreeArchivePath(params.filePath) : archivedPath;
      await fs.rename(params.filePath, targetPath);
      capturedPath = targetPath;
      const capturedBytes = await fs.readFile(targetPath);
      if (!capturedBytes.equals(params.verifiedCompletion.expectedBytes)) {
        throw new Error("source changed during migration; inspect it before retrying");
      }
      await params.verifiedCompletion.complete();
      if (archiveExists && capturedBytes.equals(await fs.readFile(archivedPath))) {
        await fs.rm(targetPath);
        params.changes.push(
          `Removed already-archived ${params.label} legacy source ${params.filePath}`,
        );
      } else {
        params.changes.push(`Archived ${params.label} legacy source -> ${targetPath}`);
      }
      return;
    }
    if (await legacyStateFileExists(archivedPath)) {
      // Import commits before archival, so an existing archive must converge
      // instead of re-warning every startup (#102749): identical bytes already
      // preserve the snapshot; differing bytes archive under a free suffix.
      const [sourceBytes, archiveBytes] = await Promise.all([
        fs.readFile(params.filePath),
        fs.readFile(archivedPath),
      ]);
      if (sourceBytes.equals(archiveBytes)) {
        await fs.rm(params.filePath, { force: true });
        params.changes.push(
          `Removed already-archived ${params.label} legacy source ${params.filePath}`,
        );
        return;
      }
      const nextArchivePath = await firstFreeArchivePath(params.filePath);
      await fs.rename(params.filePath, nextArchivePath);
      params.changes.push(`Archived ${params.label} legacy source -> ${nextArchivePath}`);
      return;
    }
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
    if (capturedPath) {
      try {
        await fs.copyFile(capturedPath, params.filePath, constants.COPYFILE_EXCL);
        params.warnings.push(
          `Restored ${params.label} legacy source to ${params.filePath}; captured bytes remain at ${capturedPath}. Resolve the failure before running openclaw doctor --fix again.`,
        );
      } catch (restoreError) {
        params.warnings.push(
          `Could not restore ${params.label} legacy source without replacing ${params.filePath}: ${String(restoreError)}. Captured bytes remain at ${capturedPath}; preserve both paths and resolve them before running openclaw doctor --fix again.`,
        );
      }
    }
  }
}

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!(await archivePathExists(candidate))) {
      return candidate;
    }
  }
}

async function archivePathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}
