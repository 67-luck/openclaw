import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  cleanupSnapshotOperations,
  withPreparedSqliteSnapshot,
} from "./sqlite-readonly-location-cleanup.js";

it("joins private transformation, publication and cleanup before signal settlement", async () => {
  const consume = createDeferredCore();
  const consumed = createDeferredCore();
  const cleanup = createDeferredCore();
  const cleaning = createDeferredCore();
  const order: string[] = [];
  const work = withPreparedSqliteSnapshot(
    {
      location: "/synthetic/private/database.sqlite",
      cleanup: () => {
        throw new Error("must use joined cleanup");
      },
      cleanupAsync: async () => {
        order.push("cleanup");
        cleaning.resolve();
        await cleanup.promise;
        order.push("removed");
        return true;
      },
    },
    async () => {
      order.push("transform");
      consumed.resolve();
      await consume.promise;
      order.push("publish");
      return "published";
    },
  );
  await consumed.promise;
  let settled = false;
  const signalCleanup = cleanupSnapshotOperations().then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(order).toEqual(["transform"]);
    consume.resolve();
    await cleaning.promise;
    expect(settled).toBe(false);
    expect(order).toEqual(["transform", "publish", "cleanup"]);
    cleanup.resolve();
    await expect(work).resolves.toBe("published");
    await signalCleanup;
    expect(order).toEqual(["transform", "publish", "cleanup", "removed"]);
  } finally {
    consume.resolve();
    cleanup.resolve();
    await Promise.allSettled([work, signalCleanup]);
  }
});

it.each(["false", "throw", "success"] as const)(
  "preserves the original consumer failure through %s cleanup",
  async (mode) => {
    const primary = new Error("private transform failed");
    const cleanupError = new Error("native retirement unsettled");
    const cleanup = vi.fn(async () => {
      if (mode === "throw") {
        throw cleanupError;
      }
      return mode === "success";
    });
    const work = withPreparedSqliteSnapshot(
      {
        location: "/synthetic/private/database.sqlite",
        cleanup: () => false,
        cleanupAsync: cleanup,
      },
      () => {
        throw primary;
      },
    );
    if (mode === "success") {
      await expect(work).rejects.toBe(primary);
    } else {
      await expect(work).rejects.toMatchObject({
        cause: primary,
        errors: [primary, expect.any(Error)],
      });
      if (mode === "throw") {
        await expect(work).rejects.toMatchObject({ errors: [primary, cleanupError] });
      }
    }
    expect(cleanup).toHaveBeenCalledOnce();
  },
);
