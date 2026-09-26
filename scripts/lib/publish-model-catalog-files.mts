import fs from "node:fs";
import path from "node:path";
import {
  readRegularFileSync,
  sameFileIdentity,
  writeSiblingTempFile,
} from "@openclaw/fs-safe/advanced";

type Output = { file: string; content: string };
type Snapshot = ReturnType<typeof readRegularFileSync> | undefined;
type Recovery = {
  dir: string;
  identity: fs.Stats;
  files: Map<string, fs.Stats>;
};

function snapshot(file: string): Snapshot {
  return fs.lstatSync(file, { throwIfNoEntry: false })
    ? readRegularFileSync({ filePath: file })
    : undefined;
}

function assertUnchanged(file: string, previous: Snapshot): void {
  const current = snapshot(file);
  if (
    previous
      ? !current ||
        !sameFileIdentity(previous.stat, current.stat) ||
        !previous.buffer.equals(current.buffer)
      : current
  ) {
    throw new Error(`Catalog output changed during preparation: ${file}`);
  }
}

function saveRecoveryFile(recovery: Recovery, name: string, content: string | Buffer): void {
  const file = path.join(recovery.dir, name);
  // Capture ownership before writing: even a partial write remains cleanable.
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    recovery.files.set(file, fs.fstatSync(fd));
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function cleanupRecovery(recovery: Recovery): void {
  if (!sameFileIdentity(recovery.identity, fs.lstatSync(recovery.dir))) {
    throw new Error("recovery directory was replaced");
  }
  // No recursive removal and no exit hook: interrupted publication must retain
  // its backups. Preserve observed substitutes and unknown children.
  for (const [file, identity] of recovery.files) {
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (current) {
      if (!sameFileIdentity(identity, current)) {
        throw new Error("recovery file was replaced");
      }
      fs.unlinkSync(file);
    }
  }
  fs.rmdirSync(recovery.dir);
}

/** Local artifact publication, not a transaction across two filesystem names. */
export async function publishModelCatalogPair(
  outputs: [Output, Output],
  warn: (message: string) => void,
): Promise<void> {
  // Canonical parents catch aliases without changing the v1-only writer contract.
  const prepared = outputs.map((output) => {
    fs.mkdirSync(path.dirname(output.file), { recursive: true });
    const parent = fs.realpathSync(path.dirname(output.file));
    return { ...output, file: path.join(parent, path.basename(output.file)), parent };
  });
  if (new Set(prepared.map((output) => output.file)).size !== outputs.length) {
    throw new Error("--out and --out-v2 must name different files");
  }
  const plans = prepared.map((output) =>
    Object.assign(output, { previous: snapshot(output.file) }),
  );
  const recoveries: Array<Recovery & (typeof plans)[number]> = [];
  let publicationStarted = false;
  try {
    for (const output of plans) {
      const dir = fs.mkdtempSync(path.join(output.parent, ".catalog-pair-"));
      recoveries.push({ ...output, dir, identity: fs.lstatSync(dir), files: new Map() });
    }
    for (const [index, recovery] of recoveries.entries()) {
      saveRecoveryFile(recovery, "next.json", recovery.content);
      const previous = recovery.previous;
      if (previous) {
        saveRecoveryFile(recovery, "previous.json", previous.buffer);
      }
      saveRecoveryFile(
        recovery,
        "RECOVERY.txt",
        [
          "Catalog pair recovery artifacts; not proof of publication.",
          ...recoveries.map((entry, i) => `output ${i + 1}: ${entry.file}; recovery: ${entry.dir}`),
          `This directory belongs to output ${index + 1}.`,
          previous
            ? `previous.json holds original bytes; mode ${(previous.stat.mode & 0o777).toString(8)}.`
            : "The output was absent before this attempt.",
          "next.json holds the validated candidate bytes.",
          "Stop writers and inspect BOTH outputs before restoring or completing the pair.",
          "Do not blindly overwrite a replacement or rerun publication to recover.",
          "Retained artifacts are never automatically replayed or removed by a later run.",
          "",
        ].join("\n"),
      );
      if (
        !fs.readFileSync(path.join(recovery.dir, "next.json")).equals(Buffer.from(recovery.content))
      ) {
        throw new Error("prepared catalog bytes changed");
      }
    }
    // Finish both preparations before any final-path mutation. Recheck each
    // destination again at publication; this is cooperative, not rename CAS.
    recoveries.forEach((output) => assertUnchanged(output.file, output.previous));
    publicationStarted = true;
    for (const output of recoveries) {
      await writeSiblingTempFile({
        dir: output.parent,
        chmodDir: false,
        producerIsolation: "private-directory",
        mode: output.previous ? output.previous.stat.mode & 0o777 : undefined,
        syncTempFile: true,
        writeTemp: async (tempPath) => {
          fs.writeFileSync(tempPath, output.content, {
            flag: "wx",
            mode: output.previous ? output.previous.stat.mode & 0o777 : 0o666,
          });
        },
        resolveFinalPath: () => {
          assertUnchanged(output.file, output.previous);
          return output.file;
        },
      });
    }
  } catch (cause) {
    if (publicationStarted) {
      // A failed rename/verification can already have published. Never roll back
      // over a foreign replacement; retain both old/new sets for reconciliation.
      throw new Error(
        `Catalog pair publication incomplete; inspect both outputs. Recovery retained: ${recoveries.map((entry) => entry.dir).join(", ")}. Cause: ${String(cause)}`,
        { cause },
      );
    }
    throw cause;
  } finally {
    if (!publicationStarted) {
      for (const recovery of recoveries) {
        try {
          cleanupRecovery(recovery);
        } catch (error) {
          warn(`Catalog recovery cleanup failed; retained ${recovery.dir}: ${String(error)}`);
        }
      }
    }
  }
  // Publication succeeded. Cleanup failure is a warning, not a false failed
  // publication or an excuse to roll back an already visible pair.
  for (const recovery of recoveries) {
    try {
      cleanupRecovery(recovery);
    } catch (error) {
      warn(
        `Catalog pair published; recovery cleanup failed; retained ${recovery.dir}: ${String(error)}`,
      );
    }
  }
}
