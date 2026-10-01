import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { importPluginStateEntriesForDoctorForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountStorageRoot,
  createMigrationParams,
  migrationById,
  useMatrixDoctorMigrationTestState,
} from "./doctor-contract-api.test-support.js";

describe("matrix doctor thread binding migrations", () => {
  const tempDirs = useMatrixDoctorMigrationTestState();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "preserves current bindings and prior import completion (completed: %s)",
    async (completed) => {
      const stateDir = tempDirs.make("openclaw-matrix-doctor-bindings-");
      const storageRootDir = accountStorageRoot(stateDir, "ops");
      const sourcePath = path.join(storageRootDir, "thread-bindings.json");
      fs.mkdirSync(storageRootDir, { recursive: true });
      const existing = {
        accountId: "ops",
        conversationId: "$current",
        parentConversationId: "!room:example",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:current",
        boundAt: 100,
        lastActivityAt: 200,
      };
      const incoming = {
        accountId: "ops",
        conversationId: "$missing",
        parentConversationId: "!room:example",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:imported",
        boundAt: 300.5,
        lastActivityAt: 200,
        idleTimeoutMs: -10,
        maxAgeMs: 99.5,
      };
      const sourceBytes =
        JSON.stringify(
          {
            version: 1,
            bindings: [
              { ...existing, targetSessionKey: "agent:ops:subagent:obsolete" },
              { ...incoming, targetSessionKey: "agent:ops:subagent:superseded-source" },
              incoming,
            ],
            retainedUnknownField: "preserve these source bytes",
          },
          null,
          2,
        ) + "\n";
      fs.writeFileSync(sourcePath, sourceBytes);
      const params = createMigrationParams(stateDir);
      const env = { OPENCLAW_STATE_DIR: storageRootDir };
      const store = params.context.openPluginStateKeyedStore<typeof existing>({
        namespace: "thread-bindings",
        maxEntries: 10_000,
        env,
      });
      const key = (conversationId: string) =>
        `ops:${createHash("sha256")
          .update("ops\0!room:example\0")
          .update(conversationId)
          .digest("hex")}`;
      await store.register(key(existing.conversationId), existing);
      if (completed) {
        const markers = params.context.openPluginStateKeyedStore<{ importedAt: number }>({
          namespace: "thread-bindings-migrations",
          maxEntries: 1_000,
          env,
        });
        const markerKey = `ops:${createHash("sha256").update("ops\0").update(sourcePath).digest("hex")}`;
        await markers.register(markerKey, { importedAt: 500 });
      }
      const migration = migrationById("matrix-thread-bindings-json-to-plugin-state");
      expect(await migration.collectBackupResources?.(params)).toEqual([
        { path: sourcePath, kind: "file" },
        { path: path.join(storageRootDir, "state", "openclaw.sqlite"), kind: "sqlite" },
      ]);
      const result = await migration.migrateLegacyState(params);
      expect(result.warnings).toEqual([]);
      await expect(store.lookup(key(existing.conversationId))).resolves.toEqual(existing);
      await expect(store.lookup(key(incoming.conversationId))).resolves.toEqual(
        completed
          ? undefined
          : {
              ...incoming,
              boundAt: 300,
              lastActivityAt: 300,
              idleTimeoutMs: 0,
              maxAgeMs: 99,
            },
      );
      expect(fs.readFileSync(`${sourcePath}.migrated`, "utf8")).toBe(sourceBytes);
      expect(fs.existsSync(sourcePath)).toBe(false);
      if (!completed) {
        await store.delete(key(incoming.conversationId));
      }
      fs.copyFileSync(`${sourcePath}.migrated`, sourcePath);
      expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
      await expect(store.lookup(key(incoming.conversationId))).resolves.toBeUndefined();
    },
  );

  it.each([
    "{invalid-json",
    JSON.stringify({ version: 2, bindings: [] }),
    JSON.stringify({
      version: 1,
      bindings: [
        {
          accountId: "other",
          conversationId: "$thread",
          targetSessionKey: "agent:ops:subagent:child",
        },
      ],
    }),
  ])("leaves unreadable binding sources available for repair", async (sourceBytes) => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-invalid-bindings-");
    const sourcePath = path.join(accountStorageRoot(stateDir, "ops"), "thread-bindings.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, sourceBytes);
    const migration = migrationById("matrix-thread-bindings-json-to-plugin-state");
    const result = await migration.migrateLegacyState(createMigrationParams(stateDir));
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("left source in place")]);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBytes);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
  });

  it("keeps binding source bytes and completion unset when an import write fails", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-binding-failure-");
    const storageRootDir = accountStorageRoot(stateDir, "ops");
    const sourcePath = path.join(storageRootDir, "thread-bindings.json");
    const sourceBytes = JSON.stringify({
      version: 1,
      bindings: [
        {
          accountId: "ops",
          conversationId: "$thread",
          targetKind: "subagent",
          targetSessionKey: "agent:ops:subagent:child",
          boundAt: 100,
          lastActivityAt: 100,
        },
      ],
    });
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(sourcePath, sourceBytes);
    const params = createMigrationParams(stateDir);
    const openStore = params.context.openPluginStateKeyedStore;
    params.context.openPluginStateKeyedStore = <T>(options: OpenKeyedStoreOptions) => {
      const store = openStore<T>(options);
      return options.namespace === "thread-bindings"
        ? {
            ...store,
            registerIfAbsent: async () => {
              throw new Error("synthetic storage failure");
            },
          }
        : store;
    };
    const migration = migrationById("matrix-thread-bindings-json-to-plugin-state");
    const result = await migration.migrateLegacyState(params);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("synthetic storage failure")]);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBytes);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
    const markers = openStore({
      namespace: "thread-bindings-migrations",
      maxEntries: 1_000,
      env: { OPENCLAW_STATE_DIR: storageRootDir },
    });
    const markerKey = `ops:${createHash("sha256").update("ops\0").update(sourcePath).digest("hex")}`;
    await expect(markers.lookup(markerKey)).resolves.toBeUndefined();
  });

  it.each(["import", "archive"] as const)(
    "keeps changed source bytes unresolved across retries after a partial %s",
    async (replacementPhase) => {
      const stateDir = tempDirs.make("openclaw-matrix-doctor-binding-conflict-");
      const storageRootDir = accountStorageRoot(stateDir, "ops");
      const sourcePath = path.join(storageRootDir, "thread-bindings.json");
      const original = {
        accountId: "ops",
        conversationId: "$thread",
        targetKind: "subagent",
        targetSessionKey: "agent:ops:subagent:original",
        boundAt: 100,
        lastActivityAt: 100,
      };
      const sourceBytes = JSON.stringify({ version: 1, bindings: [original] });
      const changedBytes = JSON.stringify({
        version: 1,
        bindings: [{ ...original, targetSessionKey: "agent:ops:subagent:changed" }],
      });
      fs.mkdirSync(storageRootDir, { recursive: true });
      fs.writeFileSync(sourcePath, sourceBytes);
      const params = createMigrationParams(stateDir);
      const openStore = params.context.openPluginStateKeyedStore;
      params.context.openPluginStateKeyedStore = <T>(
        options: OpenKeyedStoreOptions,
      ): PluginStateKeyedStore<T> => {
        const store = openStore<T>(options);
        return options.namespace === "thread-bindings"
          ? {
              ...store,
              registerIfAbsent: async (
                ...args: Parameters<PluginStateKeyedStore<T>["registerIfAbsent"]>
              ) => {
                const inserted = await store.registerIfAbsent(...args);
                if (inserted && replacementPhase === "import") {
                  fs.writeFileSync(sourcePath, changedBytes);
                }
                return inserted;
              },
            }
          : store;
      };
      const rename = fsPromises.rename;
      const renameSpy = vi
        .spyOn(fsPromises, "rename")
        .mockImplementation(async (source, target) => {
          if (source === sourcePath && replacementPhase === "archive") {
            fs.writeFileSync(sourcePath, changedBytes);
          }
          await rename(source, target);
        });
      const migration = migrationById("matrix-thread-bindings-json-to-plugin-state");
      expect((await migration.migrateLegacyState(params)).warnings).toEqual([
        expect.stringContaining("source changed during migration"),
        expect.stringContaining("Restored Matrix thread bindings legacy source"),
      ]);
      renameSpy.mockRestore();
      params.context.openPluginStateKeyedStore = openStore;
      expect((await migration.migrateLegacyState(params)).warnings).toEqual([
        expect.stringContaining("source changed after import began"),
      ]);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(changedBytes);
      expect(fs.readFileSync(`${sourcePath}.migrated`, "utf8")).toBe(changedBytes);
      const markers = openStore({
        namespace: "thread-bindings-migrations",
        maxEntries: 10_001,
        env: { OPENCLAW_STATE_DIR: storageRootDir },
      });
      const markerKey = `ops:${createHash("sha256").update("ops\0").update(sourcePath).digest("hex")}`;
      await expect(markers.lookup(markerKey)).resolves.toBeUndefined();
      const rows = await openStore({
        namespace: "thread-bindings",
        maxEntries: 10_000,
        env: { OPENCLAW_STATE_DIR: storageRootDir },
      }).entries();
      expect(rows.map((row) => row.value)).toEqual([original]);
      fs.writeFileSync(sourcePath, sourceBytes);
      expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
      expect(fs.readFileSync(`${sourcePath}.migrated.2`, "utf8")).toBe(sourceBytes);
      expect(fs.readFileSync(`${sourcePath}.migrated`, "utf8")).toBe(changedBytes);
    },
  );

  it("migrates with a full released marker store without evicting prior receipts", async () => {
    const stateDir = tempDirs.make("openclaw-matrix-doctor-binding-capacity-");
    const storageRootDir = accountStorageRoot(stateDir, "ops");
    const sourcePath = path.join(storageRootDir, "thread-bindings.json");
    fs.mkdirSync(storageRootDir, { recursive: true });
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            accountId: "ops",
            conversationId: "$thread",
            targetKind: "subagent",
            targetSessionKey: "agent:ops:subagent:child",
            boundAt: 100,
            lastActivityAt: 100,
          },
        ],
      }),
    );
    const options = {
      namespace: "thread-bindings-migrations",
      maxEntries: 1_000,
      env: { OPENCLAW_STATE_DIR: storageRootDir },
    };
    importPluginStateEntriesForDoctorForTests(
      "matrix",
      options,
      Array.from({ length: 1_000 }, (_, index) => ({
        key: `prior-${index}`,
        value: { importedAt: 100 },
        createdAt: 100,
      })),
    );
    const params = createMigrationParams(stateDir);
    const migration = migrationById("matrix-thread-bindings-json-to-plugin-state");
    expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    const markers = params.context.openPluginStateKeyedStore({ ...options, maxEntries: 10_001 });
    const entries = await markers.entries();
    expect(entries).toHaveLength(1_002);
    expect(entries.filter((entry) => entry.key.startsWith("prior-"))).toHaveLength(1_000);
  });
});
