import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import nodePath, { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getEnvironmentData, setEnvironmentData, type Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { createCommandFixture } from "../../../test/helpers/command-fixture.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindSqliteWorkerBackend } from "../../agents/sessions/session-manager-metadata.worker.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  invalidateRegisteredAgentDatabasesMemo,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "../../state/openclaw-agent-db-registry-listing.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as agentDatabases from "../../state/openclaw-agent-db.js";
import { retainGatewaySessionBroker } from "../../state/openclaw-agent-execution.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareQualifiedSessionEntryTarget } from "./session-accessor.entry.js";
import * as entryReads from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  loadSessionEntryReadOnlyInScope,
  loadSessionEntryReadOnlyResultInScope,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { resolveSessionEntry } from "./session-accessor.sqlite-exact-read.js";
import * as exactReads from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { assertSessionEntryCurrentAdmission } from "./session-entry-current-admission.js";
import { captureSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import type { SessionEntryCurrentCheck } from "./session-entry-current.types.js";
import * as entryExecution from "./session-entry-execution.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { readSessionStoreTargetResult } from "./session-store-target-inventory.js";
import * as transcriptExecution from "./session-transcript-execution.js";
import { historyLane } from "./session-transcript-worker-resources.js";

const nativeRowFault = vi.hoisted(() => new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
const nativeRowFaultKey = "openclaw.test.entryReadRowFault";
vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { getEnvironmentData } from "node:worker_threads";
    const control = new Int32Array(getEnvironmentData("openclaw.test.entryReadRowFault"));
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql, ...rest) {
      const statement = prepare.call(this, sql, ...rest);
      if (sql.startsWith('select ') &&
          sql.endsWith(' from "session_nodes" where "session_key" = ?')) {
        const get = statement.get;
        statement.get = function(...args) {
          if (args.includes("agent:main:dashboard:incognito-read") &&
              Atomics.compareExchange(control, 0, 1, 0) === 1) {
            Atomics.add(control, 1, 1);
            throw new Error("native actor selected row failed");
          }
          return get.apply(this, args);
        };
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      if (
        process.versions.bun ||
        !options?.workerData?.carrierUrl ||
        getEnvironmentData(nativeRowFaultKey) !== nativeRowFault
      ) {
        return actual.createCpuTrackedWorker(filename, options);
      }
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        workerData: {
          ...options.workerData,
          execArgv: [
            ...options.workerData.execArgv,
            "--import",
            `data:text/javascript,${encodeURIComponent(preload)}`,
          ],
        },
      });
    },
  };
});

it.each(["row", "unencodable"] as const)(
  "encodes only canonical native entry row failures (%s)",
  async (kind) => {
    await withOpenClawTestState({ label: "readonly-native-result" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:result",
        env,
      };
      writeSessionEntry(database, scope.sessionKey, { sessionId: "result", updatedAt: 1 });
      const context = captureOpenClawStateWorkerContext({ env });
      const backend = bindSqliteWorkerBackend(undefined, {
        databasePath: database.path,
        database: database.db,
        admit() {
          throw new Error("Readonly entry attempted a write");
        },
      });
      const failure = kind === "row" ? new Error("selected row failed") : { unavailable: true };
      const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation(() => {
        // oxlint-disable-next-line typescript/only-throw-error -- The native row encoder must preserve raw, unencodable read failures.
        throw failure;
      });
      const execute = (expected?: { identity: string }) =>
        runWithSqliteWorkerStateContext(context, () =>
          backend.execute({
            type: "session.metadata.entryRead",
            input: {
              scope: resolveSqliteScope(scope),
              query: { kind: "resolve-result" },
              expected,
            },
          }),
        );
      try {
        expect(() => execute({ identity: "different-original-owner" })).toThrow(
          "Captured session database changed before read",
        );
        expect(read).not.toHaveBeenCalled();
        if (kind === "row") {
          expect(execute()).toMatchObject({
            ok: true,
            value: {
              result: {
                kind: "resolve-result",
                value: {
                  ok: false,
                  error: {
                    version: 1,
                    root: 0,
                    nodes: [{ name: "Error", message: "selected row failed" }],
                  },
                },
              },
            },
          });
          expect(database.db.isTransaction).toBe(false);
          expect(database.db.isOpen).toBe(true);
        } else {
          let thrown: unknown;
          try {
            execute();
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBe(failure);
        }
      } finally {
        read.mockRestore();
        await backend.close();
      }
    });
  },
);

