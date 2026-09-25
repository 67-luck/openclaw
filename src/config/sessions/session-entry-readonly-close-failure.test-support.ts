import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import * as agentDatabases from "../../state/openclaw-agent-db.js";
import { retainGatewaySessionBroker } from "../../state/openclaw-agent-execution.js";
import { prepareQualifiedSessionEntryTarget } from "./session-accessor.entry.js";
import * as exactReads from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import * as entryExecution from "./session-entry-execution.js";

// This fixture runs only in the managed child. Failed registry custody has no
// successful teardown to fake; the child owns its real broker and joins it.
it("discloses the original rejected reader close after ordinary release", async () => {
  const broker = retainGatewaySessionBroker();
  const nativeClosed = createDeferred();
  const failureGate = createDeferred();
  const sentinel = new Error("retained reader close failed after native cleanup");
  let prepared: ReturnType<typeof prepareQualifiedSessionEntryTarget> | undefined;
  const absences: ReturnType<typeof exactReads.retainSessionEntryKeyAbsence>[] = [];
  let readerCloseCalls = 0;
  let restoreCapture: (() => void) | undefined;
  let restoreRetain: (() => void) | undefined;
  const hostOpen = vi.spyOn(agentDatabases, "openOpenClawAgentDatabase").mockImplementation(() => {
    throw new Error("Enrolled reader attempted host SQLite");
  });
  try {
    await broker.ready;
    const target = {
      agentId: "main",
      sessionId: "reader-close-failure",
      sessionKey: "agent:main:dashboard:reader-close-failure",
      storePath: agentDatabases.resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: process.env,
      }),
      env: process.env,
    };
    SessionManager.open(target).appendMessage({
      role: "user",
      content: "original",
      timestamp: 1,
    });
    const initial = entryExecution.captureSessionEntryReadExecution(resolveSqliteScope(target));
    if (!initial) {
      throw new Error("Expected the enrolled original reader");
    }
    const read = await (async () => {
      try {
        return initial.read({ kind: "resolve-result" });
      } finally {
        await initial.close();
      }
    })();
    if (!read.found || !read.value.ok || !read.value.value) {
      throw new Error("Expected the original native row");
    }
    const originalCapture = entryExecution.captureSessionEntryReadExecution;
    const capture = vi
      .spyOn(entryExecution, "captureSessionEntryReadExecution")
      .mockImplementationOnce((...args) => {
        const reader = originalCapture(...args);
        if (!reader) {
          throw new Error("Expected the original retained reader");
        }
        return {
          ...reader,
          async close() {
            readerCloseCalls += 1;
            await reader.close();
            nativeClosed.resolve();
            await failureGate.promise;
            throw sentinel;
          },
        };
      });
    restoreCapture = () => capture.mockRestore();
    const originalRetain = exactReads.retainSessionEntryKeyAbsence;
    const retain = vi
      .spyOn(exactReads, "retainSessionEntryKeyAbsence")
      .mockImplementation((params) => {
        const absence = originalRetain(params);
        absences.push(absence);
        return absence;
      });
    restoreRetain = () => retain.mockRestore();
    prepared = prepareQualifiedSessionEntryTarget(
      {
        ...target,
        requestedKey: target.sessionKey,
        canonicalKey: target.sessionKey,
        storeKey: target.sessionKey,
        entry: read.value.value,
        readSource: read.source,
      },
      [read.source],
      target.env,
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(retain).toHaveBeenCalledOnce();
    const [absence] = absences;
    if (!absence) {
      throw new Error("Expected the producer-created absence owner");
    }
    prepared.assertCurrent();
    prepared.release();
    expect(() => prepared!.assertCurrent()).toThrow("no longer active");
    expect(() => absence.assertCurrent()).toThrow("no longer active");

    const ordinaryClose = absence.close();
    const preparedClose = prepared.close();
    expect(absence.close()).toBe(ordinaryClose);
    expect(prepared.close()).toBe(preparedClose);
    let ordinarySettled = false;
    let preparedSettled = false;
    const ordinaryError = ordinaryClose
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        ordinarySettled = true;
      });
    const preparedError = preparedClose
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        preparedSettled = true;
      });
    await Promise.race([nativeClosed.promise, ordinaryClose]);
    expect(readerCloseCalls).toBe(1);
    expect(ordinarySettled).toBe(false);
    expect(preparedSettled).toBe(false);
    failureGate.resolve();
    expect(await ordinaryError).toBe(sentinel);
    const qualificationError = await preparedError;
    expect(qualificationError).toBeInstanceOf(AggregateError);
    if (!(qualificationError instanceof AggregateError)) {
      throw new Error("Expected close aggregate");
    }
    expect(qualificationError.errors).toHaveLength(1);
    expect(qualificationError.errors[0]).toBe(sentinel);
    expect(absence.close()).toBe(ordinaryClose);
    expect(prepared.close()).toBe(preparedClose);

    // Drain starts only after ordinary rejection: a held drain cannot itself
    // keep an incorrectly unregistered failed reader discoverable.
    const closeNative = vi.fn(async () => {});
    const drainageError = await drainAgentDatabaseResources(
      { agentId: target.agentId, path: target.storePath },
      closeNative,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(drainageError).toBeInstanceOf(AggregateError);
    if (!(drainageError instanceof AggregateError)) {
      throw new Error("Expected drainage aggregate");
    }
    expect(drainageError.errors).toHaveLength(1);
    expect(drainageError.errors[0]).toBe(sentinel);
    expect(closeNative).not.toHaveBeenCalled();
    const canonicalError = await closeOpenClawAgentDatabaseByPathAsync(
      target.storePath,
      target.agentId,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(canonicalError).toBeInstanceOf(AggregateError);
    if (!(canonicalError instanceof AggregateError)) {
      throw new Error("Expected canonical aggregate");
    }
    expect(canonicalError.errors).toHaveLength(1);
    expect(canonicalError.errors[0]).toBe(sentinel);
    expect(readerCloseCalls).toBe(1);
    expect(hostOpen).not.toHaveBeenCalled();
    expect(agentDatabases.listOpenIncognitoAgentDatabases()).toEqual([]);
    expect(existsSync(target.storePath)).toBe(false);
  } finally {
    failureGate.resolve();
    restoreRetain?.();
    restoreCapture?.();
    await prepared?.close().catch(() => {});
    try {
      await broker.stop();
    } finally {
      hostOpen.mockRestore();
    }
  }
});
