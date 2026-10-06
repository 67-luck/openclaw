import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import {
  initializeTranscriptStorageMigration,
  withoutTranscriptStorageSchema,
} from "../state/openclaw-agent-transcript-storage-schema.js";
import { migrateDoctorTranscriptStorage } from "./doctor-transcript-storage.js";
import { runDoctorTranscriptStorageBatch as batch } from "./doctor-transcript-storage.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const wideRowid = 9_007_199_254_740_993n;

function createFixture(pathname: string) {
  const database = openNodeSqliteDatabase(pathname);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(withoutTranscriptStorageSchema(OPENCLAW_AGENT_SCHEMA_SQL));
  return database;
}

function createSession(database: DatabaseSync, sessionId: string) {
  database
    .prepare(
      "INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', 1)",
    )
    .run(sessionId, sessionId);
  database
    .prepare(
      "INSERT INTO session_windows(session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    )
    .run(sessionId, sessionId);
}

function fixtureEvent(seq: number): string {
  const text = seq % 16 < 8 ? "ok 雪" : "Synthetic tool output 雪🦞 ".repeat(256);
  const common = {
    id: `event-${seq}`,
    parentId: "missing-parent",
    timestamp: "2026-09-30T00:00:00.000Z",
  };
  const content = [{ type: "text", text }];
  const variants = [
    { type: "message", message: { role: "assistant", content } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${seq}`,
        toolName: "exec",
        content,
        details: { exitCode: 0 },
      },
    },
    {
      type: "custom_message",
      customType: "openclaw.nested-tool.v1",
      display: true,
      content: [
        { type: "toolCall", id: `nested-${seq}`, name: "read", arguments: {} },
        { type: "toolResult", role: "toolResult", toolCallId: `nested-${seq}`, content },
      ],
    },
    {
      type: "custom",
      customType: "openclaw.cache-ttl",
      data: {
        timestamp: 1_700_000_000_000,
        provider: "synthetic",
        modelId: "fixture",
        prunedToolResults: [{ key: `tool:${seq}`, mode: "hard" }],
        frozenToolResults: [{ key: `tool:${seq}`, text }],
        ambiguousToolResultBaseKeys: [],
      },
    },
    { type: "message", message: { role: "user", content } },
    {
      type: "custom_message",
      customType: "openclaw.runtime-context",
      content: text,
      display: false,
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    },
    {
      type: "custom_message",
      customType: "openclaw.sessions_yield",
      content: text,
      display: false,
      details: { source: "sessions_yield", message: "wait for follow-up" },
    },
    { type: "compaction", summary: text, firstKeptEntryId: "prior-event", tokensBefore: 1_234 },
  ];
  const event = JSON.stringify({ ...common, ...variants[seq % variants.length] });
  return ` ${seq % 13 === 0 ? event.replaceAll("雪", "\\u96EA") : event}\n`;
}

function insertLegacy(
  database: DatabaseSync,
  sessionId: string,
  seq: number,
  rowid: bigint | number,
) {
  const payload = prepareTranscriptPayload(database, fixtureEvent(seq));
  database
    .prepare(
      `INSERT INTO transcript_events
        (session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      sessionId,
      seq,
      payload.event_json,
      payload.event_zstd,
      payload.event_utf8_bytes,
      payload.navigation_json,
    );
  const identity = database.prepare(`INSERT INTO transcript_event_identities
    (rowid, session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  identity.setReadBigInts(true);
  identity.run(
    rowid,
    sessionId,
    `event-${seq}`,
    seq,
    seq % 2 ? null : "custom",
    "missing-parent",
    seq % 2 ? null : `idempotency-${seq}`,
    wideRowid,
  );
  const active = database.prepare(`INSERT INTO session_transcript_active_events
    (rowid, session_id, active_position, event_seq, message_position, context_eligible)
    VALUES (?, ?, ?, ?, ?, ?)`);
  active.setReadBigInts(true);
  active.run(rowid, sessionId, seq - 1, seq, seq % 2 ? null : seq, seq % 3 ? 1 : null);
}

function beginMigration(database: DatabaseSync) {
  runSqliteImmediateTransactionSync(database, () =>
    initializeTranscriptStorageMigration(database, OPENCLAW_AGENT_SCHEMA_SQL),
  );
}

it("resumes Doctor metadata conversion after cancellation between committed batches", async () => {
  using database = createFixture(":memory:");
  createSession(database, "fixture");
  insertLegacy(database, "fixture", 1, 1);
  beginMigration(database);
  const controller = new AbortController();
  const interrupted = new Error("operator stopped metadata conversion");
  await expect(
    migrateDoctorTranscriptStorage(database, {
      signal: controller.signal,
      assertCurrent() {},
      onProgress() {
        controller.abort(interrupted);
      },
    }),
  ).rejects.toBe(interrupted);
  expect(database.isTransaction).toBe(false);
  expect(database.prepare("SELECT phase FROM transcript_storage_migration").get()?.phase).toBe(
    "active",
  );
  const options = { signal: new AbortController().signal, assertCurrent() {} };
  expect((await migrateDoctorTranscriptStorage(database, options)).batches).toBe(3);
  expect(database.prepare("SELECT phase FROM transcript_storage_migration").get()?.phase).toBe(
    "complete",
  );
  expect(
    database.prepare("SELECT count(*) AS count FROM transcript_event_identity_rows").get()?.count,
  ).toBe(1);
  expect((await migrateDoctorTranscriptStorage(database, options)).batches).toBe(0);
});

function metadata(database: DatabaseSync, compact: boolean) {
  return compact
    ? {
        identities: database
          .prepare(`SELECT storage.session_id, row.event_id, row.seq, row.event_type,
          row.parent_id, row.message_idempotency_key, CAST(row.created_at AS TEXT) AS created_at
          FROM transcript_event_identity_rows AS row JOIN transcript_storage_sessions AS storage
          ON storage.sid = row.session_id ORDER BY storage.session_id, row.event_id`)
          .all(),
        active: database
          .prepare(`SELECT storage.session_id, row.active_position, row.event_seq,
          row.message_position, row.context_eligible FROM session_transcript_active_rows AS row
          JOIN transcript_storage_sessions AS storage ON storage.sid = row.session_id
          ORDER BY storage.session_id, row.event_seq`)
          .all(),
      }
    : {
        identities: database
          .prepare(`SELECT session_id, event_id, seq, event_type, parent_id,
          message_idempotency_key, CAST(created_at AS TEXT) AS created_at
          FROM transcript_event_identities ORDER BY session_id, event_id`)
          .all(),
        active: database
          .prepare(`SELECT session_id, active_position, event_seq, message_position,
          context_eligible FROM session_transcript_active_events ORDER BY session_id, event_seq`)
          .all(),
      };
}

function originalPayloads(database: DatabaseSync) {
  return database
    .prepare(`SELECT seq,
    CASE WHEN event_json IS NULL THEN NULL ELSE hex(CAST(event_json AS BLOB)) END AS event_json,
    CASE WHEN event_zstd IS NULL THEN NULL ELSE hex(event_zstd) END AS event_zstd,
    event_utf8_bytes, navigation_json FROM transcript_events
    WHERE session_id = 'fixture' AND seq BETWEEN 1 AND 260 ORDER BY seq`)
    .all();
}

function mutateLegacy(
  database: DatabaseSync,
  seq: number,
  deletedSeq: number,
  rowid: bigint | number,
) {
  insertLegacy(database, "fixture", seq, rowid);
  database
    .prepare(
      "UPDATE transcript_event_identities SET parent_id = ?, event_type = NULL WHERE seq = 1",
    )
    .run(`unresolved-${seq}`);
  database
    .prepare(
      "UPDATE session_transcript_active_events SET active_position = ?, context_eligible = NULL WHERE event_seq = 1",
    )
    .run(seq + 1_000);
  database.prepare("DELETE FROM transcript_event_identities WHERE seq = ?").run(deletedSeq);
  database
    .prepare("DELETE FROM session_transcript_active_events WHERE event_seq = ?")
    .run(deletedSeq);
}

it("resumes bounded copies and preserves mutations through publication and cleanup", async () => {
  const pathname = path.join(tempDirs.make("transcript-storage-"), "agent.sqlite");
  const initial = createFixture(pathname);
  let payloads: ReturnType<typeof originalPayloads>;
  try {
    createSession(initial, "fixture");
    runSqliteImmediateTransactionSync(initial, () => {
      for (let seq = 1; seq <= 260; seq++) {
        insertLegacy(initial, "fixture", seq, seq === 1 ? -17 : seq === 260 ? wideRowid : seq);
      }
    });
    payloads = originalPayloads(initial);
    expect(payloads.some((row) => row.event_zstd !== null)).toBe(true);
    expect(payloads.some((row) => row.event_json !== null)).toBe(true);
    expect(payloads.find((row) => row.seq === 13)?.event_json).toBe(
      Buffer.from(fixtureEvent(13)).toString("hex").toUpperCase(),
    );
    beginMigration(initial);
    await expect(
      migrateDoctorTranscriptStorage(initial, {
        signal: new AbortController().signal,
        assertCurrent() {
          if (
            initial.isTransaction &&
            initial.prepare("SELECT cursor FROM transcript_storage_migration").get()?.cursor !==
              null
          ) {
            throw new Error("interrupted copy");
          }
        },
      }),
    ).rejects.toThrow("interrupted copy");
    expect(initial.prepare("SELECT phase, cursor FROM transcript_storage_migration").get()).toEqual(
      { phase: "identities", cursor: null },
    );
    expect(metadata(initial, true)).toEqual({ identities: [], active: [] });
    expect(await batch(initial)).toMatchObject({ phase: "identities", copiedRows: 256 });
    expect(
      initial
        .prepare(
          "SELECT CAST(identity_high_water AS TEXT) AS high_water, CAST(cursor AS TEXT) AS cursor FROM transcript_storage_migration",
        )
        .get(),
    ).toEqual({ high_water: String(wideRowid), cursor: "256" });
    using peer = openNodeSqliteDatabase(pathname);
    mutateLegacy(peer, 261, 2, -18);
  } finally {
    initial.close();
  }

  using database = openNodeSqliteDatabase(pathname);
  database.exec("PRAGMA foreign_keys = ON");
  expect(await batch(database)).toMatchObject({ phase: "active", copiedRows: 4 });
  using peer = openNodeSqliteDatabase(pathname);
  mutateLegacy(peer, 262, 3, wideRowid + 10n);
  expect(await batch(database)).toMatchObject({ phase: "active", copiedRows: 256 });
  expect(await batch(database)).toMatchObject({ phase: "publish", copiedRows: 3 });
  expect(metadata(database, true)).toEqual(metadata(database, false));
  expect(database.prepare("SELECT phase FROM transcript_storage_sessions").get()?.phase).toBe(
    "legacy",
  );

  await expect(
    migrateDoctorTranscriptStorage(database, {
      signal: new AbortController().signal,
      assertCurrent() {
        if (
          database.isTransaction &&
          database.prepare("SELECT phase FROM transcript_storage_sessions").get()?.phase ===
            "compact"
        ) {
          throw new Error("interrupted publication");
        }
      },
    }),
  ).rejects.toThrow("interrupted publication");
  expect(database.prepare("SELECT phase FROM transcript_storage_migration").get()?.phase).toBe(
    "publish",
  );
  expect(database.prepare("SELECT phase FROM transcript_storage_sessions").get()?.phase).toBe(
    "legacy",
  );
  expect(await batch(database)).toMatchObject({ phase: "cleanup", publishedSessions: 1 });

  database.exec(`UPDATE transcript_event_identity_rows SET parent_id = 'compact-owner' WHERE event_id = 'event-1';
    DELETE FROM transcript_event_identity_rows WHERE event_id = 'event-4';
    UPDATE session_transcript_active_rows SET context_eligible = 0 WHERE event_seq = 1;
    DELETE FROM session_transcript_active_rows WHERE event_seq = 4;
    INSERT INTO transcript_events(session_id, seq, event_json, created_at) VALUES ('fixture', 300, '{}', 1);
    INSERT INTO transcript_event_identity_rows(session_id, event_id, seq, created_at)
      SELECT sid, 'compact-insert', 300, 1 FROM transcript_storage_sessions WHERE session_id = 'fixture';
    INSERT INTO session_transcript_active_rows(session_id, active_position, event_seq)
      SELECT sid, 300, 300 FROM transcript_storage_sessions WHERE session_id = 'fixture';`);
  const expected = metadata(database, true);
  expect(await batch(database)).toMatchObject({ phase: "cleanup", deletedRows: 256 });
  expect(await batch(database)).toMatchObject({ phase: "cleanup", deletedRows: 256 });
  expect(await batch(database)).toMatchObject({ phase: "complete", deletedRows: 8, done: true });
  expect(metadata(database, false)).toEqual({ identities: [], active: [] });
  expect(metadata(database, true)).toEqual(expected);
  expect(originalPayloads(database)).toEqual(payloads);
  expect(
    (
      await migrateDoctorTranscriptStorage(database, {
        signal: new AbortController().signal,
        assertCurrent() {},
      })
    ).batches,
  ).toBe(0);

  for (const statement of [
    `INSERT INTO transcript_event_identity_rows(session_id, event_id, seq, created_at)
      SELECT sid, 'missing', 999, 1 FROM transcript_storage_sessions WHERE session_id = 'fixture'`,
    `INSERT INTO session_transcript_active_rows(session_id, active_position, event_seq)
      SELECT sid, 999, 999 FROM transcript_storage_sessions WHERE session_id = 'fixture'`,
    "UPDATE transcript_event_identity_rows SET seq = 999 WHERE event_id = 'event-5'",
    "UPDATE session_transcript_active_rows SET event_seq = 999 WHERE event_seq = 5",
  ]) {
    expect(() => database.exec(statement)).toThrow(/event does not exist/);
  }
  expect(() =>
    database.exec(
      "UPDATE transcript_events SET seq = 999 WHERE session_id = 'fixture' AND seq = 5",
    ),
  ).toThrow("transcript event key is referenced");
  database.exec("DELETE FROM transcript_events WHERE session_id = 'fixture' AND seq = 5");
  expect(
    database.prepare("SELECT seq FROM transcript_event_identity_rows WHERE seq IN (5, 6)").all(),
  ).toEqual([{ seq: 6 }]);
  expect(
    database
      .prepare("SELECT event_seq FROM session_transcript_active_rows WHERE event_seq IN (5, 6)")
      .all(),
  ).toEqual([{ event_seq: 6 }]);
});

it("bounds session publication while retaining later legacy mutations", async () => {
  using database = createFixture(":memory:");
  runSqliteImmediateTransactionSync(database, () => {
    for (let index = 0; index < 257; index++) {
      createSession(database, `session-${String(index).padStart(3, "0")}`);
    }
  });
  beginMigration(database);
  expect(await batch(database)).toMatchObject({ phase: "active", copiedRows: 0 });
  expect(await batch(database)).toMatchObject({ phase: "publish", copiedRows: 0 });
  expect(await batch(database)).toMatchObject({ phase: "publish", publishedSessions: 256 });
  const remaining = database
    .prepare("SELECT session_id FROM transcript_storage_sessions WHERE phase = 'legacy'")
    .all();
  expect(remaining).toHaveLength(1);
  const legacySessionId = remaining[0]?.session_id;
  if (typeof legacySessionId !== "string") {
    throw new Error("Missing final legacy session");
  }
  insertLegacy(database, legacySessionId, 1, -1);
  expect(metadata(database, true)).toEqual(metadata(database, false));
  expect(await batch(database)).toMatchObject({ phase: "cleanup", publishedSessions: 1 });
  expect(await batch(database)).toMatchObject({ phase: "complete", deletedRows: 2, done: true });
  expect(metadata(database, true).identities).toMatchObject([
    { session_id: legacySessionId, parent_id: "missing-parent", created_at: String(wideRowid) },
  ]);
  createSession(database, "new-session");
  expect(
    database
      .prepare("SELECT phase FROM transcript_storage_sessions WHERE session_id = 'new-session'")
      .get()?.phase,
  ).toBe("compact");
});

it("bounds metadata bytes without skipping rows and admits one oversized row", async () => {
  using database = createFixture(":memory:");
  createSession(database, "fixture");
  for (let seq = 1; seq <= 3; seq++) {
    insertLegacy(database, "fixture", seq, seq);
  }
  // Build large historical IDs natively so the fixture and migration never hydrate them in JavaScript.
  database.exec(`UPDATE transcript_event_identities
    SET parent_id = replace(hex(zeroblob(CASE seq WHEN 3 THEN 550000 ELSE 300000 END)), '0', 'é')`);
  beginMigration(database);
  expect(await batch(database)).toMatchObject({ phase: "identities", copiedRows: 1 });
  expect(await batch(database)).toMatchObject({ phase: "identities", copiedRows: 1 });
  expect(await batch(database)).toMatchObject({ phase: "active", copiedRows: 1 });
  expect(await batch(database)).toMatchObject({ phase: "publish", copiedRows: 3 });
  expect(await batch(database)).toMatchObject({ phase: "cleanup", publishedSessions: 1 });
  for (let index = 0; index < 3; index++) {
    expect(await batch(database)).toMatchObject({ phase: "cleanup", deletedRows: 1, done: false });
  }
  expect(await batch(database)).toMatchObject({ phase: "complete", deletedRows: 3, done: true });
  expect(
    database
      .prepare(`SELECT seq, octet_length(parent_id) AS bytes
    FROM transcript_event_identity_rows ORDER BY seq`)
      .all(),
  ).toEqual([
    { seq: 1, bytes: 1_200_000 },
    { seq: 2, bytes: 1_200_000 },
    { seq: 3, bytes: 2_200_000 },
  ]);
});
