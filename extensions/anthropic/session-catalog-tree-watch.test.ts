import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDirtyDirectoryWatch } from "./session-catalog-tree-watch.js";

vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  return { ...createRequire(import.meta.url)("@openclaw/fs-safe/watch") };
});
const temp = useAutoCleanupTempDirTracker(afterEach);
const owners: Array<ReturnType<typeof createDirtyDirectoryWatch>> = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("invalidates project reads, bounds transcript depth, and recovers lost coverage", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let created = createDeferred<observation.WatchSubscription>();
  const original = observation.watch;
  const attach = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    expect(options.persistent).toBe(false);
    const subscription = original(authority, { ...options, mode: "poll" });
    created.resolve(subscription);
    return subscription;
  });
  const home = temp.make("claude-watch-");
  const directory = path.join(home, "projects");
  await fs.mkdir(path.join(directory, "existing", "subagents"), { recursive: true });
  const file = path.join(directory, "existing", "session.jsonl");
  await fs.writeFile(file, "{}\n");
  const owner = createDirtyDirectoryWatch(directory);
  owners.push(owner);
  expect(owner.takeDirty()).toBe("all");
  const subscription = await created.promise;
  await subscription.ready;
  await subscription.reconcile();
  expect(owner.takeDirty()).toBe("all");
  expect(owner.takeDirty()).toEqual(new Set());

  await fs.appendFile(file, "changed\n");
  await subscription.reconcile();
  expect(owner.takeDirty()).toEqual(new Set(["existing"]));
  expect(owner.takeDirty()).toEqual(new Set());
  await fs.writeFile(path.join(directory, "existing", "subagents", "ignored.jsonl"), "{}\n");
  await subscription.reconcile();
  expect(owner.takeDirty()).toEqual(new Set());

  await fs.mkdir(path.join(directory, "new"));
  await subscription.reconcile();
  expect(owner.takeDirty()).toEqual(new Set(["new"]));
  await fs.rm(file);
  await subscription.reconcile();
  expect(owner.takeDirty()).toEqual(new Set(["existing"]));

  await fs.rename(directory, path.join(home, "retired"));
  await expect(subscription.reconcile()).rejects.toThrow();
  expect(owner.takeDirty()).toBe("all");
  expect(attach).toHaveBeenCalledTimes(1);
  await fs.mkdir(directory);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
  created = createDeferred<observation.WatchSubscription>();
  expect(owner.takeDirty()).toBe("all");
  const replacement = await created.promise;
  await replacement.ready;
  await replacement.reconcile();
  expect(owner.takeDirty()).toBe("all");
  expect(owner.takeDirty()).toEqual(new Set());
  await owner.close();
  expect(replacement.health().state).toBe("closed");
  expect(owner.takeDirty()).toBe("all");
  expect(attach).toHaveBeenCalledTimes(2);
});
