import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
import { readExactSessionEntriesWithLifecycle } from "./session-entry-read.worker.js";
import * as storeTarget from "./session-store-target-runtime.js";

it("reuses retained physical selection while reading fresh rows and keeping its original authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.path("selected.sqlite"),
      env: state.env,
    });
    const sessionKey = "agent:main:prepared-selection";
    writeSessionEntry(database, sessionKey, {
      sessionId: "original",
      updatedAt: 1,
      label: "before",
    });
    const held = retainOpenClawAgentDatabaseReadOnly({
      agentId: database.agentId,
      path: database.path,
      env: state.env,
    });
    if (!held.found) {
      throw new Error("Expected the seeded physical owner");
    }
    const identity = readOpenClawAgentDatabaseIdentity(held.database);
    if (typeof identity.identity !== "string") {
      throw new Error("Expected a durable physical identity");
    }
    const input = {
      agentId: "main",
      storePath: state.path("selected.json"),
      sessionKeys: [sessionKey],
      env: state.env,
      preparedSource: {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
        assertCurrent: held.claim.assertCurrent,
      },
    };
    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    const rediscovery = vi.spyOn(storeTarget, "withSessionStoreTarget");
    try {
      for (const projection of ["full", "sharing", "list", "exact"] as const) {
        const sql = observeHostDataSql();
        try {
          await withSessionEntriesFromStoresInWorker(
            [{ ...input, projection }],
            ([read]) => {
              read!.assertCurrent();
              expect(read!.result.entries[0]?.entry.label).toBe("before");
            },
            { ordered: true },
          );
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        expect(() =>
          readExactSessionEntriesWithLifecycle({
            kind: "session-exact-entries",
            database: { agentId: database.agentId, path: database.path },
            env: state.env,
            sessionKeys: [sessionKey],
            projection,
            expectedIdentity: { key: "file:another-generation", canonicalPath: database.path },
          }),
        ).toThrow("Agent database changed during repair admission");
      }
      const alternateEnv = {
        ...state.env,
        OPENCLAW_STATE_DIR: state.path("alternate-state"),
      };
      const alternate = openOpenClawAgentDatabase({ agentId: "main", env: alternateEnv });
      const alternateKey = "agent:main:redirected-selection";
      writeSessionEntry(alternate, alternateKey, { sessionId: "redirected", updatedAt: 1 });
      const alternateHeld = retainOpenClawAgentDatabaseReadOnly({
        agentId: alternate.agentId,
        path: alternate.path,
        env: alternateEnv,
      });
      if (!alternateHeld.found) {
        throw new Error("Expected the alternate physical owner");
      }
      try {
        const alternateIdentity = readOpenClawAgentDatabaseIdentity(alternateHeld.database);
        if (typeof alternateIdentity.identity !== "string") {
          throw new Error("Expected an alternate durable physical identity");
        }
        const later = {
          ...input,
          sessionKeys: [...input.sessionKeys],
          env: { ...input.env },
          preparedSource: { ...input.preparedSource },
        };
        const reading = withSessionEntriesFromStoresInWorker([input, later], ([first, second]) => {
          expect(first!.result.entries[0]?.entry.sessionId).toBe("original");
          expect(second!.database.path).toBe(database.path);
          expect(second!.database.env.OPENCLAW_STATE_DIR).toBe(state.env.OPENCLAW_STATE_DIR);
          expect(second!.result.entries).toEqual([
            expect.objectContaining({
              sessionKey,
              entry: expect.objectContaining({ sessionId: "original" }),
            }),
          ]);
        });
        // The first worker read has yielded; the later descriptor must already be captured.
        later.storePath = alternate.path;
        later.sessionKeys.splice(0, later.sessionKeys.length, alternateKey);
        later.env.OPENCLAW_STATE_DIR = alternateEnv.OPENCLAW_STATE_DIR;
        Object.assign(later.preparedSource, {
          agentId: alternate.agentId,
          path: alternate.path,
          databaseIdentity: alternateIdentity.identity,
          databaseBirthtime: alternateIdentity.birthtime,
          assertCurrent: alternateHeld.claim.assertCurrent,
        });
        await reading;
      } finally {
        alternateHeld.claim.release();
      }
      peer
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
        )
        .run("foreign", sessionKey);
      await withSessionEntriesFromStoresInWorker(
        [input],
        ([read]) => expect(read!.result.entries[0]?.entry.label).toBe("foreign"),
        { ordered: true },
      );
      await expect(
        withSessionEntriesFromStoresInWorker(
          [input],
          ([read]) => {
            database.db
              .prepare("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?")
              .run(sessionKey);
            read!.assertCurrent();
          },
          { ordered: true },
        ),
      ).rejects.toThrow("Session entry changed during read");
      held.claim.release();
      await expect(
        withSessionEntriesFromStoresInWorker([input], () => {}, { ordered: true }),
      ).rejects.toThrow("OpenClaw agent database claim is no longer current");
      expect(rediscovery).not.toHaveBeenCalled();
    } finally {
      rediscovery.mockRestore();
      peer.close();
      held.claim.release();
    }
  });
});

