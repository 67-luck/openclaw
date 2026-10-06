import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
  validatePreparedAssistantAppendSync,
  type TranscriptEvent,
} from "./session-accessor.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-ancestry-");

async function createTranscript(events: TranscriptEvent[]) {
  const scope = {
    agentId: "main",
    sessionId: "ancestry",
    sessionKey: "agent:main:ancestry",
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  replaceTranscriptEventsSync(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    ...events,
  ]);
  return {
    scope,
    database: openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    }),
  };
}

function message(id: string, parentId: string | null): TranscriptEvent {
  return { type: "message", id, parentId, message: { role: "user", content: id } };
}

describe("SQLite transcript append ancestry", () => {
  const linear = [message("root", null), message("tail", "root")];
  const cycle = [message("cycle-a", "cycle-b"), message("cycle-b", "cycle-a")];
  it.each([
    {
      name: "dangling ancestor",
      events: [message("tail", "missing")],
      parentId: "missing",
      expected: "tail",
    },
    { name: "unrelated cycle", events: cycle, parentId: "outside", expected: "outside" },
    { name: "cycle without root", events: cycle, parentId: null, expected: null },
    {
      name: "invalid leaf navigation fallback",
      events: [...linear, { type: "leaf", id: "invalid", parentId: "tail", targetId: "missing" }],
      parentId: "root",
      expected: "tail",
    },
    {
      name: "parentless navigation fallback",
      events: [
        ...linear,
        { type: "message", id: "parentless", message: { role: "user", content: "late" } },
      ],
      parentId: "root",
      expected: "root",
    },
  ])("preserves $name", async ({ events, parentId, expected }) => {
    const { database, scope } = await createTranscript(events);
    expect(
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId,
        }),
      ),
    ).toBe(expected);
  });

  it("does not traverse an ancestor from another session", async () => {
    const { database, scope } = await createTranscript([message("tail", "foreign")]);
    const other = { ...scope, sessionId: "other", sessionKey: "agent:main:other" };
    await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(other, [message("foreign", "root")]);
    expect(
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId: "root",
        }),
      ),
    ).toBe("root");
  });
});

it.each(["missing-prepared", "missing-admitted", "overflow-prepared"] as const)(
  "preserves prepared assistant %s refusal before parsing newer messages",
  async (scenario) => {
    const { database, scope } = await createTranscript([
      message("admitted", null),
      message("prepared", "admitted"),
      message("poison", "prepared"),
      message("tail", "poison"),
    ]);
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3")
      .run(scope.sessionId);
    if (scenario === "overflow-prepared") {
      runSqliteImmediateTransactionSync(database.db, () => {
        database.db.exec(`
          CREATE TEMP TABLE overflow_identities AS SELECT * FROM transcript_event_identity_rows;
          CREATE TEMP TABLE overflow_active AS SELECT * FROM session_transcript_active_rows;
          DELETE FROM transcript_event_identity_rows;
          DELETE FROM session_transcript_active_rows;
        `);
        const offset = 9007199254740993n;
        database.db
          .prepare("UPDATE transcript_events SET seq = seq + ? WHERE session_id = ?")
          .run(offset, scope.sessionId);
        database.db
          .prepare(`INSERT INTO transcript_event_identity_rows
            SELECT session_id, event_id, seq + ?, event_type, parent_id,
              message_idempotency_key, created_at FROM overflow_identities`)
          .run(offset);
        database.db
          .prepare(
            `INSERT INTO session_transcript_active_rows
             SELECT session_id, active_position, event_seq + ?, message_position,
               context_eligible FROM overflow_active`,
          )
          .run(offset);
        database.db.exec("DROP TABLE overflow_identities; DROP TABLE overflow_active;");
      });
      expect(() => validatePreparedAssistantAppendSync(scope, "prepared", "prepared")).toThrow(
        expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
      );
    } else {
      database.db
        .prepare(
          "DELETE FROM transcript_event_identity_rows WHERE session_id = (SELECT sid FROM transcript_storage_sessions WHERE session_id = ?) AND event_id = ?",
        )
        .run(scope.sessionId, scenario === "missing-prepared" ? "prepared" : "admitted");
      expect(
        validatePreparedAssistantAppendSync(
          scope,
          "prepared",
          scenario === "missing-prepared" ? "prepared" : "admitted",
        ),
      ).toBeUndefined();
    }
    expect(database.db.isTransaction).toBe(false);
  },
);
