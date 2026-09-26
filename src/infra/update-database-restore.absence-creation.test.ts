import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
const hooks = vi.hoisted(
  (): { afterCreate?: (pathname: string, kind: "directory" | "file") => void } => ({}),
);
vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/advanced")>();
  return {
    ...actual,
    createDirectorySync: (...args: Parameters<typeof actual.createDirectorySync>) => {
      actual.createDirectorySync(...args);
      hooks.afterCreate?.(args[0], "directory");
    },
    createFileSync: (...args: Parameters<typeof actual.createFileSync>) => {
      const owner = actual.createFileSync(...args);
      try {
        hooks.afterCreate?.(args[0], "file");
        return owner;
      } catch (error) {
        owner.close();
        throw error;
      }
    },
  };
});
import { createUpdateDatabaseAbsenceCustody } from "./update-database-restore-absence.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  hooks.afterCreate = undefined;
});
it.each([false, true])(
  "does not adopt a replacement between creation return and pin (content=%s)",
  async (content) => {
    const directory = dirs.make("absence-creation-proof-"),
      missing = path.join(directory, "absent.sqlite");
    let substituted: string | undefined, kindObserved: string | undefined;
    hooks.afterCreate = (pathname, kind) => {
      if (substituted) {
        return;
      }
      substituted = pathname;
      kindObserved = kind;
      fs.renameSync(pathname, pathname + ".original");
      if (kind === "directory") {
        fs.mkdirSync(pathname, { mode: 0o700 });
        if (content) {
          fs.writeFileSync(path.join(pathname, "foreign"), "keep");
        }
      } else {
        fs.writeFileSync(pathname, content ? "keep" : "");
      }
    };
    const owner = createUpdateDatabaseAbsenceCustody();
    let failed = false;
    try {
      await owner.reserve(missing, () => {});
    } catch {
      failed = true;
    }
    try {
      owner[Symbol.dispose]();
    } catch {
      failed = true;
    }
    if (!substituted) {
      throw new Error("creation seam was not reached");
    }
    expect({ failed, preserved: fs.existsSync(substituted), kind: kindObserved }).toEqual({
      failed: true,
      preserved: true,
      kind: kindObserved,
    });
    if (content) {
      expect(
        fs.readFileSync(
          kindObserved === "directory" ? path.join(substituted, "foreign") : substituted,
          "utf8",
        ),
      ).toBe("keep");
    }
  },
);

it.each([false, true])(
  "preserves a directory substituted for an owned-file stage (content=%s)",
  async (content) => {
    const directory = dirs.make("absence-file-directory-"),
      missing = path.join(directory, "missing.sqlite");
    let replacement: string | undefined;
    hooks.afterCreate = (pathname, kind) => {
      if (replacement) {
        return;
      }
      expect(kind).toBe("file");
      replacement = pathname;
      fs.renameSync(pathname, pathname + ".original");
      fs.mkdirSync(pathname, { mode: 0o700 });
      if (content) {
        fs.writeFileSync(path.join(pathname, "foreign"), "keep");
      }
    };
    const owner = createUpdateDatabaseAbsenceCustody();
    await expect(owner.reserve(missing, () => {})).rejects.toThrow();
    expect(() => owner[Symbol.dispose]()).toThrow();
    if (!replacement) {
      throw new Error("creation hook not reached");
    }
    expect(fs.lstatSync(replacement).isDirectory()).toBe(true);
    if (content) {
      expect(fs.readFileSync(path.join(replacement, "foreign"), "utf8")).toBe("keep");
    }
  },
);