it("retains the foreground FIFO through a nested ordered read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:nested-read";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const options = { agentId: "main", path: database.path, env };
    const entered = createDeferred();
    const ready = createDeferred();
    const order: string[] = [];
    const outer = runOpenClawAgentWriteAdmission(options, async () => {
      entered.resolve();
      await ready.promise;
      await withSessionEntriesFromStoresInWorker(
        [{ agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env }],
        ([read]) => {
          read?.assertCurrent();
          expect(read?.result.entries[0]?.entry.sessionId).toBe("original");
          order.push("read");
        },
        { ordered: true },
      );
      expect(order).toEqual(["read"]);
    });
    await awaitGateBeforeSettlement(entered.promise, outer, "Foreground admission did not begin");
    const following = runOpenClawAgentWriteAdmission(options, () => {
      order.push("writer");
    });
    ready.resolve();
    await Promise.all([outer, following]);
    expect(order).toEqual(["read", "writer"]);
  });
});

it("rejects an ordered read inside an active worker reservation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:reserved-read";
    writeSessionEntry(database, sessionKey, { sessionId: "reserved", updatedAt: 1 });
    let consumed = false;
    const prepared = createDeferred();
    const { pending } = await runOpenClawAgentWorkerWrite(
      { agentId: "main", path: database.path, env },
      async () => {
        const read = withSessionEntriesFromStoresInWorker(
          [{ agentId: "main", storePath: database.path, sessionKeys: [sessionKey], env }],
          () => {
            consumed = true;
          },
          { ordered: true, prepareSource: () => prepared.resolve() },
        );
        void read.catch(() => {});
        await awaitGateBeforeSettlement(prepared.promise, read, "Reader source was not prepared");
        return { pending: read };
      },
    );
    await expect(pending).rejects.toThrow("cannot reenter an active SQLite writer admission");
    expect(consumed).toBe(false);
  });
});

it("rejects ordered reads that invert an inherited store acquisition", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const first = openOpenClawAgentDatabase({ agentId: "first", env });
    const second = openOpenClawAgentDatabase({ agentId: "second", env });
    const lower = first.path < second.path ? first : second;
    const higher = lower === first ? second : first;
    const sessionKey = `agent:${lower.agentId}:ordered-read`;
    writeSessionEntry(lower, sessionKey, { sessionId: "lower", updatedAt: 1 });
    await expect(
      runOpenClawAgentWriteAdmission({ agentId: higher.agentId, path: higher.path, env }, () =>
        withSessionEntriesFromStoresInWorker(
          [{ agentId: lower.agentId, storePath: lower.path, sessionKeys: [sessionKey], env }],
          () => {},
          { ordered: true },
        ),
      ),
    ).rejects.toThrow("would invert inherited SQLite writer admission order");
  });
});
