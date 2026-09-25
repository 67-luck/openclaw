import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { readSessionSubmittedInput } from "./session-accessor.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
} from "./session-accessor.pending-inputs.js";
import { usePendingInputsFixture } from "./session-accessor.pending-inputs.test-support.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";
describe("accepted input custody", () => {
  const { fixture, sessionId, scope, database, message, stage, promote } =
    usePendingInputsFixture();

  it("paginates retained inputs with stable cursors while another input is promoted", async () => {
    const first = await stage("first");
    const second = await stage("second");
    const third = await stage("third");
    const current = database();
    const storedBefore = current.db
      .prepare("SELECT * FROM session_pending_inputs ORDER BY seq")
      .all();
    const counter = trackSqliteStatementExecutions(current.db, ["pending"], (sqlText) =>
      sqlText.startsWith("select ") && sqlText.includes('from "session_pending_inputs"')
        ? "pending"
        : null,
    );
    try {
      expect(readSessionPendingInput(scope(), first.inputId)).toMatchObject({
        id: first.inputId,
        runId: "first",
        state: "queued",
        message: first.message,
      });
      expect(readSessionPendingInput(scope(), "missing-input")).toBeUndefined();
      expect(
        readSessionPendingInput({ ...scope(), sessionId: "other-session" }, first.inputId),
      ).toBeUndefined();
      expect(counter.counts.pending).toBeLessThanOrEqual(4);
      expect(counter.rowCounts.pending).toBeGreaterThan(0);
      expect(counter.rowCounts.pending).toBeLessThanOrEqual(2);
    } finally {
      counter.restore();
    }
    expect(current.db.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all()).toEqual(
      storedBefore,
    );
    const page = listSessionPendingInputs(scope(), { limit: 2 });
    expect(page.items.map((input) => input.id)).toEqual([second.inputId, third.inputId]);
    expect(page.total).toBe(3);
    expect(page.nextBefore).toBeDefined();
    await promote(third);
    const older = listSessionPendingInputs(scope(), { limit: 2, before: page.nextBefore });
    expect(older.items.map((input) => input.id)).toEqual([first.inputId]);
    for (const idempotencyKey of ["first:user", "third:user"]) {
      expect(
        readSessionSubmittedInput({ ...scope(), sessionId: "other-session" }, idempotencyKey),
      ).toBeUndefined();
      expect(
        readSessionSubmittedInput({ ...scope(), sessionKey: "agent:main:other" }, idempotencyKey),
      ).toBeUndefined();
    }
  });

  it("does not create missing storage for a submitted-input lookup", () => {
    const storePath = path.join(fixture.sessionsDir(), "missing-agent.sqlite");
    expect(readSessionSubmittedInput({ ...scope(), storePath }, "missing:user")).toBeUndefined();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it.each(["pending", "committed"] as const)(
    "rejects malformed or oversized %s source bytes without changing storage",
    async (source) => {
      const receipt = await stage("invalid-source");
      if (source === "committed") {
        await promote(receipt);
      }
      const db = database().db;
      const invalidMessages = [
        "{",
        JSON.stringify({ ...receipt.message, role: "assistant" }),
        JSON.stringify({ ...receipt.message, idempotencyKey: "another:user" }),
        JSON.stringify(message("invalid-source", "💥".repeat(MAX_PAYLOAD_BYTES / 4))),
      ];
      for (const messageJson of invalidMessages) {
        if (source === "pending") {
          db.prepare("UPDATE session_pending_inputs SET message_json = ? WHERE input_id = ?").run(
            messageJson,
            receipt.inputId,
          );
        } else {
          const payload = prepareTranscriptPayload(db, `{"message":${messageJson}}`);
          db.prepare(
            "UPDATE transcript_events SET event_json = ?, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
          ).run(
            payload.event_json,
            payload.event_zstd,
            payload.event_utf8_bytes,
            payload.navigation_json,
            sessionId,
            sessionId,
            receipt.inputId,
          );
        }
        db.exec("PRAGMA query_only = ON");
        try {
          expect(readSessionSubmittedInput(scope(), "invalid-source:user")).toBeUndefined();
        } finally {
          db.exec("PRAGMA query_only = OFF");
        }
      }
    },
  );

  it.each(["dirty", "missing", "lagging"] as const)(
    "does not read or repair a %s transcript identity projection",
    async (projection) => {
      const receipt = await stage("stale-source");
      await promote(receipt);
      const db = database().db;
      if (projection === "missing") {
        db.prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?").run(
          sessionId,
        );
      } else {
        const statement =
          projection === "dirty"
            ? "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?"
            : "UPDATE session_transcript_index_state SET indexed_seq = -1 WHERE session_id = ?";
        db.prepare(statement).run(sessionId);
      }
      const before = db
        .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
        .get(sessionId);
      db.exec("PRAGMA query_only = ON");
      try {
        expect(readSessionSubmittedInput(scope(), "stale-source:user")).toBeUndefined();
      } finally {
        db.exec("PRAGMA query_only = OFF");
      }
      expect(
        db
          .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
          .get(sessionId),
      ).toEqual(before);
    },
  );

  it("bounds materialized pending pages by bytes without truncating input or skipping its cursor", async () => {
    const content = "x".repeat(Math.floor(MAX_PAYLOAD_BYTES / 2));
    const first = await stage("large-first", { message: message("large-first", content) });
    const second = await stage("large-second", { message: message("large-second", content) });
    const page = listSessionPendingInputs(scope());
    expect(page.items.map((input) => input.id)).toEqual([second.inputId]);
    expect(page.items[0]?.message.content === content).toBe(true);
    expect(page.total).toBe(2);
    expect(page.nextBefore).toBeDefined();
    const older = listSessionPendingInputs(scope(), { before: page.nextBefore });
    expect(older.items.map((input) => input.id)).toEqual([first.inputId]);
    expect(older.items[0]?.message.content === content).toBe(true);
    expect(older.nextBefore).toBeUndefined();
  });
});
