import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const APP_EVENTS = new Set([
  "created",
  "update",
  "interaction-before",
  "interaction-after",
  "editing-began",
  "editing-ended",
  "window-changed",
  "traits-read",
  "traits-set-before",
  "traits-set-after",
  "readiness",
]);
const TEST_EVENTS = new Set([
  "message-start",
  "before-enabled-wait",
  "enabled-wait-finished",
  "before-tap",
  "before-type",
  "after-type",
]);
const STAGES = new Set(["setup", "seed-0", "seed-1", "seed-2", "final"]);
const BOOLEANS = new Set([
  "desired",
  "environment",
  "editable",
  "selectable",
  "interactive",
  "focused",
  "attached",
  "hidden",
  "baseDisabled",
  "effectiveDisabled",
  "picker",
  "handoff",
  "ownerMismatch",
  "connected",
  "offline",
  "attachment",
]);
const COUNTS: Record<string, number> = {
  sequence: 4096,
  process: 2_147_483_647,
  editor: 4096,
  textLength: 1_000_000,
  traitReads: 1_000_000_000,
};
type Fact = Record<string, string | number | boolean>;
type Projection = { events: Fact[]; rejectedRows: number; partialLines: number; limited: boolean };

// Investigation-only projection: arbitrary keys, values, filenames, and tool output never enter proof.
export function projectComposerProbeLine(line: string, source: "app" | "test"): Fact | undefined {
  if (line.length > 8192) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isRecord(raw) ||
    typeof raw.event !== "string" ||
    !(source === "app" ? APP_EVENTS : TEST_EVENTS).has(raw.event) ||
    typeof raw.uptimeMs !== "number" ||
    !Number.isFinite(raw.uptimeMs) ||
    raw.uptimeMs < 0 ||
    raw.uptimeMs > 1_000_000_000_000
  ) {
    return undefined;
  }
  const result: Fact = { event: raw.event, uptimeMs: raw.uptimeMs };
  if (source === "test") {
    if (typeof raw.stage !== "string" || !STAGES.has(raw.stage)) {
      return undefined;
    }
    result.stage = raw.stage;
    if (raw.result !== undefined) {
      if (typeof raw.result !== "boolean") {
        return undefined;
      }
      result.result = raw.result;
    }
    if (raw.code !== undefined) {
      if (
        typeof raw.code !== "number" ||
        !Number.isInteger(raw.code) ||
        raw.code < 0 ||
        raw.code > 16
      ) {
        return undefined;
      }
      result.code = raw.code;
    }
    return result;
  }
  for (const [key, max] of Object.entries(COUNTS)) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
      return undefined;
    }
    result[key] = value;
  }
  if (
    typeof result.sequence !== "number" ||
    result.sequence < 1 ||
    typeof result.process !== "number" ||
    result.process < 1
  ) {
    return undefined;
  }
  for (const key of BOOLEANS) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "boolean") {
      return undefined;
    }
    result[key] = value;
  }
  for (const key of ["baseTraits", "traits"]) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (
      typeof value !== "string" ||
      !/^(?:0|[1-9][0-9]{0,19})$/u.test(value) ||
      BigInt(value) > 18_446_744_073_709_551_615n
    ) {
      return undefined;
    }
    result[key] = value;
  }
  return result;
}

export function createComposerTestProjection() {
  const projection: Projection = { events: [], rejectedRows: 0, partialLines: 0, limited: false };
  const buffers = { stdout: "", stderr: "" };
  const dropping = { stdout: false, stderr: false };
  const add = (line: string) => {
    if (!line.startsWith("IOS_COMPOSER_PROBE ")) {
      return;
    }
    if (projection.events.length >= 256) {
      projection.limited = true;
      return;
    }
    const event = projectComposerProbeLine(line.slice("IOS_COMPOSER_PROBE ".length), "test");
    if (event) {
      projection.events.push(event);
    } else {
      projection.rejectedRows = Math.min(projection.rejectedRows + 1, 1_000_000);
    }
  };
  return {
    feed(stream: "stdout" | "stderr", chunk: Buffer) {
      for (const part of chunk.toString("utf8").split(/(?<=\n)/u)) {
        const ended = part.endsWith("\n");
        if (!dropping[stream]) {
          if (buffers[stream].length + part.length > 8192) {
            if (
              buffers[stream].startsWith("IOS_COMPOSER_PROBE ") ||
              part.startsWith("IOS_COMPOSER_PROBE ")
            ) {
              projection.limited = true;
            }
            buffers[stream] = "";
            dropping[stream] = true;
          } else {
            buffers[stream] += part;
          }
        }
        if (ended) {
          if (!dropping[stream]) {
            add(buffers[stream].trimEnd());
          }
          buffers[stream] = "";
          dropping[stream] = false;
        }
      }
    },
    snapshot() {
      return {
        ...projection,
        events: [...projection.events],
        partialLines:
          Number(buffers.stdout.startsWith("IOS_COMPOSER_PROBE ")) +
          Number(buffers.stderr.startsWith("IOS_COMPOSER_PROBE ")),
      };
    },
  };
}

export async function collectComposerAppProjection(container: string) {
  const projection: Projection = { events: [], rejectedRows: 0, partialLines: 0, limited: false };
  const issues = new Set<string>();
  const cache = path.join(container, "Library/Caches");
  const names = (await readdir(cache))
    .filter((name) => /^openclaw-composer-probe-[1-9][0-9]{0,9}\.jsonl$/u.test(name))
    .toSorted((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (names.length > 8) {
    issues.add("file-limit");
    projection.limited = true;
  }
  if (names.length === 0) {
    issues.add("no-probe-files");
  }
  let totalBytes = 0;
  let filesRead = 0;
  for (const name of names.slice(-8)) {
    const remaining = Math.min(4 * 1024 * 1024, 16 * 1024 * 1024 - totalBytes);
    if (remaining <= 0) {
      issues.add("byte-limit");
      projection.limited = true;
      break;
    }
    try {
      const handle = await open(path.join(cache, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) {
          issues.add("not-regular-file");
          continue;
        }
        const buffer = Buffer.alloc(remaining + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        totalBytes += bytesRead;
        const text = buffer.subarray(0, Math.min(bytesRead, remaining)).toString("utf8");
        if (bytesRead > remaining) {
          issues.add("byte-limit");
          projection.limited = true;
        }
        const lines = text.split("\n");
        if (lines.at(-1) !== "") {
          projection.partialLines += 1;
        }
        lines.pop(); // A writer may still own the final line; never parse an incomplete record.
        for (const line of lines) {
          if (projection.events.length >= 16_384) {
            projection.limited = true;
            break;
          }
          const event = projectComposerProbeLine(line, "app");
          if (event) {
            projection.events.push(event);
          } else {
            projection.rejectedRows += 1;
          }
        }
        filesRead += 1;
      } finally {
        await handle.close();
      }
    } catch {
      issues.add("file-read-failed");
    }
  }
  return {
    status: filesRead > 0 ? "read" : "unavailable",
    ...projection,
    filesRead,
    issues: [...issues],
    writeLimitReached: projection.events.some((event) => event.sequence === 4096),
  };
}
