// Offline, byte-preserving translation-memory review and recovery.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeControlUiTranslationMemory,
  encodeControlUiTranslationMemory,
} from "./lib/control-ui-i18n-memory.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const assetsDir = "ui/src/i18n/.i18n";
const gitOptions = { maxBuffer: 64 * 1024 * 1024 };

function resolveCommit(ref: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
    encoding: "utf8",
  }).trim();
}

function revisionFiles(commit: string | undefined): Map<string, string> {
  const files = commit
    ? execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", assetsDir], {
        encoding: "utf8",
      }).split("\0")
    : readdirSync(assetsDir).map((file) => `${assetsDir}/${file}`);
  const memories = new Map<string, string>();
  for (const file of files) {
    const match = /^([^/]+)\.tm\.jsonl(?:\.gz)?$/.exec(file.slice(assetsDir.length + 1));
    if (!match) {
      continue;
    }
    const locale = match[1]!;
    if (memories.has(locale)) {
      throw new Error(`Both raw and compressed translation memory exist for ${locale}`);
    }
    memories.set(locale, file);
  }
  return memories;
}

function readRevisionMemory(commit: string | undefined, file: string | undefined): Buffer {
  if (file === undefined) {
    return Buffer.alloc(0);
  }
  const bytes = commit
    ? execFileSync("git", ["show", `${commit}:${file}`], gitOptions)
    : readFileSync(file);
  return file.endsWith(".gz") ? decodeControlUiTranslationMemory(bytes) : bytes;
}

function diffMemory(base: string, head: string | undefined): number {
  const beforeCommit = resolveCommit(base);
  const afterCommit = head === undefined ? undefined : resolveCommit(head);
  // Review the union of both revisions, including locales removed from current config.
  const beforeFiles = revisionFiles(beforeCommit);
  const afterFiles = revisionFiles(afterCommit);
  const locales = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].toSorted();
  const temporary = mkdtempSync(path.join(tmpdir(), "control-ui-memory-diff-"));
  let changed = false;
  try {
    for (const locale of locales) {
      const before = readRevisionMemory(beforeCommit, beforeFiles.get(locale));
      const after = readRevisionMemory(afterCommit, afterFiles.get(locale));
      if (before.equals(after)) {
        continue;
      }
      changed = true;
      const beforeName = `${locale}.before.jsonl`;
      const afterName = `${locale}.after.jsonl`;
      writeFileSync(path.join(temporary, beforeName), before);
      writeFileSync(path.join(temporary, afterName), after);
      const result = spawnSync(
        "git",
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--color=never",
          "--",
          beforeName,
          afterName,
        ],
        { cwd: temporary, stdio: "inherit" },
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(`Decoded diff failed for ${locale}`);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return changed ? 1 : 0;
}

function main(args: string[]): number {
  const [command, input, output] = args;
  if (command === "diff" && input && (args.length === 2 || args.length === 3)) {
    return diffMemory(input, output);
  }
  if ((command === "encode" || command === "decode") && input && output && args.length === 3) {
    const bytes = readFileSync(input);
    const converted =
      command === "encode"
        ? encodeControlUiTranslationMemory(bytes)
        : decodeControlUiTranslationMemory(bytes);
    // Decode fully before opening the destination; never overwrite existing recovery data.
    writeFileSync(output, converted, { flag: "wx" });
    return 0;
  }
  throw new Error(
    "Usage: node scripts/control-ui-i18n-memory.ts encode|decode <input> <new-output>\n" +
      "       node scripts/control-ui-i18n-memory.ts diff <base-ref> [head-ref] (from repo root)",
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
