import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getMemorySearchManagerMock,
  resolveMemorySearchConfigMock,
  resolveSessionAgentIdMock,
} from "./compact.hooks.harness.js";
import type { CompactionMemorySyncFixture } from "./compact.hooks.test.js";

type PostCompactionSync = (params?: unknown) => Promise<void>;
export function registerCompactionMemorySyncCases(getRuntime: () => CompactionMemorySyncFixture) {
  it("skips sync in await mode when postCompactionForce is false", async () => {
    const { compactTesting, compactionConfig, mockCallArg, TEST_SESSION_KEY, TEST_SESSION_FILE } =
      getRuntime();
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: false,
        },
      },
    });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    const resolveAgentArg = mockCallArg(resolveSessionAgentIdMock);
    if (typeof resolveAgentArg !== "object" || resolveAgentArg === null) {
      throw new Error("Expected session agent arguments");
    }
    expect(resolveAgentArg).toMatchObject({ sessionKey: TEST_SESSION_KEY });
    expect(Reflect.get(resolveAgentArg, "config")).toBeTypeOf("object");
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("awaits post-compaction memory sync in await mode when postCompactionForce is true", async () => {
    const { compactTesting, compactionConfig, TEST_SESSION_KEY, TEST_SESSION_FILE } = getRuntime();
    const syncStarted = createDeferred<unknown>();
    const syncRelease = createDeferred();
    const sync = vi.fn<PostCompactionSync>(async (params) => {
      syncStarted.resolve(params);
      await syncRelease.promise;
    });
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    void resultPromise.then(() => {
      settled = true;
    });
    await expect(syncStarted.promise).resolves.toEqual({
      archiveFiles: [TEST_SESSION_FILE],
      reason: "post-compaction",
    });
    expect(settled).toBe(false);
    syncRelease.resolve(undefined);
    await resultPromise;
    expect(settled).toBe(true);
  });

  it("skips post-compaction memory sync when the mode is off", async () => {
    const { compactTesting, compactionConfig, TEST_SESSION_KEY, TEST_SESSION_FILE } = getRuntime();
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("off"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("fires post-compaction memory sync without awaiting it in async mode", async () => {
    const { compactTesting, compactionConfig, TEST_SESSION_KEY, TEST_SESSION_FILE } = getRuntime();
    const sync = vi.fn<PostCompactionSync>(async () => {});
    const managerRequested = createDeferred();
    const managerGate = createDeferred<{ manager: { sync: PostCompactionSync } }>();
    const syncStarted = createDeferred<unknown>();
    sync.mockImplementation(async (params) => {
      syncStarted.resolve(params);
    });
    getMemorySearchManagerMock.mockImplementation(async () => {
      managerRequested.resolve(undefined);
      return await managerGate.promise;
    });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("async"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    await managerRequested.promise;
    void resultPromise.then(() => {
      settled = true;
    });
    await resultPromise;
    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    managerGate.resolve({ manager: { sync } });
    await expect(syncStarted.promise).resolves.toEqual({
      archiveFiles: [TEST_SESSION_FILE],
      reason: "post-compaction",
    });
  });
}
