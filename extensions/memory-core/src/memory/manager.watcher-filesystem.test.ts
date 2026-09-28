import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WatchSubscription, WatchOptions, WatchHealth } from "@openclaw/fs-safe/watch";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as observation from "openclaw/plugin-sdk/file-access-runtime";
import {
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MEMORY_INDEX_CHUNKS_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";

// Real observation and indexing; only the application-owned settling clock is advanced.
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  sleepWithAbort: async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted(),
}));
const warnings = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (original) => {
  const actual =
    await original<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn: warnings,
    }),
  };
});

it("indexes real edits, deletion and root replacement, then joins every subscription", async () => {
  // This helper allocates beneath os.tmpdir(), independent of the checkout path.
  const state = await createOpenClawTestState({ label: "memory-watch-filesystem" });
  const turn = new AsyncLocalStorage<string>();
  const contexts: Array<string | undefined> = [];
  const subscriptions: WatchSubscription[] = [];
  const invalidations: WatchOptions["onInvalidate"][] = [];
  const failures: NonNullable<WatchHealth["failure"]>[] = [];
  const bootstrap = createDeferred<void>();
  const originalWatch = observation.watch;
  const observed = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    contexts.push(turn.getStore());
    invalidations.push(options.onInvalidate);
    const subscription = originalWatch(authority, {
      ...options,
      mode: "poll",
      pollIntervalMs: 2_147_483_647,
      onInvalidate(invalidation) {
        options.onInvalidate(invalidation);
        if (invalidation.reason === "reconcile" && !invalidation.changes) {
          bootstrap.resolve();
        }
      },
      onHealth(health) {
        if (health.failure) {
          failures.push(health.failure);
        }
        options.onHealth?.(health);
      },
    });
    subscriptions.push(subscription);
    return subscription;
  });
  let manager: MemoryIndexManager | null = null;
  let index: DatabaseSync | undefined;
  try {
    await configureMemoryCoreDreamingStateForTests(state.env);
    const memory = path.join(state.workspaceDir, "memory");
    const note = path.join(memory, "note.md");
    await fs.mkdir(memory);
    const imports = path.join(state.workspaceDir, "imports");
    await fs.mkdir(imports);
    await fs.writeFile(path.join(imports, "keep.md"), "Imported sentinel.");
    await fs.writeFile(path.join(imports, "skip.md"), "Excluded by configured pattern.");
    await fs.mkdir(state.path("linked-source"));
    await fs.writeFile(state.path("linked-source", "note.md"), "Excluded symbolic source.");
    await fs.symlink(state.path("linked-source"), path.join(memory, "linked"), "junction");
    await fs.writeFile(path.join(state.workspaceDir, "MEMORY.md"), "Evergreen sentinel.");
    await fs.writeFile(path.join(state.workspaceDir, "USER.md"), "User sentinel.");
    await fs.writeFile(note, "Amethyst sentinel.");
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: state.workspaceDir }, list: [{ id: "main" }] },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          extraPaths: [{ path: imports, pattern: "keep.md" }],
          store: { vector: { enabled: false } },
        },
      },
    };
    const debounceMs = resolveMemorySearchConfig(cfg, "main")!.sync.watchDebounceMs;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    manager = await turn.run("opening turn", () =>
      MemoryIndexManager.get({ cfg, agentId: "main" }),
    );
    if (!manager) {
      throw new Error("memory manager unavailable");
    }
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every((subscription) => subscription.health().state === "ready")).toBe(
      true,
    );
    const activeManager = manager;
    await activeManager.sync({ reason: "initial" });
    const indexPath = manager.status().dbPath;
    if (!indexPath) {
      throw new Error("memory index path unavailable");
    }
    index = new DatabaseSync(indexPath, { readOnly: true });
    const rows = index.prepare(
      `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
    );
    const expected = (files: Array<{ path: string; text: string }>) => [
      { path: "MEMORY.md", text: "Evergreen sentinel." },
      { path: "USER.md", text: "User sentinel." },
      { path: "imports/keep.md", text: "Imported sentinel." },
      ...files,
    ];
    expect(rows.all()).toEqual(expected([{ path: "memory/note.md", text: "Amethyst sentinel." }]));
    let indexed = createDeferred<void>();
    const sync = activeManager.sync.bind(activeManager);
    vi.spyOn(activeManager, "sync").mockImplementation(async (options) => {
      try {
        await sync(options);
        if (options?.reason === "watch") {
          indexed.resolve();
        }
      } catch (error) {
        indexed.reject(error);
        throw error;
      }
    });
    const flush = async (files: Array<{ path: string; text: string }>) => {
      indexed = createDeferred<void>();
      await Promise.all(
        subscriptions
          .filter((entry) => entry.health().state !== "closed")
          .map((entry) => entry.reconcile()),
      );
      await vi.advanceTimersByTimeAsync(debounceMs);
      await indexed.promise;
      // Read published rows directly: search could repair a broken watcher itself.
      expect(rows.all()).toEqual(expected(files));
    };
    // Join the actual bootstrap invalidation; an unchanged reconcile emits no callback.
    await bootstrap.promise;
    await vi.advanceTimersByTimeAsync(debounceMs);
    await indexed.promise;
    expect(rows.all()).toEqual(expected([{ path: "memory/note.md", text: "Amethyst sentinel." }]));
    const revisions = index.prepare(
      `SELECT chunk_rowid, id, updated_at FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY id`,
    );
    const unchanged = revisions.all();
    indexed = createDeferred<void>();
    invalidations[0]!({ reason: "overflow" });
    await vi.advanceTimersByTimeAsync(debounceMs);
    await indexed.promise;
    expect(revisions.all()).toEqual(unchanged);
    await fs.writeFile(note, "Cobalt sentinel after edit.");
    await flush([{ path: "memory/note.md", text: "Cobalt sentinel after edit." }]);
    await fs.rm(note);
    await flush([]);
    await fs.rename(memory, state.path("previous-memory"));
    await fs.mkdir(memory);
    await fs.writeFile(path.join(memory, "replacement.md"), "Heliotrope replacement.");
    await flush([{ path: "memory/replacement.md", text: "Heliotrope replacement." }]);
    if (process.platform === "linux") {
      const invalid = Buffer.concat([Buffer.from(memory + path.sep), Buffer.from([0xff])]);
      await fs.writeFile(invalid, "unsupported filename");
      await Promise.allSettled(subscriptions.map((subscription) => subscription.reconcile()));
      expect(failures).toContainEqual(expect.objectContaining({ code: "invalid-path" }));
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining("memory will refresh on search"),
      );
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining("not valid UTF-8"));
      const text = "Periwinkle sibling edited after observation failed.";
      await fs.writeFile(path.join(memory, "replacement.md"), text);
      const lifecycle = activeManager as unknown as { awaitManagerIdle: () => Promise<void> };
      // Leave watcher/retry timers pending: only the search boundary may repair this edit.
      await activeManager.search("Periwinkle", { minScore: 0 });
      await lifecycle.awaitManagerIdle();
      expect(rows.all()).toEqual(expected([{ path: "memory/replacement.md", text }]));
      expect(
        (await activeManager.search("Periwinkle", { minScore: 0 })).map((result) => result.snippet),
      ).toContain(text);
      await lifecycle.awaitManagerIdle();
      expect(await fs.readFile(invalid, "utf8")).toBe("unsupported filename");
    }
    expect(contexts.every((context) => context === undefined)).toBe(true);
    await activeManager.close();
    expect(subscriptions.every((entry) => entry.health().state === "closed")).toBe(true);
    console.info(
      JSON.stringify({
        owner: "memory",
        platform: process.platform,
        modes: [...new Set(subscriptions.map((entry) => entry.health().mode))],
        root: "os.tmpdir",
        invalidation: "guarded-reconcile",
        proof: ["published-edit", "published-delete", "published-replacement", "joined-close"],
      }),
    );
  } finally {
    await manager?.close();
    index?.close();
    observed.mockRestore();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetMemoryCoreDreamingStateForTests();
    await state.cleanup();
  }
});
