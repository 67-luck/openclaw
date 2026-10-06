import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as entryPatch from "../config/sessions/session-entry-patch.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { terminalizeRestartSafeChatAdmission } from "./server-methods/chat-restart-recovery.js";

it("joins accepted restart-safe terminal persistence after the real close prelude cancels its caller", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("restart-safe-terminal-close");
  const prepared = createDeferredCore();
  const release = createDeferredCore();
  const settled = createDeferredCore<boolean>();
  const finish = createDeferredCore();
  const joining = createDeferredCore();
  const work = new AsyncWorkScope();
  let job: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let callerSignal: AbortSignal | undefined;
  let observer: DatabaseSync | undefined;
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const target = {
      sessionKey: "agent:main:dashboard:restart-safe-terminal-close",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: fixture.state.env }),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "close-session",
      updatedAt: 1_000,
      status: "running",
      restartRecoveryDeliveryRunId: "close-run",
      restartRecoveryDeliverySourceRunId: "close-run",
    });
    const read = await readSessionEntriesFromStoreInWorker({
      agentId: "main",
      storePath: target.storePath,
      sessionKeys: [target.sessionKey],
      projection: "exact",
    });
    assert(read.source);
    const terminalTarget = {
      agentId: "main",
      storePath: target.storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      readSource: read.source,
    };
    observer = new DatabaseSync(target.storePath, { readOnly: true });
    const patch = entryPatch.patchSessionEntryInWorker;
    vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementation((params) => {
      if (
        params.selection.kind !== "target" ||
        params.selection.target.canonicalKey !== target.sessionKey
      ) {
        return patch(params);
      }
      return patch({
        ...params,
        async prepare(snapshot) {
          const input = await params.prepare(snapshot);
          prepared.resolve();
          await release.promise;
          expect(callerSignal?.aborted).toBe(true);
          return input;
        },
      });
    });
    kernel.scheduler.signal.addEventListener(
      "abort",
      () => work.beginClose(kernel.scheduler.signal.reason),
      { once: true },
    );
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.resolve();
      return stop();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "restart-safe-terminal-settlement",
      delayMs: 0,
      run() {
        job = work.run(async () => {
          callerSignal = getAsyncWorkSignal();
          const result = await terminalizeRestartSafeChatAdmission({
            target: terminalTarget,
            admittedSessionId: "close-session",
            clientRunId: "close-run",
            startedAt: 1_000,
            status: "killed",
            retryable: false,
          });
          settled.resolve(result);
          await finish.promise;
        });
        return job;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    assert(job);
    await withinTest(
      awaitGateBeforeSettlement(prepared.promise, job, "Terminal persistence skipped preparation"),
      signal,
    );
    closing = server.close({ reason: "restart-safe terminal close proof" });
    await withinTest(
      awaitGateBeforeSettlement(joining.promise, closing, "Gateway skipped scheduler settlement"),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    const late = vi.fn();
    await kernel.scheduler.schedule({ id: "late-terminal-work", delayMs: 0, run: late }).stop();
    expect(late).not.toHaveBeenCalled();
    sql = observeHostDataSql();
    release.resolve();
    expect(
      await withinTest(
        awaitGateBeforeSettlement(
          settled.promise,
          job,
          "Accepted terminal persistence did not settle",
        ),
        signal,
      ),
    ).toBe(true);
    expect(sql.queries).toEqual([]);
    sql.restore();
    sql = undefined;
    expect(
      observer
        .prepare(
          `SELECT status, json_extract(entry_json, '$.lastRunId') AS lastRunId,
            json_extract(entry_json, '$.restartRecoveryDeliveryRunId') AS claim
           FROM session_nodes WHERE session_key = ?`,
        )
        .get(target.sessionKey),
    ).toEqual({ status: "killed", lastRunId: "close-run", claim: null });
    observer.close();
    observer = undefined;
    finish.resolve();
    await withinTest(closing, signal);
  } finally {
    work.beginClose();
    vi.useRealTimers();
    release.resolve();
    finish.resolve();
    sql?.restore();
    observer?.close();
    await Promise.allSettled([job, closing]);
    await work.drain();
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
