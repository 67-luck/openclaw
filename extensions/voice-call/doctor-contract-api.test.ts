// Voice Call tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStoreAgentIds, stateMigrations } from "./doctor-contract-api.js";
import { installVoiceCallStateRuntimeForTests } from "./src/manager.test-harness.js";
import { loadActiveCallsFromStore } from "./src/manager/store.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("voice-call", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe.each(["default", "custom"] as const)("absent %s Voice Call store", (location) => {
  it.each(["detectLegacyState", "migrateLegacyState"] as const)(
    "%s leaves absent state untouched without loading repair machinery",
    async (method) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-absent-"));
      const store = path.join(root, location === "default" ? "voice-calls" : "custom-store");
      const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root };
      vi.doMock("openclaw/plugin-sdk/doctor-repair-runtime", () => {
        throw new Error("absent Voice Call state must not load repair machinery");
      });
      try {
        const result = await expectDefined(stateMigrations[0], "voice-call state migration")[
          method
        ]({
          config:
            location === "custom"
              ? { plugins: { entries: { "voice-call": { config: { store } } } } }
              : {},
          env,
          stateDir: root,
          oauthDir: path.join(root, "oauth"),
          context: createDoctorContext(env),
        });
        expect(result).toEqual(
          method === "detectLegacyState" ? null : { changes: [], warnings: [] },
        );
        expect(await fs.readdir(root)).toEqual([]);
      } finally {
        vi.doUnmock("openclaw/plugin-sdk/doctor-repair-runtime");
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("voice-call doctor state migration", () => {
  let stateDir = "";
  let storePath = "";
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-doctor-"));
    storePath = path.join(stateDir, "custom-store");
    env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    installVoiceCallStateRuntimeForTests();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("reports top-level and per-number session-store agents", () => {
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: {
            entries: {
              "voice-call": {
                config: {
                  agentId: "Voice",
                  numbers: {
                    "+15550001111": { agentId: "Cards" },
                    "+15550002222": {},
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual(["cards", "voice"]);
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: { entries: { "@openclaw/voice-call": { config: {} } } },
        },
      }),
    ).toEqual(["main"]);
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: { entries: { "voice-call": { enabled: true } } },
        },
      }),
    ).toEqual(["main"]);
  });

  it("repairs the plugin-local SQLite schema without a legacy call log", async () => {
    const databasePath = path.join(storePath, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL UNIQUE,
          source_sequence INTEGER NOT NULL,
          occurred_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          error_code TEXT,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          session_key TEXT,
          session_id TEXT,
          run_id TEXT NOT NULL,
          tool_call_id TEXT,
          tool_name TEXT
        );
      `);
    } finally {
      db.close();
    }
    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const config = {
      plugins: {
        entries: {
          "voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    const params = {
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        "- Voice Call SQLite schema: audit event ledger -> versioned message lifecycle schema",
        "- Voice Call SQLite schema: tables -> SQLite STRICT typing",
      ],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Voice Call SQLite audit event ledger -> versioned message lifecycle schema",
        expect.stringMatching(
          /^Migrated Voice Call SQLite tables to SQLite STRICT typing \(\d+\)$/,
        ),
      ],
      warnings: [],
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
  });
});
