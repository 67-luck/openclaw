import { renameSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "./default-template.js";
import { loadUsageBarTemplate } from "./template.js";
import {
  clearUsageBarTemplateCacheForTest,
  reconcileUsageBarTemplateCacheForTest,
} from "./template.test-support.js";

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: warnSpy }),
}));
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  return { ...createRequire(import.meta.url)("@openclaw/fs-safe/watch") };
});
const temp = useAutoCleanupTempDirTracker(afterEach);
const subscriptions: observation.WatchSubscription[] = [];
const watchedPaths = new Map<string, observation.WatchSubscription>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const original = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    expect(options.persistent).toBe(false);
    const subscription = original(authority, { ...options, mode: "poll" });
    subscriptions.push(subscription);
    watchedPaths.set(join(authority.rootReal, options.scopes[0]!.path), subscription);
    return subscription;
  });
});
afterEach(async () => {
  await clearUsageBarTemplateCacheForTest();
  await Promise.all(subscriptions.splice(0).map((subscription) => subscription.close()));
  watchedPaths.clear();
  warnSpy.mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const tplA = { segments: [{ text: "A" }] };
const tplB = { output: { default: [{ text: "B" }] } };
const tmpDir = () => temp.make("usage-template-");
function tmpFile(name: string, contents: string): string {
  const file = join(tmpDir(), name);
  writeFileSync(file, contents);
  return file;
}

describe("loadUsageBarTemplate", () => {
  it("returns the built-in template when unset", () => {
    expect(loadUsageBarTemplate(undefined)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
  });

  it("returns an inline template object when usable", () => {
    expect(loadUsageBarTemplate(tplA)).toBe(tplA);
  });

  it("falls back to the built-in template for an unusable inline object", () => {
    expect(loadUsageBarTemplate({ nope: true })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toMatchObject([
      "configured usage template could not be used; using built-in footer",
      { source: "inline", reason: "unsupported-shape" },
    ]);
  });

  it("falls back quietly for an empty inline template", () => {
    expect(loadUsageBarTemplate({ output: {} })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(loadUsageBarTemplate({ output: { default: [] } })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the built-in template for invalid JSON", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toMatchObject([
      "configured usage template could not be used; using built-in footer",
      { source: "file", reason: "invalid-json", path },
    ]);
  });

  it("falls back to the built-in template for an empty template file", () => {
    const path = tmpFile("empty.json", JSON.stringify({ output: { default: [] } }));
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reloads a path after an initial miss", () => {
    const dir = tmpDir();
    const missing = join(dir, "missing.json");
    expect(loadUsageBarTemplate(missing)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).not.toHaveBeenCalled();
    writeFileSync(missing, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(missing)).toMatchObject(tplB);
  });

  it("reloads a path after invalid JSON is fixed", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    writeFileSync(path, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });

  it("serves the cached template without re-reading the file", async () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);

    writeFileSync(path, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);

    await clearUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });

  it("bounds invalid-template warnings by least-recently-used path", () => {
    const dir = tmpDir();
    const paths = Array.from({ length: 257 }, (_, index) => {
      const path = join(dir, `bad-${index}.json`);
      writeFileSync(path, "{ not json");
      return path;
    });

    for (const path of paths.slice(0, 256)) {
      expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    }
    expect(warnSpy).toHaveBeenCalledTimes(256);

    // Refresh the oldest warning before overflow so the next key becomes the LRU victim.
    expect(loadUsageBarTemplate(paths[0])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(256);

    expect(loadUsageBarTemplate(paths[256])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(257);
    expect(loadUsageBarTemplate(paths[0])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(257);

    expect(loadUsageBarTemplate(paths[1])).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    expect(warnSpy).toHaveBeenCalledTimes(258);
    expect(warnSpy).toHaveBeenLastCalledWith(
      "configured usage template could not be used; using built-in footer",
      { source: "file", reason: "invalid-json", path: paths[1] },
    );
  });

  it("refreshes atomic replacements and restored files, then rereads after loss of coverage", async () => {
    const directory = tmpDir();
    const file = join(directory, "template.json");
    writeFileSync(file, JSON.stringify(tplA));
    const first = loadUsageBarTemplate(file);
    await reconcileUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(file)).toBe(first);

    const staged = join(directory, "staged.json");
    writeFileSync(staged, JSON.stringify(tplB));
    renameSync(staged, file);
    await reconcileUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(file)).toEqual(tplB);
    unlinkSync(file);
    await reconcileUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(file)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    writeFileSync(file, JSON.stringify(tplA));
    await reconcileUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(file)).toEqual(tplA);

    renameSync(directory, join(tmpDir(), "retired"));
    await expect(reconcileUsageBarTemplateCacheForTest()).rejects.toThrow();
    mkdirSync(directory);
    writeFileSync(file, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(file)).toEqual(tplB);
    await reconcileUsageBarTemplateCacheForTest();
    expect(subscriptions[0]?.health().state).toBe("closed");
  });

  it("evicts the oldest path with its observation, but retains entries when retrying a miss", async () => {
    const directory = tmpDir();
    const files = Array.from({ length: 65 }, (_, index) =>
      join(directory, `template-${index}.json`),
    );
    for (const file of files.slice(0, 63)) {
      writeFileSync(file, JSON.stringify(tplA));
      expect(loadUsageBarTemplate(file)).toEqual(tplA);
    }
    const miss = files[63]!;
    expect(loadUsageBarTemplate(miss)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    writeFileSync(miss, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(miss)).toEqual(tplB);
    await reconcileUsageBarTemplateCacheForTest();
    expect(subscriptions).toHaveLength(64);
    const oldest = watchedPaths.get(files[0]!)!;
    writeFileSync(files[0]!, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(files[0])).toEqual(tplA);

    writeFileSync(files[64]!, JSON.stringify(tplA));
    expect(loadUsageBarTemplate(files[64])).toEqual(tplA);
    await reconcileUsageBarTemplateCacheForTest();
    expect(oldest.health().state).toBe("closed");
    expect(
      subscriptions
        .filter((subscription) => subscription !== oldest)
        .every((subscription) => subscription.health().state === "ready"),
    ).toBe(true);
    expect(loadUsageBarTemplate(files[0])).toEqual(tplB);
    await clearUsageBarTemplateCacheForTest();
    expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
      true,
    );
  });
});
