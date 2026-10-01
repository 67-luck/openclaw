import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SimplePool } from "nostr-tools";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  listChannelIngressQueueAccountIdsForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import type { PluginRuntime } from "./runtime-api.js";
import { startNostrBus } from "./src/nostr-bus.js";
import { readNostrBusState } from "./src/nostr-state-store.js";
import { setNostrRuntime } from "./src/runtime.js";
import { TEST_HEX_PRIVATE_KEY } from "./src/test-fixtures.js";

type Payload = { version: 1; receivedAt: number; rawEvent: string };
const payload: Payload = { version: 1, receivedAt: 100, rawEvent: "retained real event" };
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

function migration(id: string) {
  const found = stateMigrations.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Missing Nostr migration ${id}`);
  }
  return found;
}

function fixture() {
  const stateDir = tempDirs.make("openclaw-nostr-doctor-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const openStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("nostr", { ...options, env });
  const openQueue = <T, M = unknown, C = unknown>(options?: { accountId?: string }) =>
    createChannelIngressQueueForTests<T, M, C>({
      channelId: "nostr",
      accountId: options?.accountId,
      stateDir,
    });
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore: openStore,
    channelIngressQueues: [
      {
        channelId: "nostr",
        openChannelIngressQueueForInspection: openQueue,
        openChannelIngressQueue: openQueue,
        listChannelIngressQueueAccountIds: () =>
          listChannelIngressQueueAccountIdsForTests({ channelId: "nostr", stateDir }),
      },
    ],
  };
  const runtimeWrites = vi.fn();
  const runtimeStore = <T>(options: OpenKeyedStoreOptions) => {
    const store = openStore<T>(options);
    return {
      ...store,
      register: async (...args: Parameters<typeof store.register>) => {
        runtimeWrites();
        await store.register(...args);
      },
    };
  };
  setNostrRuntime({ state: { openKeyedStore: runtimeStore } } as PluginRuntime);
  return {
    stateDir,
    params: { config: {}, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context },
    store: openStore<Record<string, unknown>>({ namespace: "bus-state", maxEntries: 256 }),
    openStore,
    openQueue,
    runtimeWrites,
  };
}

async function runMigrations(params: ReturnType<typeof fixture>["params"]) {
  for (const owner of stateMigrations) {
    expect((await owner.migrateLegacyState(params)).warnings).toEqual([]);
  }
}

describe("Nostr Doctor state migrations", () => {
  it.each([1, 2])(
    "imports supported JSON v%s through Doctor and preserves source bytes",
    async (version) => {
      const { stateDir, params, openStore, openQueue } = fixture();
      const busPath = path.join(stateDir, "nostr", "bus-state-Team.A.json");
      const profilePath = path.join(stateDir, "nostr", "profile-state-Team.A.json");
      const source =
        JSON.stringify(
          {
            version,
            lastProcessedAt: 100,
            gatewayStartedAt: 90,
            recentEventIds: ["seen", "seen", 42],
            extra: "retained source bytes",
          },
          null,
          2,
        ) + "\n";
      const profile = JSON.stringify({
        version: 1,
        lastPublishedAt: 80,
        lastPublishedEventId: "profile",
        lastPublishResults: { "wss://relay.example": "ok", invalid: "unknown" },
      });
      await fs.mkdir(path.dirname(busPath));
      await fs.writeFile(busPath, source);
      await fs.writeFile(profilePath, profile);
      const seedMigration = migration("nostr-recent-event-ids-to-ingress");
      // Planning runs before the JSON importer has created the SQLite seed.
      expect(await seedMigration.detectLegacyState(params)).not.toBeNull();
      expect(await stateMigrations[0]!.collectBackupResources?.(params)).toEqual([
        { path: busPath, kind: "file" },
        { path: path.join(stateDir, "state", "openclaw.sqlite"), kind: "sqlite" },
      ]);
      await runMigrations(params);
      await expect(readNostrBusState({ accountId: "Team.A" })).resolves.toEqual({
        version: 2,
        lastProcessedAt: 100,
        gatewayStartedAt: 90,
        recentEventIds: [],
      });
      await expect(
        openStore({ namespace: "profile-state", maxEntries: 256 }).lookup("Team.A"),
      ).resolves.toEqual({
        version: 1,
        lastPublishedAt: 80,
        lastPublishedEventId: "profile",
        lastPublishResults: { "wss://relay.example": "ok" },
      });
      const queue = openQueue<Payload>({ accountId: "Team.A" });
      expect((await queue.enqueue("seen", payload)).kind).toBe(
        version === 2 ? "completed" : "accepted",
      );
      await expect(fs.readFile(`${busPath}.migrated`, "utf8")).resolves.toBe(source);
      await expect(fs.readFile(`${profilePath}.migrated`, "utf8")).resolves.toBe(profile);
      await expect(fs.stat(busPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(seedMigration.detectLegacyState(params)).resolves.toBeNull();
    },
  );

  it("keeps canonical rows over leftover JSON and leaves malformed sources for repair", async () => {
    const { stateDir, params, store } = fixture();
    const current = {
      version: 2,
      lastProcessedAt: 900,
      gatewayStartedAt: 800,
      recentEventIds: [],
      retained: "current",
    };
    await store.register("default", current);
    const root = path.join(stateDir, "nostr");
    await fs.mkdir(root);
    const source = JSON.stringify({
      version: 2,
      lastProcessedAt: 1,
      gatewayStartedAt: 1,
      recentEventIds: ["obsolete"],
    });
    await fs.writeFile(path.join(root, "bus-state-default.json"), source);
    await fs.writeFile(path.join(root, "profile-state-broken.json"), "unparsed bytes\n");
    expect((await stateMigrations[0]!.migrateLegacyState(params)).warnings).toEqual([]);
    const failure = await stateMigrations[1]!.migrateLegacyState(params);
    expect(failure.warnings).toEqual([expect.stringContaining("left source in place")]);
    expect(failure.warningDisposition).toBeUndefined();
    await expect(store.lookup("default")).resolves.toEqual(current);
    await expect(
      fs.readFile(path.join(root, "bus-state-default.json.migrated"), "utf8"),
    ).resolves.toBe(source);
    await expect(fs.readFile(path.join(root, "profile-state-broken.json"), "utf8")).resolves.toBe(
      "unparsed bytes\n",
    );
  });

  it("preserves JSON replaced between import and archival", async () => {
    const { stateDir, params, store } = fixture();
    const sourcePath = path.join(stateDir, "nostr", "bus-state-default.json");
    const original = {
      version: 2,
      lastProcessedAt: 100,
      gatewayStartedAt: 90,
      recentEventIds: ["seen"],
    };
    const changed = JSON.stringify({ ...original, lastProcessedAt: 200 });
    await fs.mkdir(path.dirname(sourcePath));
    await fs.writeFile(sourcePath, JSON.stringify(original));
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (source === sourcePath) {
        await fs.writeFile(sourcePath, changed);
      }
      await rename(source, target);
    });
    const result = await stateMigrations[0]!.migrateLegacyState(params);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("source changed during migration"),
      expect.stringContaining("Restored Nostr bus state legacy source"),
    ]);
    await expect(store.lookup("default")).resolves.toEqual(original);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(changed);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toBe(changed);
  });

  it("migrates all 5000 released seed IDs without evicting markers or settling real work", async () => {
    const { stateDir, params, store, openQueue } = fixture();
    const ids = Array.from({ length: 5000 }, (_, index) => index.toString(16).padStart(64, "0"));
    const original = {
      version: 2,
      lastProcessedAt: 200,
      gatewayStartedAt: 150,
      recentEventIds: ids,
      retained: { exact: "bytes" },
    };
    await store.register("default", original);
    const queue = openQueue<Payload>();
    await queue.enqueue(ids[0]!, payload, { laneKey: "direct:pending" });
    await queue.enqueue(ids[1]!, payload, { laneKey: "direct:claimed" });
    const claim = await queue.claim(ids[1]!, { ownerId: "retained-owner" });
    await queue.enqueue(ids[2]!, payload);
    await queue.fail(ids[2]!, { reason: "retained-failure" });
    const owner = migration("nostr-recent-event-ids-to-ingress");
    expect((await owner.migrateLegacyState(params)).warnings).toEqual([]);
    await expect(store.lookup("default")).resolves.toEqual({ ...original, recentEventIds: [] });
    expect(await queue.listPending({ limit: "all" })).toEqual([
      expect.objectContaining({ id: ids[0], payload, laneKey: "direct:pending" }),
    ]);
    expect(await queue.listClaims()).toEqual([claim]);
    expect(await queue.listFailed?.({ limit: "all" })).toEqual([
      expect.objectContaining({ id: ids[2], payload, reason: "retained-failure" }),
    ]);
    await closeOpenClawStateDatabaseAsync();
    const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            "SELECT status, count(*) AS count FROM channel_ingress_events WHERE channel_id = 'nostr' AND account_id = 'default' GROUP BY status ORDER BY status",
          )
          .all(),
      ).toEqual([
        { status: "claimed", count: 1 },
        { status: "completed", count: 4997 },
        { status: "failed", count: 1 },
        { status: "pending", count: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it.each(["completion", "concurrent-row"])(
    "retains a seed after %s failure and refuses runtime admission until retry",
    async (failure) => {
      const { params, store, openQueue, runtimeWrites } = fixture();
      const original = {
        version: 2,
        lastProcessedAt: 200,
        gatewayStartedAt: 150,
        recentEventIds: ["first", "second"],
      };
      const newer = {
        ...original,
        lastProcessedAt: 400,
        gatewayStartedAt: 300,
        recentEventIds: ["third"],
        retained: "new writer",
      };
      await store.register("default", original);
      const queue = openQueue<Payload>();
      let injectFailure = true;
      const access = params.context.channelIngressQueues![0]!;
      access.openChannelIngressQueue = <T, M = unknown, C = unknown>(options?: {
        accountId?: string;
      }) => {
        const opened = openQueue<T, M, C>(options);
        return {
          ...opened,
          complete: async (...args: Parameters<typeof opened.complete>) => {
            if (injectFailure && args[0] === "second") {
              injectFailure = false;
              if (failure === "completion") {
                throw new Error("synthetic completion failure");
              }
              await store.register("default", newer);
            }
            return await opened.complete(...args);
          },
        };
      };
      const owner = migration("nostr-recent-event-ids-to-ingress");
      const result = await owner.migrateLegacyState(params);
      expect(result.warnings).toHaveLength(1);
      expect(result.warningDisposition).toBeUndefined();
      await expect(store.lookup("default")).resolves.toEqual(
        failure === "completion" ? original : newer,
      );
      await expect(readNostrBusState({})).rejects.toThrow("run openclaw doctor --fix");
      const subscribe = vi.spyOn(SimplePool.prototype, "subscribeMany");
      const scheduler = createTestPluginServiceScheduler();
      try {
        await expect(
          startNostrBus({
            scheduler,
            accountId: "default",
            privateKey: TEST_HEX_PRIVATE_KEY,
            relays: ["wss://relay.example"],
            onMessage: async () => {},
          }),
        ).rejects.toThrow("run openclaw doctor --fix");
        expect(subscribe).not.toHaveBeenCalled();
        expect(runtimeWrites).not.toHaveBeenCalled();
      } finally {
        await scheduler.stop();
      }
      expect((await owner.migrateLegacyState(params)).warnings).toEqual([]);
      await expect(readNostrBusState({})).resolves.toEqual({
        ...(failure === "completion" ? original : newer),
        recentEventIds: [],
      });
      for (const id of failure === "completion"
        ? original.recentEventIds
        : [...original.recentEventIds, "third"]) {
        expect((await queue.enqueue(id, payload)).kind).toBe("completed");
      }
    },
  );
});
