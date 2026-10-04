import { describe, expect, it } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

describe("Doctor stored session addresses", () => {
  it("preserves original rows when a fork source key has no canonical address", async () => {
    await withOpenClawTestState({ prefix: "doctor-blank-fork-source-" }, async (state) => {
      const storePath = state.statePath("agents", "main", "sessions.json");
      const sessionKey = "agent:main:child";
      const scope = { agentId: "main", env: state.env, storePath };
      insertLegacySession({
        ...scope,
        sessionKey,
        entry: {
          sessionId: "child-history",
          updatedAt: 7,
          forkSource: {
            sessionKey: " \t ",
            sessionId: "original-source-generation",
            entryId: "original-cut-entry",
          },
        },
        eventText: "preserved child history",
      });
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        env: scope.env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
      });
      const readRows = () => ({
        nodes: database.db.prepare("SELECT * FROM session_nodes").all(),
        windows: database.db.prepare("SELECT * FROM session_windows").all(),
        events: database.db.prepare("SELECT * FROM transcript_events").all(),
      });
      const before = readRows();
      await expect(
        repairCanonicalSessionKeys({
          apply: true,
          cfg: { session: { store: storePath } },
          env: state.env,
        }),
      ).rejects.toThrow(
        /forkSource\.sessionKey.*agent:main:child.*verified source session key.*doctor --fix/,
      );
      expect(readRows()).toEqual(before);
    });
  });

  it.each(["custom-main", "global"])(
    "preserves literal main rows and lineage beside the %s request destination",
    async (variant) => {
      await withOpenClawTestState({ prefix: "doctor-stored-address-" }, async (state) => {
        const store = state.statePath("agents", "{agentId}", "sessions.json");
        const scope = {
          agentId: "main",
          env: state.env,
          storePath: store.replace("{agentId}", "main"),
        };
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          session: variant === "global" ? { scope: "global", store } : { mainKey: "work", store },
        };
        const literal = "agent:main:main";
        const destination = variant === "global" ? "global" : "agent:main:work";
        const child = "agent:main:child";
        for (const sessionKey of [literal, destination, child]) {
          const target = { ...scope, sessionKey, sessionId: `window-${sessionKey}` };
          replaceSessionEntrySync(target, {
            sessionId: target.sessionId,
            updatedAt: 1,
            ...(sessionKey === child
              ? {
                  parentSessionKey: literal,
                  spawnedBy: literal,
                  forkSource: {
                    sessionKey: literal,
                    sessionId: `window-${literal}`,
                    entryId: "parent-entry",
                  },
                }
              : {}),
          });
          await persistSessionTranscriptTurn(target, {
            expectedSessionId: target.sessionId,
            messages: [{ message: { role: "user", content: sessionKey } }],
            updateMode: "none",
          });
        }
        const readRows = () =>
          [literal, destination, child].map((sessionKey) =>
            loadExactSessionEntryReadOnly({ ...scope, sessionKey }),
          );
        const before = readRows();
        expect(resolveSessionStoreKey({ cfg, sessionKey: literal, storeAgentId: "main" })).toBe(
          destination,
        );
        for (const apply of [false, true]) {
          expect(await repairCanonicalSessionKeys({ apply, cfg, env: state.env })).toMatchObject({
            foundGroups: 0,
            removedRows: 0,
            repairedGroups: 0,
          });
          expect(readRows()).toEqual(before);
          for (const sessionKey of [literal, destination, child]) {
            expect(
              await loadTranscriptEvents({
                ...scope,
                sessionKey,
                sessionId: `window-${sessionKey}`,
              }),
            ).toContainEqual(
              expect.objectContaining({
                type: "message",
                message: { role: "user", content: sessionKey },
              }),
            );
          }
        }
      });
    },
  );

  it.each(["main", "work"])(
    "still repairs a removed default agent's legacy %s address into the store owner",
    async (suffix) => {
      await withOpenClawTestState({ prefix: "doctor-legacy-default-owner-" }, async (state) => {
        const store = state.statePath("agents", "{agentId}", "sessions.json");
        const scope = {
          agentId: "ops",
          env: state.env,
          storePath: store.replace("{agentId}", "ops"),
        };
        const cfg: OpenClawConfig = {
          agents: { entries: { ops: {} } },
          session: { mainKey: "work", store },
        };
        const sessionKey = `agent:main:${suffix}`;
        insertLegacySession({
          ...scope,
          sessionKey,
          entry: { sessionId: "legacy-history", updatedAt: 1 },
          eventText: "kept legacy history",
        });
        const childKey = "agent:ops:child";
        insertLegacySession({
          ...scope,
          sessionKey: childKey,
          entry: {
            sessionId: "child-history",
            updatedAt: 1,
            parentSessionKey: sessionKey,
            spawnedBy: sessionKey,
            forkSource: {
              sessionKey,
              sessionId: "legacy-history",
              entryId: "legacy-history-message",
            },
          },
        });
        const retiredScope = {
          ...scope,
          agentId: "main",
          storePath: store.replace("{agentId}", "main"),
          sessionKey,
        };
        replaceSessionEntrySync(retiredScope, { sessionId: "retired-history", updatedAt: 1 });
        await persistSessionTranscriptTurn(
          { ...retiredScope, sessionId: "retired-history" },
          {
            expectedSessionId: "retired-history",
            messages: [{ message: { role: "user", content: "kept retired history" } }],
            updateMode: "none",
          },
        );
        const retiredBefore = loadExactSessionEntryReadOnly(retiredScope);
        expect(
          await repairCanonicalSessionKeys({ apply: false, cfg, env: state.env }),
        ).toMatchObject({ foundGroups: 2, repairedGroups: 0 });
        expect(
          await repairCanonicalSessionKeys({ apply: true, cfg, env: state.env }),
        ).toMatchObject({ foundGroups: 2, repairedGroups: 2, removedRows: 1 });
        expect(loadExactSessionEntryReadOnly({ ...scope, sessionKey })).toBeUndefined();
        const repairedScope = { ...scope, sessionKey: "agent:ops:work" };
        expect(loadExactSessionEntryReadOnly(repairedScope)?.entry.sessionId).toBe(
          "legacy-history",
        );
        expect(
          await loadTranscriptEvents({ ...repairedScope, sessionId: "legacy-history" }),
        ).toContainEqual(
          expect.objectContaining({ message: { role: "user", content: "kept legacy history" } }),
        );
        expect(
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: childKey })?.entry,
        ).toMatchObject({
          parentSessionKey: repairedScope.sessionKey,
          spawnedBy: repairedScope.sessionKey,
          forkSource: {
            sessionKey: repairedScope.sessionKey,
            sessionId: "legacy-history",
            entryId: "legacy-history-message",
          },
        });
        expect(loadExactSessionEntryReadOnly(retiredScope)).toEqual(retiredBefore);
        expect(
          await loadTranscriptEvents({ ...retiredScope, sessionId: "retired-history" }),
        ).toContainEqual(
          expect.objectContaining({ message: { role: "user", content: "kept retired history" } }),
        );
        expect(
          await repairCanonicalSessionKeys({ apply: true, cfg, env: state.env }),
        ).toMatchObject({ foundGroups: 0, repairedGroups: 0 });
      });
    },
  );
});
