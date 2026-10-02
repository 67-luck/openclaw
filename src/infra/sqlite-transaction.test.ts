// Covers synchronous SQLite transaction helpers.
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getNodeSqliteKysely } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransaction,
  runSqliteImmediateTransactionSync,
  withSqliteWriteAdmissionService,
} from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);");
  openDatabases.push(db);
  return db;
}

function readEntries(db: import("node:sqlite").DatabaseSync): string[] {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => (row as { id: string }).id);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  vi.restoreAllMocks();
});

describe("runSqliteDeferredTransactionSync", () => {
  it("keeps multiple reads on one snapshot while another connection commits", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-read-snapshot-");
    const databasePath = path.join(tempDir, "snapshot.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const reader = new DatabaseSync(databasePath);
    const writer = new DatabaseSync(databasePath);
    openDatabases.push(reader, writer);
    reader.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY); INSERT INTO entries VALUES ('first');",
    );
    writer.exec("PRAGMA busy_timeout = 1000;");

    const counts = runSqliteDeferredTransactionSync(reader, () => {
      const before = reader.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      };
      writer.prepare("INSERT INTO entries(id) VALUES (?)").run("second");
      const after = reader.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      };
      return [before.count, after.count];
    });

    expect(counts).toEqual([1, 1]);
    expect(writer.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 2 });
  });
});

