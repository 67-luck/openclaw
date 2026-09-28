import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";

const inventory = vi.hoisted(() => ({
  files: ["extensions/unrelated/first.test.ts"],
}));

vi.mock("../vitest/vitest.extension-database-workers-paths.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../vitest/vitest.extension-database-workers-paths.mjs")
  >()),
  databaseWorkerExtensionTestFiles: inventory.files,
}));

afterEach(() => {
  inventory.files.splice(1);
  vi.restoreAllMocks();
});

it.each([false, true])(
  "keeps exact-leaf filesystem work independent of unrelated inventory growth (watch=%s)",
  (watch) => {
    const target = "src/cron/schedule.test.ts";
    const absolute = path.resolve(target);
    const args = [...(watch ? ["--watch"] : []), target];
    buildVitestRunPlans(args);
    const stat = vi.spyOn(fs, "statSync");
    const countTargetStats = () => stat.mock.calls.filter(([file]) => file === absolute).length;

    const original = buildVitestRunPlans(args);
    const originalStats = countTargetStats();
    expect(originalStats).toBeGreaterThan(0);
    expect(original).toHaveLength(1);
    expect(original[0]?.watchMode).toBe(watch);
    expect([
      ...(original[0]?.includePatterns ?? []),
      ...(original[0]?.forwardedArgs ?? []),
    ]).toContain(target);

    inventory.files.push(
      ...Array.from({ length: 64 }, (_, index) => `extensions/unrelated/extra-${index}.test.ts`),
    );
    stat.mockClear();
    expect(buildVitestRunPlans(args)).toEqual(original);
    expect(countTargetStats()).toBe(originalStats);
  },
);
