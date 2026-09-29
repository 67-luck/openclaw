// Tests atomic file replacement helpers and permission handling.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { movePathWithCopyFallback, replaceFileAtomic } from "./replace-file.js";

describe("replaceFileAtomic", () => {
  it("preserves the permission-error fallback for ordinary guarded writes", async () => {
    await withTestDir({ prefix: "openclaw-fallback-replace-" }, async (root) => {
      const filePath = path.join(root, "config.json");
      await fs.writeFile(filePath, "before\n", "utf8");
      const renameError = Object.assign(new Error("rename denied"), { code: "EPERM" });
      const result = await replaceFileAtomic({
        filePath,
        content: "after\n",
        copyFallbackOnPermissionError: true,
        beforeRename: async () => {},
        fileSystem: {
          promises: {
            ...fs,
            rename: async () => {
              throw renameError;
            },
          },
        },
      });

      expect(result.method).toBe("copy-fallback");
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("after\n");
    });
  });

  it("rechecks authority at the final rename and leaves the destination unchanged", async () => {
    await withTestDir({ prefix: "openclaw-guarded-replace-" }, async (root) => {
      const filePath = path.join(root, "config.json");
      await fs.writeFile(filePath, "before\n", "utf8");
      let authorityOpen = true;

      await expect(
        replaceFileAtomic({
          filePath,
          content: "after\n",
          beforeRename: async () => {
            authorityOpen = false;
          },
          beforeDestinationMutation: () => {
            if (!authorityOpen) {
              throw new Error("delegated authority closed");
            }
          },
        }),
      ).rejects.toThrow("delegated authority closed");

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("before\n");
    });
  });
});

describe("movePathWithCopyFallback", () => {
  it.runIf(process.platform !== "win32")(
    "rejects hardlinked source files when requested",
    async () => {
      await withTestDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const sourceDir = path.join(root, "source");
        const targetDir = path.join(root, "target");
        const sourceFile = path.join(sourceDir, "file.txt");
        const linkedFile = path.join(root, "linked.txt");
        await fs.mkdir(sourceDir);
        await fs.writeFile(sourceFile, "hello", "utf8");
        await fs.link(sourceFile, linkedFile);

        await expect(
          movePathWithCopyFallback({
            from: sourceDir,
            sourceHardlinks: "reject",
            to: targetDir,
          }),
        ).rejects.toMatchObject({ code: "hardlink" });

        await expect(fs.readFile(sourceFile, "utf8")).resolves.toBe("hello");
        let statError: NodeJS.ErrnoException | undefined;
        try {
          await fs.stat(targetDir);
        } catch (error) {
          statError = error as NodeJS.ErrnoException;
        }
        expect(statError).toBeInstanceOf(Error);
        expect(statError?.code).toBe("ENOENT");
        expect(statError?.path).toBe(targetDir);
        expect(statError?.syscall).toBe("stat");
      });
    },
  );
});
