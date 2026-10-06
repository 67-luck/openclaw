import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import { expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { copySqliteSessionGenerationRows } from "./session-accessor.sqlite-generation-copy.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

it("rejects a streaming copy onto its source before deleting any rows", async () => {
  await withOpenClawTestState({ label: "generation-self-copy" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:copy",
      sessionId: "copy",
    };
    runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventsInTransaction(database, scope, [
          { type: "session", version: 3, id: scope.sessionId },
          {
            type: "message",
            id: "message",
            parentId: null,
            message: { role: "user", content: "Preserve these exact bytes." },
          },
        ]);
        const snapshot = () => ({
          events: database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
          identities: database.db
            .prepare("SELECT * FROM transcript_event_identity_rows ORDER BY event_id")
            .all(),
        });
        const before = snapshot();
        expect(before.events).toHaveLength(2);
        expect(before.identities).toHaveLength(2);
        expect(() =>
          copySqliteSessionGenerationRows({
            destination: database,
            source: database,
            sessionId: scope.sessionId,
            sourceWindowPresent: true,
          }),
        ).toThrow("requires distinct source and destination databases");
        expect(snapshot()).toEqual(before);
      },
      { agentId: scope.agentId, env: scope.env },
    );
  });
});

it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
  "preserves ordinary-zstd canonical bytes through a %s cross-store copy",
  async (encoding) => {
    await withOpenClawTestState({ label: "generation-compressed-copy" }, async (state) => {
      const sourceOptions = { agentId: "main", env: state.env };
      const destinationOptions = { ...sourceOptions, path: state.path("destination.sqlite") };
      const empty = new DatabaseSync(destinationOptions.path);
      empty.exec(
        `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_marker(id INTEGER); DROP TABLE encoding_marker;`,
      );
      empty.close();
      const scope = { ...sourceOptions, sessionKey: "agent:main:copy", sessionId: "copy" };
      const source = openOpenClawAgentDatabase(sourceOptions);
      const event = {
        type: "message",
        id: "message",
        parentId: null,
        message: {
          role: "assistant",
          content: "Preserve café 🦞 and exact canonical spacing. ".repeat(256),
        },
      };
      const eventJson = ` ${JSON.stringify(event)}\n`;
      const bytes = Buffer.from(eventJson);
      const frame = zlib.zstdCompressSync(bytes);
      runOpenClawAgentWriteTransaction((database) => {
        appendTranscriptEventsInTransaction(database, scope, [
          { type: "session", version: 3, id: scope.sessionId },
          event,
        ]);
        database.db
          .prepare(`UPDATE transcript_events SET event_json = NULL, event_zstd = ?,
        event_utf8_bytes = ? WHERE session_id = ? AND seq = 1`)
          .run(frame, bytes.length, scope.sessionId);
      }, sourceOptions);
      runOpenClawAgentWriteTransaction((destination) => {
        appendTranscriptEventsInTransaction(
          destination,
          { ...scope, path: destinationOptions.path },
          [{ type: "session", version: 3, id: scope.sessionId }],
        );
        copySqliteSessionGenerationRows({
          source,
          destination,
          sessionId: scope.sessionId,
          sourceWindowPresent: true,
        });
        expect(readTranscriptEventRows(destination, scope.sessionId)[1]?.eventJson).toBe(eventJson);
        const stored = destination.db
          .prepare(
            "SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? AND seq = 1",
          )
          .get(scope.sessionId);
        expect(stored).toEqual(
          encoding === "UTF-8"
            ? { event_json: null, event_zstd: new Uint8Array(frame) }
            : { event_json: eventJson, event_zstd: null },
        );
      }, destinationOptions);
      expect(readTranscriptEventRows(source, scope.sessionId)[1]?.eventJson).toBe(eventJson);
    });
  },
);
