import fs from "node:fs";
import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runDoctorTranscriptStorageBatch } from "../../commands/doctor-transcript-storage.test-support.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
} from "./session-accessor.js";
import {
  everySessionTranscriptUserInputFrom,
  readSessionTranscriptMessageEvents,
} from "./session-accessor.sqlite-active-events.js";
import {
  validateSessionTranscriptContextAdmission,
  validateSessionTranscriptContextAnchor,
} from "./session-accessor.sqlite-model-context.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe("SQLite admitted input reset fence", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };
  beforeEach(() => {
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-admission-fence-") },
      sessionId: "admission-fence-test",
      sessionKey: "agent:main:admission-fence-test",
    };
  });
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["admission", "anchor"] as const)(
    "keeps standalone %s validation on one snapshot during metadata cutover",
    async (validation) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [transcriptMessage("admitted", null, { role: "user", content: "admitted" })],
        touchSessionEntry: false,
      });
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
      if (!anchor) {
        throw new Error("missing real admission anchor");
      }
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
      const writer = openNodeSqliteDatabase(database.path);
      try {
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        runSqliteImmediateTransactionSync(writer, () => {
          // Restore the fixture's legacy metadata, then let the migration owner copy it.
          writer.exec(`
            INSERT INTO transcript_event_identities
              (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
            SELECT storage.session_id, identity.event_id, identity.seq, identity.event_type,
              identity.parent_id, identity.message_idempotency_key, identity.created_at
            FROM transcript_event_identity_rows AS identity
            JOIN transcript_storage_sessions AS storage ON storage.sid = identity.session_id;
            INSERT INTO session_transcript_active_events
              (session_id, active_position, event_seq, message_position, context_eligible)
            SELECT storage.session_id, active.active_position, active.event_seq,
              active.message_position, active.context_eligible
            FROM session_transcript_active_rows AS active
            JOIN transcript_storage_sessions AS storage ON storage.sid = active.session_id;
            DELETE FROM transcript_event_identity_rows;
            DELETE FROM session_transcript_active_rows;
            UPDATE transcript_storage_sessions SET phase = 'legacy';
            UPDATE transcript_storage_migration SET phase = 'identities', cursor = NULL,
              identity_high_water = (SELECT max(rowid) FROM transcript_event_identities),
              active_high_water = (SELECT max(rowid) FROM session_transcript_active_events)
            WHERE id = 1;
          `);
        });
        expect((await runDoctorTranscriptStorageBatch(writer)).phase).toBe("active");
        expect((await runDoctorTranscriptStorageBatch(writer)).phase).toBe("publish");

        const validate = () =>
          validation === "admission"
            ? validateSessionTranscriptContextAdmission(scope, {
                ...anchor,
                logicalTurnId: "metadata-cutover",
                role: "user",
              })
            : validateSessionTranscriptContextAnchor(scope, anchor);
        let routeSelected = false;
        let cutover = false;
        database.db.setAuthorizer((action, table, column) => {
          if (action === constants.SQLITE_READ) {
            if (table === "transcript_storage_sessions" && column === "phase") {
              routeSelected = true;
            }
            if (routeSelected && !cutover && table === "transcript_event_identities") {
              // Commit the completed copy's cutover after route selection, before identity SQL.
              cutover = true;
              runSqliteImmediateTransactionSync(writer, () => {
                writer.exec(`
                  UPDATE transcript_storage_sessions SET phase = 'compact';
                  DELETE FROM transcript_event_identities;
                  DELETE FROM session_transcript_active_events;
                  UPDATE transcript_storage_migration SET phase = 'complete', cursor = NULL WHERE id = 1;
                `);
              });
            }
          }
          return constants.SQLITE_OK;
        });
        try {
          expect(validate).not.toThrow();
          expect(cutover).toBe(true);
          expect(database.db.isTransaction).toBe(false);
        } finally {
          database.db.setAuthorizer(null);
        }
        expect(writer.prepare("SELECT phase FROM transcript_storage_migration").get()?.phase).toBe(
          "complete",
        );
        expect(
          writer.prepare("SELECT count(*) AS count FROM transcript_event_identities").get()?.count,
        ).toBe(0);
        expect(validate).not.toThrow();
        writer
          .prepare("UPDATE transcript_event_identity_rows SET parent_id = ? WHERE event_id = ?")
          .run("changed-parent", anchor.entryId);
        expect(validate).toThrow(
          validation === "admission"
            ? "Current-turn transcript admission identity changed"
            : "Completed-turn transcript anchor changed",
        );
      } finally {
        writer.close();
      }
    },
  );

  it.each([false, true])(
    "rejects a completion source reset before admission (retained=%s)",
    async (retained) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("source", null, {
            role: "user",
            content: "completed child",
            idempotencyKey: "source:user",
          }),
        ],
        touchSessionEntry: false,
      });
      expect(everySessionTranscriptUserInputFrom(scope, "source:user", () => true)).toBe(true);
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "before-admission-reset",
        parentId: "source",
        timestamp: "2026-09-14T00:00:00.000Z",
        reason: "new",
        ...(retained ? { firstKeptEntryId: "source" } : {}),
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("admitted", "before-admission-reset", {
            role: "user",
            content: "admitted",
            idempotencyKey: "admitted:user",
          }),
        ],
        touchSessionEntry: false,
      });
      expect(
        readSessionTranscriptMessageEvents(scope).some(
          ({ event }) =>
            typeof event === "object" && event !== null && "id" in event && event.id === "source",
        ),
      ).toBe(retained);
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
      if (!anchor) {
        throw new Error("missing real admission anchor");
      }
      const accept = () => everySessionTranscriptUserInputFrom(scope, "source:user", () => true);
      expect(accept()).toBe(false);
      expect(
        runWithSessionTranscriptReadFence(
          { ...anchor, logicalTurnId: "recovery", role: "user" },
          accept,
        ),
      ).toBe(false);
    },
  );

  it("accepts an admission store path that aliases the same database", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("source", null, {
          role: "user",
          content: "source",
          idempotencyKey: "source:user",
        }),
        transcriptMessage("admitted", "source", {
          role: "user",
          content: "admitted",
          idempotencyKey: "admitted:user",
        }),
      ],
      touchSessionEntry: false,
    });
    const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
    if (!anchor) {
      throw new Error("missing real admission anchor");
    }
    const aliasDir = path.join(path.dirname(path.dirname(anchor.storePath)), "agent-alias");
    fs.symlinkSync(
      path.dirname(anchor.storePath),
      aliasDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(
      runWithSessionTranscriptReadFence(
        {
          ...anchor,
          logicalTurnId: "aliased-store",
          role: "user",
          storePath: path.join(aliasDir, path.basename(anchor.storePath)),
        },
        () => everySessionTranscriptUserInputFrom(scope, "source:user", () => true),
      ),
    ).toBe(true);
  });

  it.each([false, true])(
    "keeps pre-fence control facts through a later reset (human=%s)",
    async (human) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("source", null, {
            role: "user",
            content: "result",
            idempotencyKey: "source:user",
          }),
          ...(human
            ? [
                transcriptMessage("human", "source", {
                  role: "user",
                  content: "new work",
                  idempotencyKey: "human:user",
                }),
              ]
            : []),
          transcriptMessage("admitted", human ? "human" : "source", {
            role: "user",
            content: "admitted",
            idempotencyKey: "admitted:user",
          }),
        ],
        touchSessionEntry: false,
      });
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
      if (!anchor) {
        throw new Error("missing real admission anchor");
      }
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "later-reset",
        parentId: "admitted",
        timestamp: "2026-09-14T00:00:00.000Z",
        reason: "new",
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("after-reset", "later-reset", { role: "user", content: "fresh" }),
        ],
        touchSessionEntry: false,
      });
      expect(everySessionTranscriptUserInputFrom(scope, "source:user", () => true)).toBe(false);
      const seen: unknown[] = [];
      const result = runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "fenced", role: "user" },
        () =>
          everySessionTranscriptUserInputFrom(scope, "source:user", (message) => {
            seen.push(message);
            return (message as { idempotencyKey?: string }).idempotencyKey !== "human:user";
          }),
      );
      expect(result).toBe(!human);
      expect(
        seen.map((message) => (message as { idempotencyKey?: string }).idempotencyKey),
      ).toEqual(human ? ["source:user", "human:user"] : ["source:user"]);
    },
  );
});