async function withEnrolledEntryReader(
  kind: "hit" | "missing",
  run: (
    target: Parameters<typeof withSessionEntryReadOnlyInWorker>[0] & {
      agentId: string;
      sessionId: string;
      storePath: string;
    },
    retire: () => Promise<void>,
  ) => Promise<void>,
) {
  const previous = getEnvironmentData(nativeRowFaultKey);
  new Int32Array(nativeRowFault).fill(0);
  setEnvironmentData(nativeRowFaultKey, nativeRowFault);
  try {
    await withOpenClawTestState({ label: "readonly-actor-result" }, async ({ env }) => {
      const broker = retainGatewaySessionBroker();
      let stop: Promise<void> | undefined;
      const retire = () => (stop ??= broker.stop());
      try {
        await broker.ready;
        const target = {
          agentId: "main",
          sessionId: "actor-read",
          sessionKey: "agent:main:dashboard:incognito-read",
          storePath: agentDatabases.resolveIncognitoOpenClawAgentSqlitePath({
            agentId: "main",
            env,
          }),
          env,
        };
        const hostOpen = vi
          .spyOn(agentDatabases, "openOpenClawAgentDatabase")
          .mockImplementation(() => {
            throw new Error("Enrolled reader attempted host SQLite");
          });
        try {
          if (kind === "hit") {
            SessionManager.open(target).appendMessage({
              role: "user",
              content: "original",
              timestamp: 1,
            });
          }
          await run(target, retire);
          expect(hostOpen).not.toHaveBeenCalled();
          expect(agentDatabases.listOpenIncognitoAgentDatabases()).toEqual([]);
          expect(existsSync(target.storePath)).toBe(false);
        } finally {
          hostOpen.mockRestore();
        }
      } finally {
        await retire();
      }
    });
  } finally {
    setEnvironmentData(nativeRowFaultKey, previous);
  }
}

