import "./doctor-health.test-support.js";
import { expect, it, vi } from "vitest";
import { runDoctorTranscriptStorageBatch } from "../commands/doctor-transcript-storage.test-support.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessageSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

it("normal Doctor resumes a schema-25 metadata ledger before granting startup readiness", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: { workspace: state.workspaceDir } },
      },
      gateway: { mode: "local" as const },
    };
    await state.writeConfig(cfg);
    mocks.config.mockReturnValue(cfg);
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.runContributions.mockResolvedValue(undefined);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:metadata-resume",
      sessionId: "metadata-resume",
      env: state.env,
    };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(
      appendTranscriptMessageSync(scope, {
        eventId: "user",
        message: { role: "user", content: "retained" },
      }),
    ).toMatchObject({ ok: true });
    const pathname = database.path;
    const payloads = database.db
      .prepare("SELECT seq, event_json, event_zstd FROM transcript_events ORDER BY seq")
      .all();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const seed = openNodeSqliteDatabase(pathname);
    try {
      runSqliteImmediateTransactionSync(seed, () => {
        seed.exec(`
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
      expect((await runDoctorTranscriptStorageBatch(seed)).phase).toBe("active");
      expect(seed.prepare("PRAGMA user_version").get()?.user_version).toBe(25);
    } finally {
      seed.close();
    }
    await runDoctorHealthFlow(
      { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      { repair: true, nonInteractive: true, workspaceSuggestions: false },
    );
    using observed = openNodeSqliteDatabase(pathname, { readOnly: true });
    expect(observed.prepare("SELECT phase FROM transcript_storage_migration").get()?.phase).toBe(
      "complete",
    );
    expect(
      observed
        .prepare("SELECT phase FROM transcript_storage_sessions WHERE session_id = ?")
        .get(scope.sessionId)?.phase,
    ).toBe("compact");
    expect(
      observed.prepare("SELECT count(*) AS count FROM transcript_event_identities").get()?.count,
    ).toBe(0);
    expect(
      observed
        .prepare("SELECT seq, event_json, event_zstd FROM transcript_events ORDER BY seq")
        .all(),
    ).toEqual(payloads);
  });
});
