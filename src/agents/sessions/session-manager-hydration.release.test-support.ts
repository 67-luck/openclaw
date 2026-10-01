import { createHash } from "node:crypto";
import fs from "node:fs";
import { createTranscriptIndexAppenderInTransaction } from "../../config/sessions/session-transcript-index.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { SessionHeader, SessionMessageEntry } from "./session-manager-types.js";

// Source-equivalent agent transcript, not an executed release or shared-state migration.
// DDL and identity payload contract: v2026.9.7, c074824a27c96d3983043f9eeb33823cd1772d8c.
// transcript-payload.ts SHA256: 70997c1966b81fc7e15b18e18fc66d54b045a80ce67d20a3469c9fac0c82cde5.
// The index, projection-append and FTS producers are byte-identical to that release.
export function seedReleasedAgentTranscript(databasePath: string) {
  const ddl = fs.readFileSync(
    new URL("../../test/fixtures/sqlite/openclaw-agent-schema-2026.9.7.sql", import.meta.url),
    "utf8",
  );
  if (
    createHash("sha256").update(ddl).digest("hex") !==
    "9d51b513d2f69abfd800e845d8f7baa21c69f274c8b356cb4d8391c6547df08d"
  ) {
    throw new Error("Released agent schema fixture changed");
  }
  const target = {
    agentId: "main",
    sessionId: "released-agent-transcript",
    sessionKey: "agent:main:released-agent-transcript",
    storePath: databasePath,
  };
  const timestamp = "2026-09-30T00:00:00.000Z";
  const header: SessionHeader = {
    type: "session",
    version: 4,
    id: target.sessionId,
    cwd: "/fixture",
    timestamp,
  };
  const entries: SessionMessageEntry[] = [
    {
      type: "message",
      id: "released-user",
      parentId: null,
      timestamp,
      message: { role: "user", content: "released input", timestamp: 1 },
    },
    {
      type: "message",
      id: "released-assistant",
      parentId: "released-user",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "released-call", name: "read", arguments: {} }],
        api: "openai-responses",
        provider: "openai",
        model: "synthetic",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "released-result",
      parentId: "released-assistant",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "released-call",
        toolName: "read",
        content: [{ type: "text", text: "released result" }],
        isError: false,
        timestamp: 3,
      },
    },
  ];
  const events = [header, ...entries];
  // The released encoder stores sub-1024-byte UTF-8 events as identity TEXT with no navigation.
  const raw = events.map((event) => JSON.stringify(event));
  if (raw.some((value) => Buffer.byteLength(value, "utf8") >= 1024)) {
    throw new Error("Released identity payload fixture exceeds its producer branch");
  }
  const db = openNodeSqliteDatabase(databasePath);
  try {
    db.exec(ddl);
    db.exec("PRAGMA user_version = 24");
    db.prepare(`INSERT INTO schema_meta
      (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 24, 'main', '2026.9.7', 1, 1)`).run();
    db.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)`).run(
      target.sessionKey,
      target.sessionId,
      JSON.stringify({ sessionId: target.sessionId, updatedAt: 1 }),
    );
    db.prepare(`INSERT INTO session_windows
      (session_id, session_key, created_at, updated_at, transcript_updated_at)
      VALUES (?, ?, 1, 1, 1)`).run(target.sessionId, target.sessionKey);
    db.prepare(`INSERT INTO transcript_rewrite_watermarks
      (session_id, generation, updated_at) VALUES (?, 'released-generation', 1)`).run(
      target.sessionId,
    );
    db.prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?").run(
      target.sessionKey,
    );
    const insert = db.prepare(`INSERT INTO transcript_events
      (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json)
      VALUES (?, ?, ?, 1, NULL, ?, NULL)`);
    const identity = db.prepare(`INSERT INTO transcript_event_identities
      (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 1)`);
    db.exec("BEGIN");
    const appendIndex = createTranscriptIndexAppenderInTransaction(db, target.sessionId);
    for (const [seq, event] of events.entries()) {
      const json = raw[seq]!;
      insert.run(target.sessionId, seq, json, Buffer.byteLength(json, "utf8"));
      identity.run(
        target.sessionId,
        event.id,
        seq,
        event.type,
        "parentId" in event ? event.parentId : null,
      );
      if (appendIndex({ seq, event, eventId: event.id, createdAt: 1 })) {
        throw new Error("Released transcript fixture did not forward-index its active branch");
      }
    }
    db.exec("COMMIT");
  } finally {
    try {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    } finally {
      db.close();
    }
  }
  return { target, header, entries, raw };
}

export function readReleasedAgentTranscriptRows(databasePath: string, sessionId: string) {
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return {
      events: db
        .prepare(`SELECT seq, event_json, hex(CAST(event_json AS BLOB)) AS bytes,
        event_zstd, event_utf8_bytes, navigation_json FROM transcript_events
        WHERE session_id = ? ORDER BY seq`)
        .all(sessionId),
      identities: db
        .prepare(`SELECT event_id, seq, event_type, parent_id, message_idempotency_key
        FROM transcript_event_identities WHERE session_id = ? ORDER BY seq`)
        .all(sessionId),
      generation: db
        .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
        .get(sessionId),
      projection: db
        .prepare(`SELECT indexed_seq, leaf_event_id, active_event_count, active_message_count,
        needs_rebuild FROM session_transcript_index_state WHERE session_id = ?`)
        .get(sessionId),
      active: db
        .prepare(`SELECT event_seq, active_position, message_position, context_eligible
        FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position`)
        .all(sessionId),
      search: db
        .prepare(`SELECT message_id, role, text FROM session_transcript_fts
        WHERE session_id = ? ORDER BY rowid`)
        .all(sessionId),
    };
  } finally {
    db.close();
  }
}