it("qualifies fresh borrowed sources from one volatile owner without replacing its authority", async () => {
  await withEnrolledEntryReader("hit", async (target, retire) => {
    const capture = async () => {
      const reader = entryExecution.captureSessionEntryReadExecution(resolveSqliteScope(target));
      if (!reader) {
        throw new Error("Expected the enrolled original reader");
      }
      try {
        const read = reader.read({ kind: "resolve-result" });
        if (!read.found || !read.value.ok || !read.value.value) {
          throw new Error("Expected the original native row");
        }
        return { source: read.source, entry: read.value.value };
      } finally {
        await reader.close();
      }
    };
    const a = await capture();
    const b = await capture();
    const ownerA = entryExecution.retainWorkerSessionEntrySource(a.source);
    const ownerB = entryExecution.retainWorkerSessionEntrySource(b.source);
    expect(a.source).toMatchObject({
      agentId: b.source.agentId,
      path: b.source.path,
      databaseIdentity: b.source.databaseIdentity,
      databaseBirthtime: b.source.databaseBirthtime,
    });
    expect(ownerA.incarnation).toBe(ownerB.incarnation);
    expect(ownerA.execution.incarnation).toBe(ownerB.execution.incarnation);
    expect(ownerA.execution).not.toBe(ownerB.execution);
    expect(ownerA.execution.borrow).not.toBe(ownerB.execution.borrow);
    const originalRetain = exactReads.retainSessionEntryKeyAbsence;
    const released = vi.fn();
    const retain = vi
      .spyOn(exactReads, "retainSessionEntryKeyAbsence")
      .mockImplementation((params) => {
        const source = originalRetain(params);
        return {
          ...source,
          release() {
            released(params.source);
            source.release();
          },
        };
      });
    const prepared: ReturnType<typeof prepareQualifiedSessionEntryTarget>[] = [];
    const prepare = (selected = a, fresh = b) => {
      const result = prepareQualifiedSessionEntryTarget(
        {
          ...target,
          requestedKey: target.sessionKey,
          canonicalKey: target.sessionKey,
          storeKey: target.sessionKey,
          entry: selected.entry,
          readSource: selected.source,
        },
        [fresh.source],
        target.env,
      );
      prepared.push(result);
      return result;
    };
    const closeEntered = createDeferred();
    const closeGate = createDeferred();
    let drain: Promise<void> | undefined;
    let replacement: ReturnType<typeof retainGatewaySessionBroker> | undefined;
    let restoreClose: (() => void) | undefined;
    try {
      const first = prepare();
      expect(first.target.readSource).toBe(a.source);
      first.assertCurrent();
      expect(retain).toHaveBeenCalledTimes(1);
      expect(retain.mock.calls[0]![0].source).toBe(a.source);
      first.release();
      expect(() => first.assertCurrent()).toThrow("no longer active");
      expect(released).toHaveBeenCalledExactlyOnceWith(a.source);
      // No await here: ordinary release must not fence a second healthy projection.
      const second = prepare();
      second.assertCurrent();
      second.release();
      await Promise.all([first.close(), second.close()]);

      const original = prepare();
      const originalCapture = entryExecution.captureSessionEntryReadExecution;
      const holdClose = vi
        .spyOn(entryExecution, "captureSessionEntryReadExecution")
        .mockImplementationOnce((...args) => {
          const reader = originalCapture(...args);
          if (!reader) {
            return reader;
          }
          return {
            ...reader,
            async close() {
              closeEntered.resolve();
              await closeGate.promise;
              await reader.close();
            },
          };
        });
      restoreClose = () => holdClose.mockRestore();
      const held = prepare();
      held.release();
      const nativeClose = vi.fn(async () => {});
      drain = drainAgentDatabaseResources(
        { agentId: target.agentId, path: target.storePath },
        nativeClose,
      );
      await closeEntered.promise;
      expect(nativeClose).not.toHaveBeenCalled();
      expect(() => held.assertCurrent()).toThrow("no longer active");
      expect(() => original.assertCurrent()).toThrow();
      closeGate.resolve();
      await Promise.all([original.close(), held.close(), drain]);
      expect(nativeClose).toHaveBeenCalledOnce();
      holdClose.mockRestore();
      restoreClose = undefined;

      const retired = retire();
      await retired;
      replacement = retainGatewaySessionBroker();
      await replacement.ready;
      SessionManager.open(target).appendMessage({
        role: "user",
        content: "replacement",
        timestamp: 2,
      });
      expect(() => prepare()).toThrow();
      const fresh = await capture();
      expect(
        entryExecution.retainWorkerSessionEntrySource(fresh.source).execution.incarnation,
      ).not.toBe(ownerA.execution.incarnation);
      prepare(fresh, fresh).assertCurrent();
    } finally {
      closeGate.resolve();
      restoreClose?.();
      retain.mockRestore();
      try {
        await Promise.all(prepared.map((source) => source.close()));
        await drain;
      } finally {
        await replacement?.stop();
        await retire();
      }
    }
  });
});