describe("runSqliteImmediateTransactionSync", () => {
  it("keeps outer writes when a nested savepoint rolls back", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "rolled back");
          throw new Error("nested failure");
        }),
      ).toThrow("nested failure");
    });

    expect(readEntries(db)).toEqual(["outer"]);
  });

  it("commits nested savepoint writes with the outer transaction", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "kept");
      });
    });

    expect(readEntries(db)).toEqual(["inner", "outer"]);
  });

  it("preserves SQLITE_FULL and prevents caught nested failures from committing later writes", async () => {
    const tempDir = tempDirs.make("openclaw-sqlite-full-");
    const databasePath = path.join(tempDir, "full.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    openDatabases.push(db);
    db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value BLOB); PRAGMA max_page_count=3");
    let primaryError: unknown;
    let nestedError: unknown;
    let continuationError: unknown;
    let stagedValue = "before";
    const published: string[] = [];
    const stateEvents: string[] = [];
    const stage = (value: string) => {
      const previous = stagedValue;
      expect(
        stageSqliteTransactionState(db, {
          stage: () => {
            stagedValue = value;
          },
          rollback: () => {
            stagedValue = previous;
            stateEvents.push(`rollback:${value}`);
          },
          commit: () => {
            stateEvents.push(`commit:${value}`);
          },
        }),
      ).toBe(true);
      expect(deferSqlitePostCommitPublication(db, () => published.push(value))).toBe(true);
    };
    let outerError: unknown;
    try {
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries VALUES ('outer', 'kept only on commit')").run();
          stage("outer");
          try {
            withSqlitePostCommitPublications(db, () =>
              runSqliteImmediateTransactionSync(db, () => {
                stage("inner");
                try {
                  db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run();
                } catch (error) {
                  primaryError = error;
                  throw error;
                }
              }),
            );
          } catch (error) {
            nestedError = error;
          }
          // Even a caller that catches the failure cannot publish or autocommit
          // a continuation after SQLite has aborted the enclosing transaction.
          expect(stagedValue).toBe("before");
          try {
            db.prepare("INSERT INTO entries VALUES ('continuation', 'must not persist')").run();
          } catch (error) {
            continuationError = error;
          }
        }),
      );
    } catch (error) {
      outerError = error;
    }
    expect(primaryError).toMatchObject({ errcode: 13 });
    expect(nestedError).toBe(primaryError);
    expect(outerError).toBe(primaryError);
    expect(continuationError).toBeDefined();
    expect(db.isOpen).toBe(false);
    expect(stagedValue).toBe("before");
    expect(stateEvents).toEqual(["rollback:inner", "rollback:outer"]);
    expect(published).toEqual([]);
    let reuseError: unknown;
    try {
      runSqliteImmediateTransactionSync(db, () => undefined);
    } catch (error) {
      reuseError = error;
    }
    expect(reuseError).toBe(primaryError);
    const prepare = vi.fn(async () => () => undefined);
    await expect(runSqliteImmediateTransaction(db, prepare)).rejects.toBe(primaryError);
    expect(prepare).not.toHaveBeenCalled();

    const reopened = new DatabaseSync(databasePath);
    openDatabases.push(reopened);
    expect(readEntries(reopened)).toEqual([]);
    runSqliteImmediateTransactionSync(reopened, () => {
      reopened.prepare("INSERT INTO entries VALUES ('recovered', 'ok')").run();
    });
    expect(readEntries(reopened)).toEqual(["recovered"]);
    expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it.each([false, true])(
    "retains the outer owner outcome after automatic rollback (observer fails: %s)",
    (observerFails) => {
      const db = createDatabase();
      db.exec("PRAGMA max_page_count=3");
      const observerError = new Error("rollback observer failed");
      let primaryError: unknown;
      const operation = vi.fn(() => {
        db.prepare("INSERT INTO entries VALUES ('uncommitted', 'before failure')").run();
        deferSqlitePostCommitPublication(db, publish);
        stageSqliteTransactionState(db, {
          stage: () => undefined,
          rollback,
          commit,
        });
        try {
          db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run();
        } catch (error) {
          primaryError = error;
          throw error;
        }
      });
      const publish = vi.fn();
      const rollback = vi.fn(() => {
        if (observerFails) {
          throw observerError;
        }
      });
      const commit = vi.fn();
      let reportedError: unknown;
      try {
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, operation),
        );
      } catch (error) {
        reportedError = error;
      }

      expect(primaryError).toMatchObject({ errcode: 13 });
      if (observerFails) {
        expect(reportedError).toBeInstanceOf(AggregateError);
        if (!(reportedError instanceof AggregateError)) {
          throw new Error("Expected transaction and rollback observer failures to be aggregated");
        }
        expect(reportedError.cause).toBe(primaryError);
        expect(reportedError.errors).toHaveLength(2);
        expect(reportedError.errors[0]).toBe(primaryError);
        expect(reportedError.errors[1]).toBe(observerError);
      } else {
        expect(reportedError).toBe(primaryError);
      }
      expect(operation).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
      if (observerFails) {
        expect(db.isOpen).toBe(false);
        const reuse = vi.fn();
        let reuseError: unknown;
        try {
          runSqliteImmediateTransactionSync(db, reuse);
        } catch (error) {
          reuseError = error;
        }
        expect(reuseError).toBe(reportedError);
        expect(reuse).not.toHaveBeenCalled();
        return;
      }
      expect(db.isOpen).toBe(true);
      expect(db.isTransaction).toBe(false);
      expect(readEntries(db)).toEqual([]);
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries VALUES ('recovered', 'ok')").run();
      });
      expect(readEntries(db)).toEqual(["recovered"]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    },
  );

  it.each([false, true])(
    "retains the first inverse failure after root SQLITE_FULL (close fails: %s)",
    (closeFails) => {
      const db = createDatabase();
      db.exec("PRAGMA max_page_count=3");
      const inverseFailure = new Error("root inverse failed");
      const closeFailure = new Error("native close failed");
      const order: string[] = [];
      const beforeFacade = getNodeSqliteKysely(db);
      let atClose: unknown;
      const close = db.close.bind(db);
      const closing = vi.spyOn(db, "close").mockImplementationOnce(() => {
        atClose = getNodeSqliteKysely(db);
        order.push("native-close");
        if (closeFails) {
          throw closeFailure;
        }
        close();
      });
      const publish = vi.fn();
      const commit = vi.fn();
      let primary: unknown;
      let failure: unknown;
      try {
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            for (const id of ["first", "second"]) {
              stageSqliteTransactionState(db, {
                stage: () => undefined,
                commit,
                rollback() {
                  order.push(`rollback:${id}`);
                  if (id === "second") {
                    throw inverseFailure;
                  }
                },
              });
            }
            deferSqlitePostCommitPublication(db, publish);
            try {
              db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run();
            } catch (error) {
              primary = error;
              throw error;
            }
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(primary).toMatchObject({ errcode: 13 });
      assert(failure instanceof AggregateError);
      const inverse = closeFails ? failure.errors[0] : failure;
      assert(inverse instanceof AggregateError);
      expect(inverse.cause).toBe(primary);
      expect(inverse.errors).toEqual([primary, inverseFailure]);
      expect(inverse.errors[0]).toBe(primary);
      expect(inverse.errors[1]).toBe(inverseFailure);
      if (closeFails) {
        expect(failure.cause).toBe(inverse);
        expect(failure.errors).toEqual([inverse, closeFailure]);
        expect(failure.errors[1]).toBe(closeFailure);
      }
      expect(order).toEqual(["rollback:second", "rollback:first", "native-close"]);
      expect(commit).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(closing).toHaveBeenCalledOnce();
      expect(atClose).not.toBe(beforeFacade);
      expect(db.isOpen).toBe(closeFails);
      const operation = vi.fn();
      let reused: unknown;
      try {
        runSqliteImmediateTransactionSync(db, operation);
      } catch (error) {
        reused = error;
      }
      expect(reused).toBe(failure);
      expect(operation).not.toHaveBeenCalled();
      expect(order).toEqual(["rollback:second", "rollback:first", "native-close"]);
      expect(closing).toHaveBeenCalledOnce();
    },
  );

  it.each(["throw", "promise"] as const)(
    "fences the connection when the commit owner fails after COMMIT (%s)",
    (failure) => {
      const databasePath = path.join(tempDirs.make("openclaw-commit-owner-"), "state.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(databasePath);
      openDatabases.push(db);
      db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT)");
      const ownerError = new Error("commit owner failed after commit");
      const withCommit =
        failure === "throw"
          ? (commit: () => void) => {
              commit();
              throw ownerError;
            }
          : async (commit: () => void) => {
              commit();
            };
      const publish = vi.fn();
      const operation = vi.fn(() => {
        db.prepare("INSERT INTO entries VALUES ('committed', 'durable')").run();
        deferSqlitePostCommitPublication(db, publish);
      });

      expect(() =>
        withSqlitePostCommitPublications(db, () =>
          // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous commit-owner contract.
          runSqliteImmediateTransactionSync(db, operation, { withCommit }),
        ),
      ).toThrow(failure === "throw" ? ownerError : "must be synchronous");
      expect(operation).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(false);
      expect(() => runSqliteImmediateTransactionSync(db, operation)).toThrow(
        failure === "throw" ? ownerError : "must be synchronous",
      );
      expect(operation).toHaveBeenCalledOnce();
      const reopened = new DatabaseSync(databasePath);
      openDatabases.push(reopened);
      expect(readEntries(reopened)).toEqual(["committed"]);
    },
  );

  it.each([
    { failedStep: "ROLLBACK", observerFails: false },
    { failedStep: "ROLLBACK", observerFails: true },
    { failedStep: "ROLLBACK TO SAVEPOINT", observerFails: false },
    { failedStep: "ROLLBACK TO SAVEPOINT", observerFails: true },
    { failedStep: "RELEASE SAVEPOINT", observerFails: false },
    { failedStep: "RELEASE SAVEPOINT", observerFails: true },
  ])(
    "disposes failed $failedStep cleanup and preserves its errors (observer fails: $observerFails)",
    ({ failedStep, observerFails }) => {
      const db = createDatabase();
      const operationError = new Error("operation failed");
      const observerError = new Error("rollback observer failed");
      const nested = failedStep !== "ROLLBACK";
      const events: string[] = [];
      const rollbackErrors: unknown[] = [];
      const facadeBeforeClose = getNodeSqliteKysely(db);
      let facadeAtClose: unknown;
      const close = db.close.bind(db);
      vi.spyOn(db, "close").mockImplementation(() => {
        events.push("close");
        facadeAtClose = getNodeSqliteKysely(db);
        close();
      });
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql.startsWith(failedStep)) {
          throw new Error("injected native cleanup failure");
        }
        exec(sql);
      });
      const stage = (label: string, fails: boolean) => {
        stageSqliteTransactionState(db, {
          stage: () => {
            events.push(`stage:${label}`);
          },
          rollback: (error) => {
            rollbackErrors.push(error);
            events.push(`rollback:${label}`);
            if (fails) {
              throw observerError;
            }
          },
          commit: () => {
            events.push(`commit:${label}`);
          },
        });
        deferSqlitePostCommitPublication(db, () => events.push(`publish:${label}`));
      };
      let nestedError: unknown;
      let reportedError: unknown;
      try {
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            db.prepare("INSERT INTO entries VALUES ('outer', 'uncommitted')").run();
            stage("outer", observerFails && !nested);
            if (!nested) {
              throw operationError;
            }
            try {
              withSqlitePostCommitPublications(db, () =>
                runSqliteImmediateTransactionSync(db, () => {
                  db.prepare("INSERT INTO entries VALUES ('inner', 'uncommitted')").run();
                  stage("inner", observerFails);
                  throw operationError;
                }),
              );
            } catch (error) {
              nestedError = error;
            }
          }),
        );
      } catch (error) {
        reportedError = error;
      }

      expect(db.isOpen).toBe(false);
      expect(facadeAtClose).toBeDefined();
      expect(facadeAtClose).not.toBe(facadeBeforeClose);
      expect(events).toEqual(
        nested
          ? ["stage:outer", "stage:inner", "rollback:inner", "rollback:outer", "close"]
          : ["stage:outer", "rollback:outer", "close"],
      );
      for (const error of rollbackErrors) {
        expect(error).toBe(operationError);
      }
      if (observerFails) {
        expect(reportedError).toBeInstanceOf(AggregateError);
        if (!(reportedError instanceof AggregateError)) {
          throw new Error("Expected transaction and rollback observer failures to be aggregated");
        }
        expect(reportedError.cause).toBe(operationError);
        expect(reportedError.errors).toHaveLength(2);
        expect(reportedError.errors[0]).toBe(operationError);
        expect(reportedError.errors[1]).toBe(observerError);
      } else {
        expect(reportedError).toBe(operationError);
      }
      if (nested) {
        expect(nestedError).toBe(reportedError);
      }
      const reuse = vi.fn();
      let reuseError: unknown;
      try {
        runSqliteImmediateTransactionSync(db, reuse);
      } catch (error) {
        reuseError = error;
      }
      expect(reuseError).toBe(reportedError);
      expect(reuse).not.toHaveBeenCalled();
    },
  );

  it("closes a lost native transaction even when the first fixed rollback throws", () => {
    const db = createDatabase();
    db.exec(
      "CREATE TRIGGER abort_fixture BEFORE INSERT ON entries WHEN NEW.id = 'abort' BEGIN SELECT RAISE(ROLLBACK, 'fixture native rollback'); END",
    );
    const stateFailure = new Error("fixed rollback failed");
    const order: string[] = [];
    const staged: string[] = [];
    const beforeFacade = getNodeSqliteKysely(db);
    let atClose: unknown;
    const close = db.close.bind(db);
    vi.spyOn(db, "close").mockImplementation(() => {
      atClose = getNodeSqliteKysely(db);
      order.push("native-close");
      close();
    });
    let primary: unknown;
    let failure: unknown;
    try {
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          for (const id of ["first", "second"]) {
            stageSqliteTransactionState(db, {
              stage() {
                staged.push(id);
              },
              commit() {
                order.push(`commit:${id}`);
              },
              rollback() {
                expect(staged.pop()).toBe(id);
                order.push(`rollback:${id}`);
                if (id === "second") {
                  throw stateFailure;
                }
              },
            });
            deferSqlitePostCommitPublication(db, () => order.push(`observer:${id}`));
          }
          runSqliteImmediateTransactionSync(db, () => {
            try {
              db.prepare("INSERT INTO entries VALUES ('abort', 'discarded')").run();
            } catch (error) {
              primary = error;
              throw error;
            }
          });
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(primary).toBeInstanceOf(Error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ cause: primary });
    expect(order).toEqual(["rollback:second", "rollback:first", "native-close"]);
    expect(staged).toEqual([]);
    expect(atClose).not.toBe(beforeFacade);
    expect(db.isOpen).toBe(false);
    let reused: unknown;
    try {
      runSqliteImmediateTransactionSync(db, () => undefined);
    } catch (error) {
      reused = error;
    }
    expect(reused).toBe(failure);
  });

  it("rejects Promise-returning operations and rolls back their synchronous writes", () => {
    const db = createDatabase();

    expect(() =>
      runSqliteImmediateTransactionSync(db, async () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("async", "rolled back");
        return "done";
      }),
    ).toThrow("must be synchronous");
    expect(readEntries(db)).toEqual([]);

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("after", "works");
    });
    expect(readEntries(db)).toEqual(["after"]);
  });

  it("does not retry commit failures and rolls back the transaction", () => {
    const execCalls: string[] = [];
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "COMMIT") {
          throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
        }
      },
      close() {},
    } as import("node:sqlite").DatabaseSync;

    expect(() => runSqliteImmediateTransactionSync(db, () => "not committed")).toThrow(
      "database is busy",
    );
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
  });

  function createContendedDatabase() {
    const directory = tempDirs.make("openclaw-sqlite-service-diagnostics-");
    const databasePath = path.join(directory, "admission.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    const writer = new DatabaseSync(databasePath);
    openDatabases.push(db, writer);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE entries(id TEXT PRIMARY KEY)",
    );
    writer.exec("BEGIN IMMEDIATE");
    return { db, writer };
  }

  it("counts no-op admission services separately from retried native BEGIN attempts", async () => {
    const { db, writer } = createContendedDatabase();
    const logger = { warn: vi.fn() };
    // Advance diagnostic wall time at real operations; the native admission deadline stays real.
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        now += 10;
      }
      exec(sql);
    });
    const noWork = vi.fn(() => {
      now += 25;
    });
    const releaseWriter = vi.fn(() => {
      writer.exec("COMMIT");
      now += 1_200;
    });
    const write = vi.fn(() => db.prepare("INSERT INTO entries VALUES ('committed')").run());

    await withSqliteWriteAdmissionService(db, noWork, () =>
      withSqliteWriteAdmissionService(db, releaseWriter, async () => {
        runSqliteImmediateTransactionSync(db, write, {
          busyTimeoutMs: 5_000,
          databaseLabel: "service-diagnostics",
          logger,
          operationLabel: "service-proof",
        });
      }),
    );

    expect(write).toHaveBeenCalledOnce();
    expect(noWork).toHaveBeenCalledOnce();
    expect(releaseWriter).toHaveBeenCalledOnce();
    expect(writer.isTransaction).toBe(false);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
    expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "committed" }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "slow SQLite transaction step",
      expect.objectContaining({
        operation: "service-proof",
        step: "begin",
        elapsedMs: 1_245,
        beginAdmission: { nativeAttempts: 2, nativeMs: 20, serviceCalls: 2, serviceMs: 1_225 },
      }),
    );
  });

  it.each([true, false])(
    "preserves partial admission measurements and a thrown service error (lock error: %s)",
    async (lockError) => {
      const { db, writer } = createContendedDatabase();
      const logger = { warn: vi.fn() };
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE") {
          now += 11;
        }
        exec(sql);
      });
      const failure = lockError
        ? Object.assign(new Error("service lock failure"), { code: "SQLITE_BUSY", errcode: 5 })
        : new Error("service authority refused");
      const service = vi.fn(() => {
        now += 1_300;
        throw failure;
      });
      const write = vi.fn();
      let thrown: unknown;
      try {
        await withSqliteWriteAdmissionService(db, service, async () => {
          runSqliteImmediateTransactionSync(db, write, {
            busyTimeoutMs: 5_000,
            databaseLabel: "service-diagnostics",
            logger,
            operationLabel: "service-proof",
          });
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(failure);
      expect(service).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(writer.isTransaction).toBe(true);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
      writer.exec("ROLLBACK");
      runSqliteImmediateTransactionSync(db, () =>
        db.prepare("INSERT INTO entries VALUES ('after-refusal')").run(),
      );
      expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "after-refusal" }]);
      expect(logger.warn).toHaveBeenCalledTimes(lockError ? 1 : 0);
      if (lockError) {
        expect(logger.warn).toHaveBeenCalledWith(
          "SQLite transaction lock wait failed",
          expect.objectContaining({
            code: "SQLITE_BUSY",
            step: "begin",
            elapsedMs: 1_311,
            beginAdmission: { nativeAttempts: 1, nativeMs: 11, serviceCalls: 1, serviceMs: 1_300 },
          }),
        );
      }
    },
  );
});

