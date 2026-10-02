import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  captureSqlitePostCommitPublication,
  captureSqliteTransactionState,
  deferSqlitePostCommitPublication,
  discardSqliteTransactionState,
  hasSqlitePostCommitScope,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);");
  openDatabases.push(db);
  return db;
}

function beforeNextBegin(db: import("node:sqlite").DatabaseSync, operation: () => void): void {
  const exec = db.exec.bind(db);
  let pending = true;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (pending && sql === "BEGIN IMMEDIATE") {
      pending = false;
      operation();
    }
    exec(sql);
  });
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  vi.restoreAllMocks();
});

describe("runSqliteImmediateTransactionSync", () => {
  it.each([
    "success",
    "transaction Error",
    "transaction undefined",
    "fixed Error",
    "observer Error",
    "retainer Error",
  ] as const)("restores the pre-BEGIN journal after an independent root %s", (outcome) => {
    const db = createDatabase();
    const errorFailure = new Error(outcome);
    const failure = outcome === "transaction undefined" ? undefined : errorFailure;
    const order: string[] = [];
    const refused = { stage: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    let parent: ReturnType<typeof captureSqliteTransactionState>;
    let child: ReturnType<typeof captureSqliteTransactionState>;
    let childPublication = captureSqlitePostCommitPublication(db);
    const closed = (phase: string) => {
      order.push(phase);
      expect(db.isTransaction).toBe(false);
      expect(hasSqlitePostCommitScope(db)).toBe(false);
      expect(captureSqliteTransactionState(db)).toBeUndefined();
      expect(stageSqliteTransactionState(db, refused)).toBe(false);
      expect(parent?.stage(refused)).toBe(false);
      expect(child?.stage(refused)).toBe(false);
      expect(deferSqlitePostCommitPublication(db, refused.commit)).toBe(false);
      expect(captureSqlitePostCommitPublication(db)(refused.commit)).toBe(false);
      expect(childPublication(refused.commit)).toBe(false);
    };
    beforeNextBegin(db, () => {
      let caught = false;
      let original: unknown;
      try {
        withSqlitePostCommitPublications(
          db,
          () =>
            runSqliteImmediateTransactionSync(db, () => {
              child = captureSqliteTransactionState(db);
              expect(child?.transaction).not.toBe(parent?.transaction);
              childPublication = captureSqlitePostCommitPublication(db);
              db.prepare("INSERT INTO entries VALUES (?, ?)").run("child", "written");
              for (const id of ["first", "second"]) {
                expect(
                  stageSqliteTransactionState(db, {
                    stage() {},
                    commit() {
                      closed(`commit:${id}`);
                      if (id === "first" && outcome === "fixed Error") {
                        throw errorFailure;
                      }
                    },
                    prepareObservers() {
                      closed(`receipt:${id}`);
                    },
                    rollback() {
                      closed(`rollback:${id}`);
                    },
                  }),
                ).toBe(true);
              }
              expect(
                childPublication(() => {
                  closed("observer");
                  if (outcome === "observer Error") {
                    throw errorFailure;
                  }
                }),
              ).toBe(true);
              if (outcome.startsWith("transaction")) {
                // The transaction journal must preserve a thrown undefined as a present failure.
                // oxlint-disable-next-line typescript/only-throw-error
                throw failure;
              }
            }),
          (publish) => {
            closed("retainer");
            publish();
            publish();
            if (outcome === "retainer Error") {
              throw errorFailure;
            }
          },
        );
      } catch (error) {
        caught = true;
        original = error;
      }
      expect(caught).toBe(outcome !== "success");
      if (caught) {
        expect(original).toBe(failure);
      }
      expect(captureSqliteTransactionState(db)?.transaction).toBe(parent?.transaction);
      expect(child?.stage(refused)).toBe(false);
      expect(childPublication(refused.commit)).toBe(false);
    });
    withSqlitePostCommitPublications(db, () => {
      parent = captureSqliteTransactionState(db);
      expect(parent).toBeDefined();
      return runSqliteImmediateTransactionSync(db, () => {
        expect(captureSqliteTransactionState(db)?.transaction).toBe(parent?.transaction);
        db.prepare("INSERT INTO entries VALUES (?, ?)").run("parent", "committed");
        expect(
          parent?.stage({
            stage() {},
            commit: () => order.push("parent:commit"),
            rollback: () => order.push("parent:rollback"),
          }),
        ).toBe(true);
        deferSqlitePostCommitPublication(db, () => order.push("parent:observer"));
      });
    });
    expect(order).toEqual([
      ...(outcome.startsWith("transaction")
        ? ["rollback:second", "rollback:first"]
        : [
            "commit:first",
            "commit:second",
            "receipt:first",
            "receipt:second",
            ...(outcome === "fixed Error" ? [] : ["retainer", "observer"]),
          ]),
      "parent:commit",
      "parent:observer",
    ]);
    expect(db.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([
      ...(outcome.startsWith("transaction") ? [] : [{ id: "child" }]),
      { id: "parent" },
    ]);
    expect(refused.stage).not.toHaveBeenCalled();
    expect(refused.commit).not.toHaveBeenCalled();
    expect(refused.rollback).not.toHaveBeenCalled();
    expect(parent?.stage(refused)).toBe(false);
    expect(hasSqlitePostCommitScope(db)).toBe(false);
  });

  it("keeps the suspended journal hidden through reentrant fixed and outward tails", () => {
    const db = createDatabase();
    const order: string[] = [];
    const journals: object[] = [];
    let parent: ReturnType<typeof captureSqliteTransactionState>;
    const refused = { stage: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    const append = (id: string, afterCommit?: () => void, publish?: () => void) =>
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          const captured = captureSqliteTransactionState(db)!;
          journals.push(captured.transaction);
          db.prepare("INSERT INTO entries VALUES (?, ?)").run(id, id);
          captured.stage({
            stage() {},
            commit() {
              expect(captureSqliteTransactionState(db)).toBeUndefined();
              expect(parent?.stage(refused)).toBe(false);
              order.push(`commit:${id}`);
              afterCommit?.();
              expect(captureSqliteTransactionState(db)).toBeUndefined();
              expect(captured.stage(refused)).toBe(false);
            },
            rollback() {
              order.push(`rollback:${id}`);
            },
          });
          deferSqlitePostCommitPublication(db, () => {
            order.push(`observer:${id}`);
            publish?.();
            expect(captureSqliteTransactionState(db)).toBeUndefined();
            expect(parent?.stage(refused)).toBe(false);
          });
        }),
      );
    beforeNextBegin(db, () => {
      append(
        "child",
        () => append("fixed-reentry"),
        () => append("observer-reentry"),
      );
      expect(captureSqliteTransactionState(db)?.transaction).toBe(parent?.transaction);
    });
    withSqlitePostCommitPublications(db, () => {
      parent = captureSqliteTransactionState(db);
      return runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries VALUES (?, ?)").run("parent", "committed");
        expect(captureSqliteTransactionState(db)?.transaction).toBe(parent?.transaction);
      });
    });
    expect(new Set([parent?.transaction, ...journals]).size).toBe(4);
    expect(order).toEqual([
      "commit:child",
      "commit:fixed-reentry",
      "observer:fixed-reentry",
      "observer:child",
      "commit:observer-reentry",
      "observer:observer-reentry",
    ]);
    expect(db.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([
      { id: "child" },
      { id: "fixed-reentry" },
      { id: "observer-reentry" },
      { id: "parent" },
    ]);
    expect(refused.stage).not.toHaveBeenCalled();
    expect(hasSqlitePostCommitScope(db)).toBe(false);
  });

  it.each([false, true])(
    "invalidates suspended journals after native loss (committed sibling: %s)",
    (committedSibling) => {
      const db = createDatabase();
      db.exec(
        "CREATE TRIGGER abort_fixture BEFORE INSERT ON entries WHEN NEW.id = 'abort' BEGIN SELECT RAISE(ROLLBACK, 'fixture native rollback'); END",
      );
      const cleanup = new Error("fixed inverse failed after restoring its state");
      const order: string[] = [];
      const staged: string[] = [];
      const captures: NonNullable<ReturnType<typeof captureSqliteTransactionState>>[] = [];
      const refused = { stage: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
      let primary: unknown;
      let failure: unknown;
      let nativeLosses = 0;
      let knownCommits = 0;
      const poison = () =>
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            captures.push(captureSqliteTransactionState(db)!);
            for (const id of ["first", "second"]) {
              stageSqliteTransactionState(db, {
                stage: () => staged.push(id),
                commit: () => order.push(`lost:commit:${id}`),
                rollback() {
                  expect(staged.pop()).toBe(id);
                  order.push(`lost:rollback:${id}`);
                  expect(hasSqlitePostCommitScope(db)).toBe(false);
                  expect(captureSqliteTransactionState(db)).toBeUndefined();
                  expect(stageSqliteTransactionState(db, refused)).toBe(false);
                  expect(deferSqlitePostCommitPublication(db, refused.commit)).toBe(false);
                  for (const captured of captures) {
                    expect(captured.stage(refused)).toBe(false);
                  }
                  discardSqliteTransactionState(db, primary);
                  if (id === "second") {
                    throw cleanup;
                  }
                },
              });
              deferSqlitePostCommitPublication(db, () => order.push(`lost:observer:${id}`));
            }
            runSqliteImmediateTransactionSync(db, () => {
              try {
                db.prepare("INSERT INTO entries VALUES ('abort', 'discarded')").run();
              } catch (error) {
                nativeLosses += 1;
                primary = error;
                throw error;
              }
            });
          }),
        );
      beforeNextBegin(db, () => {
        if (!committedSibling) {
          poison();
          return;
        }
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            captures.push(captureSqliteTransactionState(db)!);
            db.prepare("INSERT INTO entries VALUES (?, ?)").run("committed", "kept");
            for (const id of ["first", "second"]) {
              stageSqliteTransactionState(db, {
                stage() {},
                commit() {
                  order.push(`kept:commit:${id}`);
                  if (id === "first") {
                    expect(db.isTransaction).toBe(false);
                    expect(db.prepare("SELECT id FROM entries").all()).toEqual([
                      { id: "committed" },
                    ]);
                    knownCommits += 1;
                    poison();
                  }
                },
                prepareObservers: () => order.push(`kept:receipt:${id}`),
                rollback: () => order.push(`kept:rollback:${id}`),
              });
              deferSqlitePostCommitPublication(db, () => order.push(`kept:observer:${id}`));
            }
          }),
        );
      });
      try {
        withSqlitePostCommitPublications(db, () => {
          captures.push(captureSqliteTransactionState(db)!);
          expect(
            stageSqliteTransactionState(db, {
              stage: () => staged.push("parent"),
              commit: () => order.push("parent:commit"),
              rollback() {
                expect(staged.pop()).toBe("parent");
                order.push("parent:rollback");
                expect(hasSqlitePostCommitScope(db)).toBe(false);
                expect(captureSqliteTransactionState(db)).toBeUndefined();
                for (const captured of captures) {
                  expect(captured.stage(refused)).toBe(false);
                }
              },
            }),
          ).toBe(true);
          expect(deferSqlitePostCommitPublication(db, () => order.push("parent:observer"))).toBe(
            true,
          );
          return runSqliteImmediateTransactionSync(db, () => {
            order.push("parent:entered");
          });
        });
      } catch (error) {
        failure = error;
      }
      expect(primary).toBeInstanceOf(Error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        cause: primary,
        errors: [primary, cleanup],
      });
      const poisonError = failure as AggregateError;
      expect(poisonError.cause).toBe(primary);
      expect(poisonError.errors).toHaveLength(2);
      expect(poisonError.errors[0]).toBe(primary);
      expect(poisonError.errors[1]).toBe(cleanup);
      expect(nativeLosses).toBe(1);
      expect(knownCommits).toBe(committedSibling ? 1 : 0);
      expect(order).toEqual([
        ...(committedSibling ? ["kept:commit:first"] : []),
        "lost:rollback:second",
        "lost:rollback:first",
        "parent:rollback",
        ...(committedSibling
          ? ["kept:commit:second", "kept:receipt:first", "kept:receipt:second"]
          : []),
      ]);
      expect(staged).toEqual([]);
      expect(db.isOpen).toBe(false);
      expect(hasSqlitePostCommitScope(db)).toBe(false);
      expect(captureSqliteTransactionState(db)).toBeUndefined();
      for (const captured of captures) {
        expect(captured.stage(refused)).toBe(false);
      }
      expect(refused.stage).not.toHaveBeenCalled();
      let reuseError: unknown;
      try {
        runSqliteImmediateTransactionSync(db, () => undefined);
      } catch (error) {
        reuseError = error;
      }
      expect(reuseError).toBe(failure);
    },
  );

  it("refuses a captured view stage after its original journal settles", () => {
    const db = createDatabase();
    const retained = { stage: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    let captured: ReturnType<typeof captureSqliteTransactionState>;
    expect(captureSqliteTransactionState(db)).toBeUndefined();
    withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () => {
        captured = captureSqliteTransactionState(db);
        expect(captured?.stage(retained)).toBe(true);
        expect(retained.stage).toHaveBeenCalledWith(captured?.transaction);
      }),
    );
    expect(retained.commit).toHaveBeenCalledOnce();
    expect(captured?.stage(retained)).toBe(false);
    withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () => {
        const current = captureSqliteTransactionState(db);
        expect(current?.transaction).not.toBe(captured?.transaction);
        expect(captured?.stage(retained)).toBe(false);
      }),
    );
    expect(retained.stage).toHaveBeenCalledOnce();
    expect(retained.commit).toHaveBeenCalledOnce();
    expect(retained.rollback).not.toHaveBeenCalled();
  });

  it.each(["empty", "nested"] as const)(
    "hands the completed root %s publication batch to its original continuation once",
    (kind) => {
      const db = createDatabase();
      const order: string[] = [];
      const nestedRetainer = vi.fn();
      let retained: (() => void) | undefined;
      let captured = captureSqlitePostCommitPublication(db);
      const failure = new Error("first retained observer failed");
      withSqlitePostCommitPublications(
        db,
        () =>
          runSqliteImmediateTransactionSync(db, () => {
            db.prepare("INSERT INTO entries VALUES (?, ?)").run("root", "committed");
            stageSqliteTransactionState(db, {
              stage() {},
              commit() {
                order.push("commit");
              },
              prepareObservers() {
                order.push("receipt");
              },
              rollback() {
                order.push("rollback");
              },
            });
            if (kind === "nested") {
              withSqlitePostCommitPublications(
                db,
                () =>
                  runSqliteImmediateTransactionSync(db, () => {
                    captured = captureSqlitePostCommitPublication(db);
                    expect(
                      captured(() => {
                        order.push("first");
                        retained!();
                        throw failure;
                      }),
                    ).toBe(true);
                    captured(() => order.push("later"));
                  }),
                nestedRetainer,
              );
            }
          }),
        (publish) => {
          expect(db.isTransaction).toBe(false);
          expect(order).toEqual(["commit", "receipt"]);
          expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "root" }]);
          order.push("retained");
          retained = publish;
        },
      );
      expect(nestedRetainer).not.toHaveBeenCalled();
      expect(retained).toBeTypeOf("function");
      expect(order).toEqual(["commit", "receipt", "retained"]);
      expect(captured(() => order.push("stale"))).toBe(false);
      if (kind === "nested") {
        expect(() => retained!()).toThrow(failure);
      } else {
        retained!();
      }
      retained!();
      expect(order).toEqual([
        "commit",
        "receipt",
        "retained",
        ...(kind === "nested" ? ["first"] : []),
      ]);
    },
  );

  it.each(["rollback", "fixed failure"] as const)(
    "does not hand off an outward batch after root %s",
    (kind) => {
      const db = createDatabase();
      const failure = new Error("fixed native owner failed");
      const retainer = vi.fn();
      const observed = vi.fn();
      const order: string[] = [];
      expect(() =>
        withSqlitePostCommitPublications(
          db,
          () =>
            runSqliteImmediateTransactionSync(db, () => {
              db.prepare("INSERT INTO entries VALUES (?, ?)").run("root", "written");
              for (const id of ["first", "second"]) {
                stageSqliteTransactionState(db, {
                  stage() {},
                  commit() {
                    order.push(`commit:${id}`);
                    if (id === "first") {
                      throw failure;
                    }
                  },
                  prepareObservers() {
                    order.push(`receipt:${id}`);
                  },
                  rollback() {
                    order.push(`rollback:${id}`);
                  },
                });
              }
              deferSqlitePostCommitPublication(db, observed);
              if (kind === "rollback") {
                throw failure;
              }
            }),
          retainer,
        ),
      ).toThrow(failure);
      expect(retainer).not.toHaveBeenCalled();
      expect(observed).not.toHaveBeenCalled();
      expect(order).toEqual(
        kind === "rollback"
          ? ["rollback:second", "rollback:first"]
          : ["commit:first", "commit:second", "receipt:first", "receipt:second"],
      );
      expect(db.prepare("SELECT id FROM entries").all()).toEqual(
        kind === "rollback" ? [] : [{ id: "root" }],
      );
    },
  );

  it("shares one managed journal across savepoints and replaces it after settlement", () => {
    const db = createDatabase();
    const journals: object[] = [];
    const order: string[] = [];
    const failure = new Error("rollback this scope");
    const stage = (id: string) => {
      expect(
        stageSqliteTransactionState(db, {
          stage(transaction) {
            expect(db.isTransaction).toBe(true);
            journals.push(transaction);
            order.push(`stage:${id}`);
          },
          commit() {
            order.push(`commit:${id}`);
          },
          rollback() {
            order.push(`rollback:${id}`);
          },
        }),
      ).toBe(true);
    };
    const outside = { stage: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    expect(stageSqliteTransactionState(db, outside)).toBe(false);
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries VALUES (?, ?)").run("unmanaged", "refused");
        if (!stageSqliteTransactionState(db, outside)) {
          throw failure;
        }
      }),
    ).toThrow(failure);
    expect(db.prepare("SELECT id FROM entries").all()).toEqual([]);
    withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () => {
        stage("outer");
        expect(() =>
          withSqlitePostCommitPublications(db, () =>
            runSqliteImmediateTransactionSync(db, () => {
              stage("nested");
              throw failure;
            }),
          ),
        ).toThrow(failure);
        stage("survivor");
      }),
    );
    expect(() =>
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          stage("rolled-back-root");
          throw failure;
        }),
      ),
    ).toThrow(failure);
    withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () => {
        stage("following-root");
      }),
    );
    expect(journals).toHaveLength(5);
    expect(journals[1]).toBe(journals[0]);
    expect(journals[2]).toBe(journals[0]);
    expect(journals[3]).not.toBe(journals[0]);
    expect(journals[4]).not.toBe(journals[0]);
    expect(journals[4]).not.toBe(journals[3]);
    expect(stageSqliteTransactionState(db, outside)).toBe(false);
    expect(outside.stage).not.toHaveBeenCalled();
    expect(outside.commit).not.toHaveBeenCalled();
    expect(outside.rollback).not.toHaveBeenCalled();
    expect(order).toEqual([
      "stage:outer",
      "stage:nested",
      "rollback:nested",
      "stage:survivor",
      "commit:outer",
      "commit:survivor",
      "stage:rolled-back-root",
      "rollback:rolled-back-root",
      "stage:following-root",
      "commit:following-root",
    ]);
    expect(db.isTransaction).toBe(false);
  });

  it.each(["commit", "receipt"] as const)(
    "drains all fixed %s owners before reporting a post-COMMIT failure",
    (phase) => {
      const db = createDatabase();
      const failure = new Error("fixed state owner failed");
      const order: string[] = [];
      expect(() =>
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            db.prepare("INSERT INTO entries VALUES (?, ?)").run("committed", "kept");
            for (const id of ["first", "second"]) {
              expect(
                stageSqliteTransactionState(db, {
                  stage() {},
                  commit() {
                    order.push(`commit:${id}`);
                    if (phase === "commit" && id === "first") {
                      throw failure;
                    }
                  },
                  prepareObservers() {
                    order.push(`receipt:${id}`);
                    if (phase === "receipt" && id === "first") {
                      throw failure;
                    }
                  },
                  rollback() {
                    order.push(`rollback:${id}`);
                  },
                }),
              ).toBe(true);
            }
            deferSqlitePostCommitPublication(db, () => order.push("observer"));
          }),
        ),
      ).toThrow(failure);
      expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "committed" }]);
      expect(order).toEqual(["commit:first", "commit:second", "receipt:first", "receipt:second"]);
      expect(db.isTransaction).toBe(false);
    },
  );

  it("rolls back every nested fixed owner without discarding the surviving outer state", () => {
    const db = createDatabase();
    const primary = new Error("child failed");
    const cleanup = new Error("first rollback failed after restoring its state");
    const staged: string[] = [];
    const order: string[] = [];
    const append = (id: string, fail = false) => {
      db.prepare("INSERT INTO entries VALUES (?, ?)").run(id, id);
      stageSqliteTransactionState(db, {
        stage() {
          staged.push(id);
        },
        commit() {
          order.push(`commit:${id}`);
        },
        prepareObservers() {
          order.push(`receipt:${id}`);
        },
        rollback() {
          expect(staged.pop()).toBe(id);
          order.push(`rollback:${id}`);
          if (fail) {
            throw cleanup;
          }
        },
      });
      deferSqlitePostCommitPublication(db, () => order.push(`observer:${id}`));
    };
    withSqlitePostCommitPublications(db, () =>
      runSqliteImmediateTransactionSync(db, () => {
        append("outer");
        let caught: unknown;
        try {
          withSqlitePostCommitPublications(db, () =>
            runSqliteImmediateTransactionSync(db, () => {
              append("child-first");
              append("child-second", true);
              throw primary;
            }),
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AggregateError);
        expect(caught).toMatchObject({ cause: primary, errors: [primary, cleanup] });
        expect(staged).toEqual(["outer"]);
        append("following");
      }),
    );
    expect(db.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([
      { id: "following" },
      { id: "outer" },
    ]);
    expect(order).toEqual([
      "rollback:child-second",
      "rollback:child-first",
      "commit:outer",
      "commit:following",
      "receipt:outer",
      "receipt:following",
      "observer:outer",
      "observer:following",
    ]);
  });

  it("settles all fixed owners before stopping at the first outward observer failure", () => {
    const db = createDatabase();
    const failure = new Error("observer failed");
    const order: string[] = [];
    expect(() =>
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          for (const id of ["first", "second"]) {
            stageSqliteTransactionState(db, {
              stage() {},
              commit() {
                order.push(`commit:${id}`);
              },
              prepareObservers() {
                order.push(`receipt:${id}`);
              },
              rollback() {
                order.push(`rollback:${id}`);
              },
            });
            deferSqlitePostCommitPublication(db, () => {
              order.push(`observer:${id}`);
              if (id === "first") {
                throw failure;
              }
            });
          }
        }),
      ),
    ).toThrow(failure);
    expect(order).toEqual([
      "commit:first",
      "commit:second",
      "receipt:first",
      "receipt:second",
      "observer:first",
    ]);
  });

  it.each(["commit", "rollback"] as const)(
    "does not attach retained publications to a new transaction after %s",
    (outcome) => {
      const db = createDatabase();
      const outside = captureSqlitePostCommitPublication(db);
      let captured = outside;
      const published: string[] = [];
      const failure = new Error("original transaction rolled back");
      let originalError: unknown;
      let accepted: boolean | undefined;
      try {
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            captured = captureSqlitePostCommitPublication(db);
            accepted = captured(() => {
              published.push("original");
            });
            if (outcome === "rollback") {
              throw failure;
            }
          }),
        );
      } catch (caught) {
        originalError = caught;
      }
      let retainedAccepted: boolean | undefined;
      let outsideAccepted: boolean | undefined;
      withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(db, () => {
          retainedAccepted = captured(() => {
            published.push("retained");
          });
          outsideAccepted = outside(() => {
            published.push("outside");
          });
          deferSqlitePostCommitPublication(db, () => {
            published.push("new");
          });
        }),
      );
      expect(originalError).toBe(outcome === "rollback" ? failure : undefined);
      expect(accepted).toBe(true);
      expect(retainedAccepted).toBe(false);
      expect(outsideAccepted).toBe(false);
      expect(published).toEqual(outcome === "commit" ? ["original", "new"] : ["new"]);
    },
  );
});