it("retains a rejected reader close for later canonical drainage", async (context) => {
  const command = createCommandFixture(context, "tree");
  const root = command.createTempDir("readonly-close-failure-");
  const repoRoot = nodePath.resolve(import.meta.dirname, "../../..");
  const childFixture = nodePath
    .relative(
      repoRoot,
      fileURLToPath(
        new URL("./session-entry-readonly-close-failure.test-support.ts", import.meta.url),
      ),
    )
    .split(nodePath.sep)
    .join("/");
  const configPath = nodePath.join(root, "vitest.config.mts");
  const reportPath = nodePath.join(root, "report.json");
  try {
    // Failed custody intentionally survives in the child until process exit.
    // The parent joins that process before removing its isolated state and report.
    await writeFile(
      configPath,
      `import { sharedVitestConfig } from ${JSON.stringify(nodePath.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default {
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: [${JSON.stringify(childFixture)}],
    setupFiles: [],
    runner: undefined,
    isolate: true,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    passWithNoTests: false,
  },
};
`,
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("VITEST") ||
        key.startsWith("OPENCLAW_VITEST") ||
        key === "GITHUB_ACTIONS"
      ) {
        delete env[key];
      }
    }
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_TEST_HOME: root,
      OPENCLAW_STATE_DIR: nodePath.join(root, "state"),
      OPENCLAW_CONFIG_PATH: nodePath.join(root, "openclaw.json"),
      XDG_CONFIG_HOME: nodePath.join(root, ".config"),
      XDG_DATA_HOME: nodePath.join(root, ".local", "share"),
      XDG_STATE_HOME: nodePath.join(root, ".local", "state"),
      XDG_CACHE_HOME: nodePath.join(root, ".cache"),
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: nodePath.join(root, "modules"),
      NO_COLOR: "1",
    });
    delete env.OPENCLAW_AGENT_DIR;
    delete env.PI_CODING_AGENT_DIR;
    const result = await command.run(
      resolveTestNodeExecPath(),
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        configPath,
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
      ],
      { cwd: repoRoot, env },
    );
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as JsonTestResults;
    expect(report.numTotalTests).toBe(1);
    expect(report.numPassedTests).toBe(1);
    expect(report.numFailedTests).toBe(0);
    expect(report.testResults).toHaveLength(1);
    expect(report.testResults[0]?.status).toBe("passed");
  } finally {
    await command.lifetime.cleanup();
  }
});

