import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
} from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const temporary = createTempDirTracker();
afterEach(temporary.cleanup);
const cli = path.resolve("scripts/control-ui-i18n-memory.ts");
const node = resolveTestNodeExecPath();

function run(args: string[], cwd: string) {
  return spawnSync(node, [cli, ...args], { cwd, encoding: "utf8" });
}

describe("offline Control UI translation memory", () => {
  it("round-trips exact bytes without normalizing JSONL or gzip metadata on the same runtime", () => {
    const dir = temporary.make("control-ui-memory-");
    const original = Buffer.from(
      '\ufeff{ "unknown": "\u65e5\u672c\u8a9e" }\r\n\r\n{"duplicate":1}\n{"duplicate":1}',
    );
    writeFileSync(path.join(dir, "input.jsonl"), original);
    for (const output of ["first.gz", "second.gz"]) {
      const result = run(["encode", "input.jsonl", output], dir);
      expect(result.status, result.stderr).toBe(0);
    }
    const compressed = readFileSync(path.join(dir, "first.gz"));
    expect(gunzipSync(compressed)).toEqual(original);
    expect(readFileSync(path.join(dir, "second.gz"))).toEqual(compressed);
    const result = run(["decode", "first.gz", "restored.jsonl"], dir);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(dir, "restored.jsonl"))).toEqual(original);
  });

  it("fails before publishing corrupt data and never overwrites an existing recovery file", () => {
    const dir = temporary.make("control-ui-memory-");
    writeFileSync(path.join(dir, "truncated.gz"), gzipSync("valid").subarray(0, -1));
    const corrupt = run(["decode", "truncated.gz", "new.jsonl"], dir);
    expect(corrupt.status).toBe(2);
    expect(existsSync(path.join(dir, "new.jsonl"))).toBe(false);
    writeFileSync(path.join(dir, "good.gz"), gzipSync("replacement"));
    writeFileSync(path.join(dir, "saved.jsonl"), "keep this");
    const overwrite = run(["decode", "good.gz", "saved.jsonl"], dir);
    expect(overwrite.status).toBe(2);
    expect(readFileSync(path.join(dir, "saved.jsonl"), "utf8")).toBe("keep this");
  });

  it("preserves last-valid duplicate entries and grouped aliases through the canonical reader", () => {
    const dir = temporary.make("control-ui-memory-");
    const memoryPath = path.join(dir, "fr.tm.jsonl.gz");
    const row = {
      cache_key: "same",
      segment_id: "group.first",
      segment_ids: ["group.second"],
      text_hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      translated: "first",
    };
    const rows = [row, { ...row, translated: "last" }, { ...row, translated: " " }];
    writeFileSync(memoryPath, gzipSync(rows.map((entry) => JSON.stringify(entry)).join("\n\n")));
    const memory = loadControlUiTranslationMemory(memoryPath);
    expect(memory.size).toBe(1);
    expect(
      materializeControlUiLocaleCatalog(
        new Map([
          ["group.first", "abc"],
          ["group.second", "abc"],
        ]),
        memory,
      ),
    ).toEqual({
      group: { first: "last", second: "last" },
    });
  });

  it("reviews a raw-to-gzip revision without noise, then shows a decoded translation edit", () => {
    const dir = temporary.make("control-ui-memory-review-");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=" + path.join(dir, "no-hooks"),
          "-c",
          "commit.gpgSign=false",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          ...args,
        ],
        { cwd: dir, encoding: "utf8" },
      );
    git("init", "--quiet");
    const assets = path.join(dir, "ui/src/i18n/.i18n");
    mkdirSync(assets, { recursive: true });
    const raw = path.join(assets, "fr.tm.jsonl");
    const original = '{"translated":"before"}\n';
    writeFileSync(raw, original);
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    writeFileSync(`${raw}.gz`, gzipSync(original));
    unlinkSync(raw);
    const noChange = run(["diff", "HEAD"], dir);
    expect(noChange.status, noChange.stderr).toBe(0);
    expect(noChange.stdout).toBe("");
    writeFileSync(`${raw}.gz`, gzipSync('{"translated":"after"}\n'));
    const changed = run(["diff", "HEAD"], dir);
    expect(changed.status, changed.stderr).toBe(1);
    expect(changed.stdout).toContain('-{"translated":"before"}');
    expect(changed.stdout).toContain('+{"translated":"after"}');
    expect(changed.stdout).not.toContain(dir);
    writeFileSync(path.join(assets, "retired.tm.jsonl.gz"), gzipSync('{"translated":"retired"}\n'));
    git("add", ".");
    git("commit", "--quiet", "-m", "additional locale");
    unlinkSync(path.join(assets, "retired.tm.jsonl.gz"));
    const removed = run(["diff", "HEAD"], dir);
    expect(removed.status, removed.stderr).toBe(1);
    expect(removed.stdout).toContain('-{"translated":"retired"}');
  });
});