describe("runSqliteImmediateTransaction", () => {
  it.each([true, false])(
    "preserves a failed nested rollback caught during preparation (write prepared: %s)",
    async (writePrepared) => {
      const db = createDatabase();
      db.exec("PRAGMA max_page_count=3");
      const write = vi.fn();
      let primaryError: unknown;
      const prepare = vi.fn(async () => {
        await Promise.resolve();
        try {
          runSqliteImmediateTransactionSync(db, () =>
            runSqliteImmediateTransactionSync(db, () =>
              db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run(),
            ),
          );
        } catch (error) {
          primaryError = error;
        }
        return writePrepared ? write : undefined;
      });
      let reportedError: unknown;
      try {
        await runSqliteImmediateTransaction(db, prepare);
      } catch (error) {
        reportedError = error;
      }
      expect(primaryError).toMatchObject({ errcode: 13 });
      expect(reportedError).toBe(primaryError);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(false);
    },
  );

  it.each([false, true])(
    "preserves a failed rollback during admission yield (deadline expired: %s)",
    async (expireDeadline) => {
      const dir = tempDirs.make("openclaw-sqlite-admission-abort-");
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(path.join(dir, "index.sqlite"));
      const writer = new DatabaseSync(path.join(dir, "index.sqlite"));
      openDatabases.push(db, writer);
      const busyTimeoutMs = expireDeadline ? 100 : 1000;
      db.exec(`CREATE TABLE entries(id INTEGER PRIMARY KEY, value BLOB);
        PRAGMA max_page_count=2; PRAGMA busy_timeout=${busyTimeoutMs}`);
      writer.exec("BEGIN IMMEDIATE");
      let primaryError: unknown;
      let reportedError: unknown;
      let faultScheduled = false;
      let faultDone = Promise.resolve();
      const write = vi.fn(() =>
        db.prepare("INSERT INTO entries(value) VALUES ('unexpected')").run(),
      );
      const prepare = vi.fn(async () => {
        db.prepare("SELECT COUNT(*) FROM entries").get();
        if (!faultScheduled) {
          faultScheduled = true;
          faultDone = new Promise<void>((resolve) => {
            setImmediate(() => {
              try {
                writer.exec("ROLLBACK");
                runSqliteImmediateTransactionSync(db, () =>
                  runSqliteImmediateTransactionSync(db, () =>
                    db.prepare("INSERT INTO entries(value) VALUES (zeroblob(65536))").run(),
                  ),
                );
              } catch (error) {
                primaryError = error;
              } finally {
                // Keep the admission timer from resuming until its real deadline expires.
                if (expireDeadline) {
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, busyTimeoutMs + 20);
                }
                resolve();
              }
            });
          });
        }
        return write;
      });
      try {
        await runSqliteImmediateTransaction(db, prepare);
      } catch (error) {
        reportedError = error;
      }
      await faultDone;
      expect(primaryError).toMatchObject({ errcode: 13 });
      expect(reportedError).toBe(primaryError);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(false);
      expect(writer.prepare("SELECT id FROM entries").all()).toEqual([]);
    },
  );

  it("preserves a failed rollback caught while waiting for owner admission", async () => {
    const db = createDatabase();
    db.exec("PRAGMA max_page_count=3");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const write = vi.fn(() => "unexpected");
    const pending = runSqliteImmediateTransaction(
      db,
      async () => write,
      undefined,
      async (admittedWrite) => {
        entered.resolve();
        await release.promise;
        return admittedWrite();
      },
    );
    let primaryError: unknown;
    try {
      await entered.promise;
      try {
        runSqliteImmediateTransactionSync(db, () =>
          runSqliteImmediateTransactionSync(db, () =>
            db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run(),
          ),
        );
      } catch (error) {
        primaryError = error;
      }
      expect(primaryError).toMatchObject({ errcode: 13 });
      expect(db.isOpen).toBe(false);
      release.resolve();
      await expect(pending).rejects.toBe(primaryError);
      expect(write).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  });

  it("waits for the owner's admission before beginning a prepared write", async () => {
    const db = createDatabase();
    const admissionStarted = createDeferredCore();
    const releaseAdmission = createDeferredCore();
    const pending = runSqliteImmediateTransaction(
      db,
      async () => () => {
        db.prepare("INSERT INTO entries(id, value) VALUES ('admitted', 'value')").run();
        return "committed";
      },
      undefined,
      async (write) => {
        admissionStarted.resolve();
        await releaseAdmission.promise;
        return write();
      },
    );
    try {
      const first = await Promise.race([
        admissionStarted.promise.then(() => "admission"),
        pending.then(() => "committed"),
      ]);
      expect(first).toBe("admission");
      expect(db.isTransaction).toBe(false);
      expect(readEntries(db)).toEqual([]);
      releaseAdmission.resolve();
      await expect(pending).resolves.toBe("committed");
      expect(readEntries(db)).toEqual(["admitted"]);
    } finally {
      releaseAdmission.resolve();
      await pending.catch(() => undefined);
    }
  });

  it.each(["retired", "transaction"])(
    "does not write after owner admission is %s",
    async (state) => {
      const db = createDatabase();
      const write = vi.fn(() => "unexpected");
      await expect(
        runSqliteImmediateTransaction(
          db,
          async () => write,
          undefined,
          async (admittedWrite) => {
            if (state === "retired") {
              throw new Error("owner retired");
            }
            db.exec("BEGIN");
            return admittedWrite();
          },
        ),
      ).rejects.toThrow(state === "retired" ? "owner retired" : /transaction/);
      expect(write).not.toHaveBeenCalled();
      expect(db.isTransaction).toBe(state === "transaction");
    },
  );

  it("repeats preparation and can decline a write while another writer remains active", async () => {
    const dir = tempDirs.make("openclaw-sqlite-preparation-");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(dir, "index.sqlite"));
    const writer = new DatabaseSync(path.join(dir, "index.sqlite"));
    openDatabases.push(db, writer);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE entries(id TEXT PRIMARY KEY);",
    );
    writer.exec("BEGIN IMMEDIATE");
    let eligible = true;
    let preparations = 0;
    const write = vi.fn(() => db.prepare("INSERT INTO entries VALUES ('unexpected')").run());
    const pending = runSqliteImmediateTransaction(db, async () => {
      preparations += 1;
      expect(db.isTransaction).toBe(false);
      return eligible ? write : undefined;
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(preparations).toBeGreaterThan(1));
      eligible = false;
      await expect(pending).resolves.toBeUndefined();
      expect(writer.isTransaction).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(db.prepare("SELECT id FROM entries").all()).toEqual([]);
      expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    } finally {
      writer.exec("ROLLBACK");
      await pending.catch(() => undefined);
    }
  });

  it.each(["existing", "preparation"])(
    "rejects a transaction from %s before admitting writes",
    async (owner) => {
      const db = createDatabase();
      const write = vi.fn();
      const prepare = vi.fn(async () => {
        db.exec("BEGIN");
        return write;
      });
      if (owner === "existing") {
        db.exec("BEGIN");
      }
      await expect(runSqliteImmediateTransaction(db, prepare)).rejects.toThrow(/transaction/);
      expect(prepare).toHaveBeenCalledTimes(owner === "existing" ? 0 : 1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isTransaction).toBe(true);
      db.exec("ROLLBACK");
    },
  );

  it("prepares without holding a transaction and never replays an admitted write", async () => {
    const db = createDatabase();
    db.exec("PRAGMA busy_timeout = 50");
    const lockError = Object.assign(new Error("database is locked"), { errcode: 5 });
    let calls = 0;
    await expect(
      runSqliteImmediateTransaction(db, async () => {
        await Promise.resolve();
        expect(db.isTransaction).toBe(false);
        return () => {
          calls += 1;
          expect(db.isTransaction).toBe(true);
          expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(50);
          db.prepare("INSERT INTO entries(id, value) VALUES ('aborted', 'value')").run();
          throw lockError;
        };
      }),
    ).rejects.toBe(lockError);
    expect(calls).toBe(1);
    expect(readEntries(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});
