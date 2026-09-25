import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { useSqliteWorkerStoreFixture } from "./sqlite-worker-fixture.test-support.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import { observeNativeOpenFailure } from "./sqlite-worker-store.transport.test-support.js";
import * as workerCpu from "./worker-cpu.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

useSqliteWorkerStoreFixture("sqlite-worker-broker-", () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nodeIt = process.versions.bun ? it.skip : it;

nodeIt.each(
  (["service", "data"] as const).flatMap((position) =>
    (["undefined", "string", "Error"] as const).map((value) => ({ position, value })),
  ),
)(
  "preserves a native $position open failure thrown as $value through exit",
  async ({ position, value }) => {
    const broker = new SqliteWorkerBroker();
    const initial = workerCpu.getTrackedWorkerCpuSources();
    const { workers, exits, errors, childExits, failure, transportSpy, workerSpy } =
      observeNativeOpenFailure(position, value);
    try {
      const rejected = await broker
        .open<FixtureOperations>(
          {
            moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
            databasePath: ":memory:",
            input: undefined,
          },
          undefined,
          undefined,
          { volatile: { id: `native-open-${position}-${value}` } },
        )
        .then(
          () => {
            throw new Error("Faulted native open unexpectedly succeeded");
          },
          (error: unknown) => error,
        );
      assert(rejected instanceof Error);
      assert(rejected.cause instanceof Error);
      expect(rejected).toMatchObject({ code: "unavailable" });
      expect(workers).toHaveLength(1);
      await Promise.all(exits);
      expect(workers[0]?.threadId).toBe(-1);
      if (position === "service") {
        expect(errors).toHaveLength(1);
        if (value === "Error") {
          expect(rejected.cause).toBe(errors[0]);
          expect(rejected.cause.message).toBe(failure);
        } else if (value === "undefined") {
          expect(errors[0]).toBeUndefined();
          expect(Object.hasOwn(rejected.cause, "cause")).toBe(true);
          expect(rejected.cause.cause).toBeUndefined();
          expect(rejected.cause.message).toBe("SQLite worker failed");
        } else {
          expect(errors[0]).toBe(failure);
          expect(rejected.cause.message).toBe(failure);
        }
      } else {
        expect(errors).toEqual([]);
        const message = value === "undefined" ? "undefined" : failure;
        expect(childExits).toEqual([{ code: 1, error: message }]);
        expect(rejected.cause.message).toBe(message);
      }
    } finally {
      try {
        try {
          await broker.close();
        } finally {
          await Promise.all(exits);
        }
      } finally {
        transportSpy.mockRestore();
        workerSpy.mockRestore();
      }
    }
    expect(workerCpu.getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
  },
);