it.each(["hit", "missing"] as const)(
  "retains an enrolled existing-only entry reader through consumption (%s)",
  async (kind) => {
    await withEnrolledEntryReader(kind, async (target) => {
      const source = vi.fn();
      const result = loadSessionEntryReadOnlyResultInScope(target, undefined, source);
      expect(result).toMatchObject(
        kind === "hit"
          ? { ok: true, value: { sessionId: target.sessionId } }
          : { ok: true, value: undefined },
      );
      expect(source).toHaveBeenCalledTimes(kind === "hit" ? 1 : 0);
      if (kind === "hit" && !process.versions.bun) {
        // Node's real data-carrier preload faults only the selected native row, not its reply.
        Atomics.store(new Int32Array(nativeRowFault), 0, 1);
        const failed = loadSessionEntryReadOnlyResultInScope(target);
        expect(failed.ok).toBe(false);
        if (failed.ok) {
          throw new Error("Expected the native selected-row failure");
        }
        expect(failed.error).toBeInstanceOf(Error);
        expect(failed.error).toMatchObject({ message: "native actor selected row failed" });
        expect(Atomics.load(new Int32Array(nativeRowFault), 1)).toBe(1);
        await expect(
          withSessionEntryReadOnlyInWorker(
            target,
            () => {},
            async (read) => {
              expect(read).toEqual(result);
            },
          ),
        ).resolves.toBeUndefined();
      }
      expect(() =>
        resolveSessionEntry(target, {
          readOnly: true,
          onReadError(error) {
            throw error;
          },
        }),
      ).toThrow("cannot cross actor execution");
      if (kind === "hit") {
        const refusal = new Error("source callback refused");
        expect(() =>
          loadSessionEntryReadOnlyResultInScope(target, undefined, () => {
            throw refusal;
          }),
        ).toThrow(refusal);
      }
      const held = entryExecution.captureSessionEntryReadExecution(resolveSqliteScope(target));
      if (!held) {
        throw new Error("Expected the enrolled entry reader");
      }
      try {
        expect(held.read({ kind: "resolve-result" }).found).toBe(kind === "hit");
      } finally {
        await held.close();
      }
      expect(() => held.assertCurrent()).not.toThrow();
      expect(() => held.read({ kind: "resolve-result" })).toThrow("reader is closed");
      await expect(
        withSessionEntryReadOnlyInWorker(
          target,
          () => {},
          async (read, owner) => {
            expect(owner.kind).toBe("native");
            owner.assertCurrent();
            await Promise.resolve();
            owner.assertCurrent();
            return read;
          },
        ),
      ).resolves.toEqual(result);
      const failure = new Error("consumer failed");
      await expect(
        withSessionEntryReadOnlyInWorker(
          target,
          () => {},
          async () => {
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      const original = transcriptExecution.retainSessionDatabaseRead;
      const transport = vi
        .spyOn(transcriptExecution, "retainSessionDatabaseRead")
        .mockImplementation((...args) => {
          const retained = original(...args);
          return {
            ...retained,
            executeReady() {
              throw failure;
            },
          };
        });
      const consume = vi.fn(async () => undefined);
      try {
        await expect(withSessionEntryReadOnlyInWorker(target, () => {}, consume)).rejects.toBe(
          failure,
        );
        expect(consume).not.toHaveBeenCalled();
      } finally {
        transport.mockRestore();
      }
    });
  },
);

it.each([
  ["hit", "consume"],
  ["missing", "consume"],
  ["hit", "cleanup"],
  ["missing", "cleanup"],
] as const)(
  "refuses enrolled entry disclosure after original-owner revocation (%s during %s)",
  async (kind, phase) => {
    await withEnrolledEntryReader(kind, async (target, retire) => {
      let consumed = false;
      let closed = false;
      const original = entryExecution.captureSessionEntryReadExecution;
      const capture = vi
        .spyOn(entryExecution, "captureSessionEntryReadExecution")
        .mockImplementation((...args) => {
          const reader = original(...args);
          if (!reader) {
            return reader;
          }
          return {
            ...reader,
            async close() {
              await reader.close();
              closed = true;
              if (phase === "cleanup") {
                await retire();
              }
            },
          };
        });
      try {
        await expect(
          withSessionEntryReadOnlyInWorker(
            target,
            () => {},
            async (read) => {
              expect(read).toMatchObject(
                kind === "hit"
                  ? { ok: true, value: { sessionId: target.sessionId } }
                  : { ok: true, value: undefined },
              );
              consumed = true;
              await Promise.resolve();
              if (phase === "consume") {
                void retire();
              }
              return read;
            },
          ),
        ).rejects.toThrow();
        expect(consumed).toBe(true);
        expect(closed).toBe(true);
      } finally {
        capture.mockRestore();
        await retire();
      }
    });
  },
);

it.each([false, true])(
  "returns unreadable-store data only after its connection closes (close failure: %s)",
  async (failClose) => {
    await withOpenClawTestState({ label: "readonly-entry-open-failure" }, async ({ env, path }) => {
      const storePath = path("unreadable.sqlite");
      writeFileSync(storePath, "Not a SQLite database");
      const closeError = Object.assign(new Error("native read close failed"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 26,
      });
      const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
      let reader: DatabaseSync | undefined;
      let restoreClose: (() => void) | undefined;
      const open = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((location, options) => {
          const database = nativeOpen(location, options);
          if (location === storePath) {
            reader = database;
            if (failClose) {
              const close = vi.spyOn(database, "close").mockImplementation(() => {
                throw closeError;
              });
              restoreClose = () => close.mockRestore();
            }
          }
          return database;
        });
      const read = () =>
        loadSessionEntryReadOnlyResultInScope({
          agentId: "main",
          databaseAgentId: "main",
          storePath,
          sessionKey: "agent:main:unreadable",
          env,
        });
      try {
        if (failClose) {
          expect(read).toThrow(closeError);
        } else {
          expect(read()).toMatchObject({
            ok: false,
            error: { code: "ERR_SQLITE_ERROR", errcode: 26 },
          });
          expect(reader?.isOpen).toBe(false);
        }
      } finally {
        restoreClose?.();
        open.mockRestore();
        if (reader?.isOpen) {
          reader.close();
        }
      }
    });
  },
);

it.each([false, true])(
  "keeps schema error classification with a disposable reader: %s",
  async (disposable) => {
    await withOpenClawTestState({ label: "readonly-entry-schema-error" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:schema-error";
      writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
      database.db.exec("DROP TABLE board_widgets");
      if (disposable) {
        await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
      }
      const failure = Object.assign(new Error("native selected-row query failed"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 1,
      });
      let reader: typeof database.db | undefined;
      const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation((source) => {
        reader = source.db;
        throw failure;
      });
      try {
        const result = loadSessionEntryReadOnlyResultInScope({
          agentId: "main",
          databaseAgentId: "main",
          storePath: database.path,
          sessionKey,
          env,
        });
        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("Expected a selected-row failure");
        }
        expect(result.error).toBeInstanceOf(SessionMetadataUnavailableError);
        expect(result.error).toMatchObject({
          reason: "table-missing",
          missingTables: ["board_widgets"],
        });
        expect(reader?.isOpen).toBe(!disposable);
      } finally {
        read.mockRestore();
      }
    });
  },
);

it("returns row data failures only after the native snapshot rolled back", async () => {
  await withOpenClawTestState({ label: "readonly-entry-error" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:entry-error";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const scope = {
      agentId: "main",
      databaseAgentId: "main",
      storePath: database.path,
      sessionKey,
      env,
    };
    loadSessionEntryReadOnlyInScope(scope);
    const continuation = captureCanonicalSessionReaderContinuation(database);
    if (!continuation) {
      throw new Error("Expected the committed reader admission");
    }
    const failure = new Error("selected row could not be decoded");
    const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation(() => {
      throw failure;
    });
    try {
      const result = loadSessionEntryReadOnlyResultInScope(scope, continuation.receipt);
      expect(result).toEqual({ ok: false, error: failure });
      expect(database.db.isTransaction).toBe(false);
      expect(database.db.isOpen).toBe(true);
    } finally {
      read.mockRestore();
      continuation.release();
    }
  });
});

it("does not downgrade a failed rollback to an ordinary row failure", async () => {
  await withOpenClawTestState({ label: "readonly-entry-rollback" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:rollback-error";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const scope = {
      agentId: "main",
      databaseAgentId: "main",
      storePath: database.path,
      sessionKey,
      env,
    };
    loadSessionEntryReadOnlyInScope(scope);
    const continuation = captureCanonicalSessionReaderContinuation(database);
    if (!continuation) {
      throw new Error("Expected the committed reader admission");
    }
    const exec = database.db.exec.bind(database.db);
    const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation(() => {
      throw new Error("selected row failed");
    });
    const rollback = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") {
        throw new Error("native rollback failed");
      }
      return exec(sql);
    });
    try {
      expect(() => loadSessionEntryReadOnlyResultInScope(scope, continuation.receipt)).toThrow();
      expect(database.db.isOpen).toBe(false);
    } finally {
      rollback.mockRestore();
      read.mockRestore();
      continuation.release();
    }
  });
});

