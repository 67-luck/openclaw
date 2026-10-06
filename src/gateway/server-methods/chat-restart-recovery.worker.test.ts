import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import * as entryPatch from "../../config/sessions/session-entry-patch.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { SqliteSessionMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";

async function prepareTerminalTarget(scope: { sessionKey: string; storePath: string }) {
  const read = await readSessionEntriesFromStoreInWorker({
    agentId: "main",
    storePath: scope.storePath,
    sessionKeys: [scope.sessionKey],
    projection: "exact",
  });
  assert(read.source);
  return {
    agentId: "main",
    storePath: scope.storePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    readSource: read.source,
  };
}

it("settles restart-safe chat claims without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      sessionKey: "agent:main:terminal-worker",
      storePath: state.statePath("terminal.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "terminal-session",
      updatedAt: 1_000,
      status: "running",
      restartRecoveryDeliveryRunId: "terminal-run",
      restartRecoveryDeliverySourceRunId: "source-run",
    });
    await appendTranscriptMessage(
      { ...target, sessionId: "terminal-session" },
      { message: { role: "user", content: "Synthetic accepted turn" } },
    );
    const terminalTarget = await prepareTerminalTarget(target);
    invalidateRegisteredAgentDatabasesMemo({ env: state.env });
    const sql = observeHostDataSql();
    try {
      await expect(
        terminalizeRestartSafeChatAdmission({
          target: terminalTarget,
          admittedSessionId: "terminal-session",
          clientRunId: "terminal-run",
          startedAt: 1_000,
          status: "failed",
          error: "Synthetic terminal failure",
          retryable: false,
        }),
      ).resolves.toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      lastRunId: "terminal-run",
      restartRecoveryTerminalRunIds: ["source-run"],
    });
    expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(loadTranscriptEventsSync({ ...target, sessionId: "terminal-session" })).toContainEqual(
      expect.objectContaining({
        customType: "run-failed-before-reply",
        details: expect.objectContaining({ runId: "terminal-run" }),
      }),
    );
  });
});

it.each(["restartRecoveryDeliveryRunId", "restartRecoveryDeliverySourceRunId"] as const)(
  "does not settle a foreign claim changing %s after preparation",
  async (field) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        sessionKey: "agent:main:terminal-foreign-claim",
        storePath: state.statePath("terminal.sqlite"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: "terminal-session",
        updatedAt: 1_000,
        status: "running",
        restartRecoveryDeliveryRunId: "terminal-run",
        restartRecoveryDeliverySourceRunId: "source-run",
      });
      const terminalTarget = await prepareTerminalTarget(target);
      const foreign = new DatabaseSync(target.storePath);
      const patch = entryPatch.patchSessionEntryInWorker;
      const intercepted = vi.fn();
      const spy = vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementation((params) =>
        patch({
          ...params,
          async prepare(snapshot) {
            const prepared = await params.prepare(snapshot);
            foreign
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
              )
              .run(`$.${field}`, "foreign-run", target.sessionKey);
            intercepted();
            return prepared;
          },
        }),
      );
      try {
        await expect(
          terminalizeRestartSafeChatAdmission({
            target: terminalTarget,
            admittedSessionId: "terminal-session",
            clientRunId: "terminal-run",
            startedAt: 1_000,
            status: "killed",
            retryable: false,
          }),
        ).rejects.toBeInstanceOf(SqliteSessionMutationConflictError);
        expect(intercepted).toHaveBeenCalledOnce();
        expect(
          foreign
            .prepare(
              "SELECT status, json_extract(entry_json, ?) AS owner FROM session_nodes WHERE session_key = ?",
            )
            .get(`$.${field}`, target.sessionKey),
        ).toEqual({ status: "running", owner: "foreign-run" });
      } finally {
        spy.mockRestore();
        foreign.close();
      }
    });
  },
);

it("refuses terminal settlement against a replacement store with identical claim rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      sessionKey: "agent:main:terminal-replaced-store",
      storePath: state.statePath("terminal.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "terminal-session",
      updatedAt: 1_000,
      status: "running",
      restartRecoveryDeliveryRunId: "terminal-run",
      restartRecoveryDeliverySourceRunId: "source-run",
    });
    const terminalTarget = await prepareTerminalTarget(target);
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    const originalPath = `${target.storePath}.original`;
    await fs.rename(target.storePath, originalPath);
    await fs.copyFile(originalPath, target.storePath);

    await expect(
      terminalizeRestartSafeChatAdmission({
        target: terminalTarget,
        admittedSessionId: "terminal-session",
        clientRunId: "terminal-run",
        startedAt: 1_000,
        status: "killed",
        retryable: false,
      }),
    ).rejects.toThrow(/identity changed|source changed|database changed/i);
    for (const storePath of [originalPath, target.storePath]) {
      const observer = new DatabaseSync(storePath, { readOnly: true });
      try {
        expect(
          observer
            .prepare(
              `SELECT status, json_extract(entry_json, '$.restartRecoveryDeliveryRunId') AS claim
               FROM session_nodes WHERE session_key = ?`,
            )
            .get(target.sessionKey),
        ).toEqual({ status: "running", claim: "terminal-run" });
      } finally {
        observer.close();
      }
    }
  });
});
