import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  readCanonicalSessionRepairInventory,
  loadCanonicalSessionRepairEntries,
  loadExactSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import * as lifecycle from "../config/sessions/session-accessor.sqlite-projection.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

describe("doctor canonical session decision races", () => {
  it("rejects a hard-linked source before backup or validity admission", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-linked-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env });
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        env,
      }).path;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "linked-source", updatedAt: 20 },
        env,
        sessionKey: " MAIN ",
        storePath,
      });
      await closeOpenClawAgentDatabasesAsync(stateDir);
      const original = fs.readFileSync(sqlitePath);
      const aliasPath = `${sqlitePath}.linked`;
      fs.linkSync(sqlitePath, aliasPath);
      await expect(repairCanonicalSessionKeys({ apply: true, cfg: {}, env })).rejects.toThrow(
        "hard-linked path",
      );
      expect(fs.readFileSync(sqlitePath)).toEqual(original);
      expect(fs.readFileSync(aliasPath)).toEqual(original);
      expect(
        fs
          .readdirSync(path.dirname(sqlitePath))
          .some((name) => name.startsWith(`${path.basename(sqlitePath)}.pre-startup-migration-`)),
      ).toBe(false);
    });
  });

  it.each(["held", "reopened"] as const)(
    "backs up pending empty owners before %s admission with no selected repair facts",
    async (handle) => {
      await withStateDirEnv("openclaw-doctor-pending-validity-", async ({ stateDir }) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env });
        const options = {
          agentId: "main",
          env,
          path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
        };
        const sessionKey = "agent:main:retained";
        insertLegacySession({
          agentId: "main",
          entry: { sessionId: "pending-retained", updatedAt: 20 },
          env,
          sessionKey,
          storePath,
        });
        const database = openOpenClawAgentDatabase(options);
        database.db
          .prepare("UPDATE session_nodes SET entry_json = '{}' WHERE session_key = ?")
          .run(sessionKey);
        const nodesBefore = database.db.prepare("SELECT * FROM session_nodes").all();
        const windowsBefore = database.db.prepare("SELECT * FROM session_windows").all();
        expect(nodesBefore).toHaveLength(1);
        expect(nodesBefore[0]).toMatchObject({ entry_json: "{}", entry_valid: 0 });
        if (handle === "reopened") {
          await closeOpenClawAgentDatabasesAsync(stateDir);
        }
        const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
        expect(await repairCanonicalSessionKeys({ apply: false, cfg, env })).toMatchObject({
          foundGroups: 0,
          repairedGroups: 0,
        });
        expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
          foundGroups: 0,
          repairedGroups: 0,
        });
        const repaired = openOpenClawAgentDatabase(options);
        expect(repaired.db.prepare("SELECT * FROM session_nodes").all()).toEqual(
          nodesBefore.map((row) => ({ ...row, entry_valid: -1 })),
        );
        expect(repaired.db.prepare("SELECT * FROM session_windows").all()).toEqual(windowsBefore);
        const backups = fs
          .readdirSync(path.dirname(database.path))
          .filter(
            (name) =>
              name.startsWith(`${path.basename(database.path)}.pre-startup-migration-`) &&
              name.endsWith(".bak"),
          );
        expect(backups).toHaveLength(1);
        using backup = new DatabaseSync(
          path.join(
            path.dirname(database.path),
            expectDefined(backups[0], "original state backup"),
          ),
          { readOnly: true },
        );
        expect(backup.prepare("SELECT * FROM session_nodes").all()).toEqual(nodesBefore);
        expect(backup.prepare("SELECT * FROM session_windows").all()).toEqual(windowsBefore);
      });
    },
  );

  it("retains the source when protected destination history changes before source cleanup", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-custody-race-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const sourceStore = resolveSessionStorePathCore(storeTemplate, { agentId: "ops", env });
      const destinationStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const sourceKey = "agent:main:work ";
      insertLegacySession({
        agentId: "ops",
        env,
        storePath: sourceStore,
        sessionKey: sourceKey,
        entry: {
          sessionId: "protected-session",
          updatedAt: 20,
          retainedHistoryReferences: { sessionIds: ["protected-session"], artifactPaths: [] },
        },
        eventText: "protected source history",
      });
      const source = openOpenClawAgentDatabase({
        agentId: "ops",
        env,
        path: resolveSqliteTargetFromSessionStorePath(sourceStore, { agentId: "ops", env }).path,
      });
      const readSource = () => ({
        nodes: source.db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
        windows: source.db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
        events: source.db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
      });
      let sourceBeforeCleanup: ReturnType<typeof readSource> | undefined;
      const applyMutation = lifecycle.applySessionEntryLifecycleMutation;
      vi.spyOn(lifecycle, "applySessionEntryLifecycleMutation").mockImplementation(
        async (params) => {
          const result = await applyMutation(params);
          if (params.storePath === destinationStore) {
            sourceBeforeCleanup = readSource();
            const destination = openOpenClawAgentDatabase({
              agentId: "main",
              env,
              path: resolveSqliteTargetFromSessionStorePath(destinationStore, {
                agentId: "main",
                env,
              }).path,
            });
            destination.db
              .prepare(
                "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 0",
              )
              .run(
                JSON.stringify({
                  type: "message",
                  id: "protected-session-message",
                  parentId: null,
                  message: { role: "user", content: "concurrent destination rewrite" },
                }),
                "protected-session",
              );
          }
          return result;
        },
      );

      await expect(
        repairCanonicalSessionKeys({
          apply: true,
          cfg: {
            agents: { entries: { main: {}, ops: {} } },
            session: { mainKey: "work", store: storeTemplate },
          },
          env,
        }),
      ).rejects.toThrow("Protected transcript protected-session");
      expect(sourceBeforeCleanup).toBeDefined();
      expect(readSource()).toEqual(sourceBeforeCleanup);
    });
  });

  it("rejects stale canonical facts after delivery evidence changes", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-stale-fact-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const sessionKey = "agent:main:matrix:channel:!mixedcase:example.org";
      insertLegacySession({
        agentId: "main",
        entry: {
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!MixedCase:example.org" },
          }),
          sessionId: "stale-delivery-session",
          updatedAt: 10,
        },
        env,
        sessionKey,
        storePath,
      });
      const { facts } = readCanonicalSessionRepairInventory({ agentId: "main", env, storePath });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      const changedEntry = {
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!MIXEDCASE:example.org" },
        }),
        label: "concurrent unrelated metadata",
        sessionId: "stale-delivery-session",
        updatedAt: 10,
      };
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify(changedEntry), sessionKey);
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);

      expect(
        readCanonicalSessionRepairInventory({ agentId: "main", env, storePath }).facts[0]
          ?.decisionToken,
      ).not.toBe(facts[0]?.decisionToken);
      expect(() =>
        loadCanonicalSessionRepairEntries({ agentId: "main", env, storePath }, facts),
      ).toThrow("Canonical session repair inputs changed during scan");
      expect(
        database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual({ entry_json: JSON.stringify(changedEntry) });

      const cfg = {
        agents: { entries: { main: {} } },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:matrix:channel:!MIXEDCASE:example.org",
          storePath,
        })?.entry,
      ).toMatchObject({ label: "concurrent unrelated metadata" });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:matrix:channel:!MixedCase:example.org",
          storePath,
        }),
      ).toBeUndefined();
    });
  });
});