it("keeps source refusal outside the ordinary row-error result", async () => {
  await withOpenClawTestState({ label: "readonly-entry-source" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:source-error";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const refusal = Object.assign(new Error("retained source changed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 26,
    });
    expect(() =>
      loadSessionEntryReadOnlyResultInScope(
        {
          agentId: "main",
          databaseAgentId: "main",
          storePath: database.path,
          sessionKey,
          env,
        },
        undefined,
        () => {
          throw refusal;
        },
      ),
    ).toThrow(refusal);
  });
});

it("propagates raw worker failure without calling the optional-data consumer", async () => {
  await withOpenClawTestState({ label: "readonly-entry-transport" }, async ({ env, path }) => {
    const failure = new Error("worker could not start");
    const run = vi.spyOn(historyLane.pool, "run").mockRejectedValueOnce(failure);
    const consume = vi.fn(async () => undefined);
    try {
      await expect(
        withSessionEntryReadOnlyInWorker(
          {
            agentId: "main",
            sessionKey: "agent:main:missing",
            storePath: path("missing.sqlite"),
            env,
          },
          () => {},
          consume,
        ),
      ).rejects.toBe(failure);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
});

it("rejects registry revocation during the retained asynchronous consumer", async () => {
  await withOpenClawTestState({ label: "readonly-entry-retained" }, async ({ env, path }) => {
    const storePath = path("shared.sqlite");
    const sessionKey = "agent:main:retained";
    replaceSessionEntrySync(
      { agentId: "main", storePath, env, sessionKey },
      {
        sessionId: "retained-session",
        updatedAt: 1,
        skillsSnapshot: { prompt: "Full stored prompt", skills: [] },
      },
    );
    let consumed = false;
    await expect(
      withSessionEntryReadOnlyInWorker(
        {
          sessionKey,
          storePath,
          env,
          hydrateSkillPromptRefs: false,
        },
        () => {},
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          expect(read.value?.skillsSnapshot?.prompt).toBe("Full stored prompt");
          consumed = true;
          await Promise.resolve();
          invalidateRegisteredAgentDatabasesMemo({ env });
          return read.value;
        },
      ),
    ).rejects.toThrow("registry changed");
    expect(consumed).toBe(true);
  });
});

it("retains the registry witness even when the first read rejects before returning a snapshot", async () => {
  await withOpenClawTestState({ label: "readonly-registry-witness" }, async ({ env }) => {
    const prepared = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
    const pending = prepared.read();
    invalidateRegisteredAgentDatabasesMemo({ env });
    await expect(pending).rejects.toThrow("registry changed");
    expect(() => prepared.assertCurrent()).toThrow("registry changed");
  });
});

it("checks the captured registry after logical data cleanup", async () => {
  await withOpenClawTestState({ label: "readonly-entry-cleanup" }, async ({ env, path }) => {
    const storePath = path("shared.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
    const sessionKey = "agent:main:cron:job:run:cleanup";
    writeSessionEntry(database, sessionKey, { sessionId: "cleanup-session", updatedAt: 1 });
    const pool = historyLane.pool;
    const rotate = pool.rotate.bind(pool);
    const closeResources = pool.closeResources.bind(pool);
    let cleanupCalled = false;
    const cleanup = process.versions.bun
      ? vi.spyOn(pool, "rotate").mockImplementation(async () => {
          await rotate();
          cleanupCalled = true;
          invalidateRegisteredAgentDatabasesMemo({ env });
        })
      : vi.spyOn(pool, "closeResources").mockImplementation(async (key) => {
          await closeResources(key);
          cleanupCalled = true;
          invalidateRegisteredAgentDatabasesMemo({ env });
        });
    let consumed = false;
    try {
      const pending = withSessionEntryReadOnlyInWorker(
        { sessionKey, storePath, env },
        () => {},
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          consumed = true;
          return read.value;
        },
      );
      await expect(pending).rejects.toThrow("registry changed");
      expect(cleanupCalled).toBe(true);
      expect(consumed).toBe(true);
    } finally {
      cleanup.mockRestore();
    }
  });
});

it("returns unavailable registry facts as locator data without catching candidate escape", async () => {
  await withOpenClawTestState({ label: "readonly-target-result" }, async ({ env, path }) => {
    const request = {
      agentId: "main",
      storePath: path("shared.sqlite"),
      env,
      candidates: [],
      registeredDatabases: { status: "unavailable" as const },
    };
    expect(readSessionStoreTargetResult(request)).toMatchObject({ ok: false });
    expect(() => readSessionStoreTargetResult({ ...request, registeredDatabases: [] })).toThrow(
      "outside captured discovery custody",
    );
  });
});

it.runIf(process.platform !== "win32").each([
  { retarget: false, logicalAgentId: "main" },
  { retarget: true, logicalAgentId: "main" },
  { retarget: false, logicalAgentId: "ops" },
])(
  "retains logical $logicalAgentId through its alias consumer (retargeted: $retarget)",
  async ({ retarget, logicalAgentId }) => {
    await withOpenClawTestState({ label: "readonly-store-alias" }, async ({ env, path }) => {
      const original = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = `agent:${logicalAgentId}:alias`;
      writeSessionEntry(original, sessionKey, { sessionId: "original", updatedAt: 1 });
      if (logicalAgentId !== "main") {
        writeSessionEntry(original, "agent:main:alias", { sessionId: "other-agent", updatedAt: 1 });
      }
      const replacement = retarget
        ? openOpenClawAgentDatabase({ agentId: "main", path: path("replacement.sqlite"), env })
        : undefined;
      const alias = path("custom.sqlite");
      symlinkSync(original.path, alias);
      let consumed = false;
      const pending = withSessionEntryReadOnlyInWorker(
        {
          agentId: logicalAgentId,
          sessionKey,
          storePath: logicalAgentId === "main" ? path("custom.json") : alias,
          env,
        },
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          expect(read.value?.sessionId).toBe("original");
          expect(owner.scope).toMatchObject({
            agentId: logicalAgentId,
            databaseAgentId: "main",
            storePath: original.path,
          });
          consumed = true;
          await Promise.resolve();
          if (replacement) {
            unlinkSync(alias);
            symlinkSync(replacement.path, alias);
          }
          return read.value;
        },
      );
      if (retarget) {
        await expect(pending).rejects.toThrow("Session store alias changed during discovery");
      } else {
        await expect(pending).resolves.toMatchObject({ sessionId: "original" });
      }
      expect(consumed).toBe(true);
    });
  },
);

it.each(["logical", "omitted", "empty"] as const)(
  "fences the selected SQLite alias after a %s store read releases its initial owner",
  async (locator) => {
    await withOpenClawTestState({ label: "currency-selected-store-alias" }, async (state) => {
      const original = openOpenClawAgentDatabase({
        agentId: "main",
        path: state.statePath("original", "openclaw-agent.sqlite"),
        env: state.env,
      });
      const replacement = openOpenClawAgentDatabase({
        agentId: "main",
        path: state.statePath("replacement", "openclaw-agent.sqlite"),
        env: state.env,
      });
      const sessionKey = "agent:main:subagent:currency-selected-alias";
      const entry = {
        sessionId: "selected-alias-session",
        lifecycleRevision: "selected-alias-lifecycle",
        lifecycleRunId: "selected-alias-run",
        updatedAt: 1,
      };
      writeSessionEntry(original, sessionKey, entry);
      writeSessionEntry(replacement, sessionKey, entry);
      const alias = state.agentDir();
      mkdirSync(dirname(alias), { recursive: true });
      const linkType = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(dirname(original.path), alias, linkType);
      mkdirSync(state.sessionsDir(), { recursive: true });
      const logicalParent = realpathSync(state.sessionsDir());
      const selectedSqlite = join(state.agentDir(), "openclaw-agent.sqlite");
      expect(realpathSync(selectedSqlite)).toBe(realpathSync(original.path));
      const scope = {
        agentId: "main",
        sessionKey,
        env: state.env,
        ...(locator === "logical"
          ? { storePath: join(state.sessionsDir(), "sessions.json") }
          : locator === "empty"
            ? { storePath: "" }
            : {}),
      };
      const current = await withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          expect(read.value?.sessionId).toBe(entry.sessionId);
          return captureSessionEntryCurrentRead(scope, owner);
        },
      );
      if (current.kind !== "file") {
        throw new Error("Expected the selected durable alias source");
      }
      const nativeCheck: SessionEntryCurrentCheck = {
        source: current.source,
        assertCurrent: () => current.assertSourceCurrent(),
      };
      await expect(current.readCurrent()).resolves.toMatchObject({
        sessionId: entry.sessionId,
        lifecycleRunId: entry.lifecycleRunId,
      });
      rmSync(alias, { recursive: true, force: true });
      symlinkSync(dirname(replacement.path), alias, linkType);
      expect(realpathSync(state.sessionsDir())).toBe(logicalParent);
      expect(realpathSync(selectedSqlite)).toBe(realpathSync(replacement.path));
      expect(entryReads.readSessionEntryRow(original, sessionKey)?.entry.sessionId).toBe(
        entry.sessionId,
      );
      await expect(current.readCurrent()).rejects.toThrow(
        "Session currency logical source changed",
      );
      expect(() =>
        assertSessionEntryCurrentAdmission(
          {
            stage: "commit",
            facts: {
              kind: "session-entry-current",
              source: current.source,
              entry,
              domainFacts: undefined,
            },
          },
          nativeCheck,
        ),
      ).toThrow("Session currency logical source changed");
    });
  },
);
