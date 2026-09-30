import { expect, it, vi } from "vitest";
import { captureSpawnParentLineage } from "./spawn-parent-lineage.js";

const parent = { sessionId: "parent-session", lifecycleRevision: "parent-revision" };

it("rejects a stored parent that is no longer the spawning turn's incarnation", () => {
  expect(() =>
    captureSpawnParentLineage({
      parentEntry: parent,
      expectedParentSessionId: "earlier-session",
      senderIsOwner: true,
      readParentEntry: vi.fn(),
    }),
  ).toThrow("Parent session changed before spawn");
});

it("records the owner bit only for a stored parent and rechecks it before commit", async () => {
  const readParentEntry = vi.fn(async () => parent);
  const lineage = captureSpawnParentLineage({
    parentEntry: parent,
    expectedParentSessionId: "parent-session",
    senderIsOwner: true,
    readParentEntry,
  });
  expect(lineage.receipt).toEqual({
    spawnedBySessionId: "parent-session",
    parentSessionLifecycleRevision: "parent-revision",
    spawnedBySenderIsOwner: true,
  });
  await lineage.assertParentUnchanged();
  readParentEntry.mockResolvedValueOnce({ ...parent, lifecycleRevision: "reset-revision" });
  await expect(lineage.assertParentUnchanged()).rejects.toThrow("Parent session changed");

  const rowless = captureSpawnParentLineage({
    parentEntry: undefined,
    expectedParentSessionId: "turn-session",
    senderIsOwner: true,
    readParentEntry,
  });
  expect(rowless.receipt).toEqual({
    spawnedBySessionId: undefined,
    parentSessionLifecycleRevision: undefined,
    spawnedBySenderIsOwner: false,
  });
  readParentEntry.mockClear();
  await rowless.assertParentUnchanged();
  expect(readParentEntry).not.toHaveBeenCalled();
});
