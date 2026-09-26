import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

it.each(["failed capture", "revoked executor"] as const)(
  "joins database capture and refuses activation after %s",
  async (scenario) => {
    await withTestDir({ prefix: "update-capture-activation-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const captured = createDeferredCore();
      const proceed = createDeferredCore();
      const onLiveMutation = vi.fn();
      let current = true;
      let retained: PackageUpdateTransaction | undefined;
      const captureError = new Error("database capture failed");
      const work = swapStagedPackageInstall({
        ...params,
        onLiveMutation,
        assertCurrent: () => {
          if (!current) {
            throw new Error("executor revoked during capture");
          }
        },
        onTransaction: async (transaction) => {
          retained = transaction;
          captured.resolve();
          await proceed.promise;
          if (scenario === "failed capture") {
            throw captureError;
          }
          current = false;
        },
      });
      try {
        await captured.promise;
        expect(retained).toBeDefined();
        expect(onLiveMutation).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
        proceed.resolve();
        const result = await work;
        expect(result.status).toBe("failed");
        expect(result.step.stderrTail).toContain(
          scenario === "failed capture" ? captureError.message : "executor revoked during capture",
        );
        expect(onLiveMutation).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
        expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
      } finally {
        proceed.resolve();
        await work.catch(() => undefined);
      }
    });
  },
);
