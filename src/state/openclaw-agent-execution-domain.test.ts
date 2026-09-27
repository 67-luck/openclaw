import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "../infra/sqlite-post-commit.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createAgentDatabaseCommandOwner } from "./openclaw-agent-execution-commands.js";
import type { AgentDatabaseOperations } from "./openclaw-agent-execution-contract.js";
import {
  createAgentDatabaseDomainOwner,
  prepareAgentDatabaseScopedDomains,
} from "./openclaw-agent-execution-domain.js";

const fixture = {
  failure: new Error("child native cleanup failed"),
  phase: "settlement" as "settlement" | "close",
  staged: [] as string[],
  order: [] as string[],
  prepareRead: undefined as (() => Promise<void>) | undefined,
  prepareDomain: undefined as ((take: () => unknown) => void) | undefined,
};
const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata).href;

// Only the domain's synchronous cleanup is faulted. Its nested SQL/savepoint and
// transaction-state owner remain real, so successful execute cannot hide leaked SQL.
// Bind the selected worker URL: native proof uses a compiled module, not its source path.
vi.doMock(moduleUrl, async () => {
  const postCommit = await import("../infra/sqlite-post-commit.js");
  const transaction = await import("../infra/sqlite-transaction.js");
  return {
    bindSqliteWorkerBackend(
      _input: unknown,
      context: { database: DatabaseSync; takePreparation(): unknown },
    ) {
      fixture.order.push("bind");
      let id: string | undefined;
      return {
        prepare(command: { type: string }) {
          fixture.prepareDomain?.(() => context.takePreparation());
          if (command.type === "fixture.read") {
            return fixture.prepareRead?.();
          }
          return undefined;
        },
        execute(command: { type: string; input: { id: string } }) {
          id = command.input.id;
          const current = id;
          if (command.type === "fixture.read") {
            fixture.order.push(`read:${current}`);
            return context.database.prepare("SELECT id FROM entries ORDER BY id").all();
          }
          return postCommit.withSqlitePostCommitPublications(context.database, () =>
            transaction.runSqliteImmediateTransactionSync(context.database, () => {
              context.database.prepare("INSERT INTO entries VALUES (?)").run(current);
              postCommit.stageSqliteTransactionState(context.database, {
                stage() {
                  fixture.staged.push(current);
                },
                commit() {
                  fixture.order.push(`commit:${current}`);
                },
                prepareObservers() {
                  fixture.order.push(`receipt:${current}`);
                },
                rollback() {
                  expect(fixture.staged.pop()).toBe(current);
                  fixture.order.push(`rollback:${current}`);
                },
              });
              postCommit.deferSqlitePostCommitPublication(context.database, () =>
                fixture.order.push(`publish:${current}`),
              );
              fixture.order.push(`execute:${current}`);
              return current;
            }),
          );
        },
        assertSettled() {
          fixture.order.push(`settle:${id}`);
          if (id === "failed" && fixture.phase === "settlement") {
            throw fixture.failure;
          }
        },
        close() {
          fixture.order.push(`close:${id}`);
          if (id === "failed" && fixture.phase === "close") {
            throw fixture.failure;
          }
        },
      };
    },
  };
});

afterEach(() => {
  fixture.prepareRead = undefined;
  fixture.prepareDomain = undefined;
  vi.restoreAllMocks();
});

it.each(["settlement", "close"] as const)(
  "rolls back child SQL and private state when %s fails after execute, then commits a sibling",
  async (phase) => {
    fixture.phase = phase;
    fixture.order.length = 0;
    fixture.staged.length = 0;
    const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
    db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY)");
    const owner = createAgentDatabaseDomainOwner({
      databasePath: ":memory:",
      getPreparedDatabase: () => db,
      assertCurrent: () => db,
      assertCleanupCurrent() {
        expect(db.isOpen).toBe(true);
      },
      takePreparation: () => undefined,
      admit() {},
    });
    try {
      await prepareAgentDatabaseScopedDomains();
      withSqlitePostCommitPublications(db, () =>
        runSqliteDeferredTransactionSync(db, () => {
          stageSqliteTransactionState(db, {
            stage() {},
            commit() {
              fixture.order.push("commit:outer");
            },
            rollback() {
              fixture.order.push("rollback:outer");
            },
          });
          deferSqlitePostCommitPublication(db, () => fixture.order.push("publish:outer"));
          const execute = (id: string) =>
            owner.executeNested(
              {
                type: "database.domain.run",
                input: {
                  id,
                  moduleUrl,
                  input: undefined,
                  command: { type: "fixture.append", input: { id } },
                },
              },
              (retained) => expect(retained).toBe(db),
            );
          let caught: unknown;
          try {
            execute("failed");
          } catch (error) {
            caught = error;
          }
          expect(fixture.order).toEqual([
            "bind",
            "execute:failed",
            "settle:failed",
            "close:failed",
            "rollback:failed",
          ]);
          expect(caught).toBe(fixture.failure);
          expect(db.prepare("SELECT id FROM entries").all()).toEqual([]);
          expect(fixture.staged).toEqual([]);
          expect(execute("following")).toBe("following");
          expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "following" }]);
          expect(fixture.staged).toEqual(["following"]);
          expect(fixture.order.filter((entry) => /^(commit|receipt|publish):/.test(entry))).toEqual(
            [],
          );
        }),
      );
      expect(db.isTransaction).toBe(false);
      expect(fixture.order).toEqual([
        "bind",
        "execute:failed",
        "settle:failed",
        "close:failed",
        "rollback:failed",
        "bind",
        "execute:following",
        "settle:following",
        "close:following",
        "commit:outer",
        "commit:following",
        "receipt:following",
        "publish:outer",
        "publish:following",
      ]);
      runSqliteImmediateTransactionSync(db, () =>
        db.prepare("INSERT INTO entries VALUES ('after')").run(),
      );
      expect(db.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([
        { id: "after" },
        { id: "following" },
      ]);
    } finally {
      try {
        owner.close();
      } finally {
        db.close();
      }
    }
  },
);

it.each(["current", "revoked"] as const)(
  "revalidates read-only domain execution after asynchronous preparation (%s)",
  async (authority) => {
    fixture.order.length = 0;
    const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
    db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY); INSERT INTO entries VALUES ('retained')");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("Domain authority revoked during preparation");
    let current = true;
    const getPreparedDatabase = vi.fn(() => db);
    const assertCurrent = vi.fn(() => {
      fixture.order.push("admission");
      if (!current) {
        throw failure;
      }
      return db;
    });
    const admit = vi.fn(() => {
      throw new Error("Read-only domain unexpectedly requested write authority");
    });
    const owner = createAgentDatabaseDomainOwner({
      databasePath: ":memory:",
      getPreparedDatabase,
      assertCurrent,
      assertCleanupCurrent() {
        expect(db.isOpen).toBe(true);
      },
      takePreparation: () => undefined,
      admit,
    });
    const command = (id: string) => ({
      type: "database.domain.run" as const,
      input: { id, moduleUrl, input: undefined, command: { type: "fixture.read", input: { id } } },
    });
    fixture.prepareRead = async () => {
      fixture.order.push("prepare:read");
      entered.resolve();
      await release.promise;
      fixture.order.push("prepared:read");
    };
    const preparation = owner.prepare(command("original"));
    try {
      await Promise.race([entered.promise, preparation]);
      expect(fixture.order).toEqual(["bind", "prepare:read"]);
      expect(getPreparedDatabase).toHaveBeenCalledOnce();
      expect(assertCurrent).not.toHaveBeenCalled();
      current = authority === "current";
      release.resolve();
      await preparation;
      expect(assertCurrent).not.toHaveBeenCalled();
      if (current) {
        expect(owner.execute(command("original"))).toEqual([{ id: "retained" }]);
        expect(fixture.order).toEqual([
          "bind",
          "prepare:read",
          "prepared:read",
          "admission",
          "read:original",
          "settle:original",
          "close:original",
        ]);
      } else {
        let caught: unknown;
        try {
          owner.execute(command("original"));
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(fixture.order).toEqual([
          "bind",
          "prepare:read",
          "prepared:read",
          "admission",
          "close:undefined",
        ]);
      }
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(admit).not.toHaveBeenCalled();
      expect(db.isTransaction).toBe(false);
      fixture.prepareRead = undefined;
      current = true;
      await owner.prepare(command("sibling"));
      expect(owner.execute(command("sibling"))).toEqual([{ id: "retained" }]);
      expect(fixture.order.slice(-5)).toEqual([
        "bind",
        "admission",
        "read:sibling",
        "settle:sibling",
        "close:sibling",
      ]);
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      expect(getPreparedDatabase).toHaveBeenCalledTimes(2);
      expect(admit).not.toHaveBeenCalled();
      owner.assertSettled();
    } finally {
      release.resolve();
      try {
        await preparation;
      } finally {
        try {
          owner.close();
        } finally {
          db.close();
        }
      }
    }
  },
);

it("retains admission for separate domain bind, execute and close", async () => {
  fixture.order.length = 0;
  const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
  db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY)");
  const assertCurrent = vi.fn(() => {
    fixture.order.push("admission");
    return db;
  });
  const getPreparedDatabase = vi.fn((): never => {
    throw new Error("Separate domain dispatch borrowed preparation authority");
  });
  const owner = createAgentDatabaseDomainOwner({
    databasePath: ":memory:",
    getPreparedDatabase,
    assertCurrent,
    assertCleanupCurrent() {
      expect(db.isOpen).toBe(true);
    },
    takePreparation: () => undefined,
    admit() {},
  });
  const input = { id: "separate", moduleUrl, input: undefined };
  try {
    expect(() => owner.execute({ type: "database.domain.bind", input })).toThrow(
      "Agent publication module was not prepared for this scope",
    );
    expect(fixture.order).toEqual(["admission"]);
    await owner.prepare({ type: "database.domain.bind", input });
    owner.execute({ type: "database.domain.bind", input });
    const execute = {
      type: "database.domain.execute" as const,
      input: { id: input.id, command: { type: "fixture.read", input: { id: input.id } } },
    };
    await owner.prepare(execute);
    expect(owner.execute(execute)).toEqual([]);
    await owner.prepare({ type: "database.domain.close", input });
    owner.execute({ type: "database.domain.close", input });
    expect(fixture.order).toEqual([
      "admission",
      "admission",
      "bind",
      "admission",
      "read:separate",
      "admission",
      "close:separate",
    ]);
    expect(assertCurrent).toHaveBeenCalledTimes(4);
    expect(getPreparedDatabase).not.toHaveBeenCalled();
    owner.assertSettled();
  } finally {
    try {
      owner.close();
    } finally {
      db.close();
    }
  }
});

it("refuses domain preparation without a retained database before binding", async () => {
  fixture.order.length = 0;
  const failure = new Error("Retained database is absent");
  const getPreparedDatabase = vi.fn((): never => {
    throw failure;
  });
  const assertCurrent = vi.fn((): never => {
    throw new Error("Preparation attempted promotion");
  });
  const owner = createAgentDatabaseDomainOwner({
    databasePath: ":memory:",
    getPreparedDatabase,
    assertCurrent,
    assertCleanupCurrent() {
      throw failure;
    },
    takePreparation: () => undefined,
    admit() {},
  });
  try {
    await expect(
      owner.prepare({
        type: "database.domain.run",
        input: {
          id: "absent",
          moduleUrl,
          input: undefined,
          command: { type: "fixture.read", input: { id: "absent" } },
        },
      }),
    ).rejects.toBe(failure);
    expect(getPreparedDatabase).toHaveBeenCalledOnce();
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(fixture.order).toEqual([]);
    owner.assertSettled();
  } finally {
    owner.close();
  }
});

it.each(["unknown", "unprepared"] as const)(
  "does not acquire a database for %s command dispatch",
  (kind) => {
    const forbidden = vi.fn((): never => {
      throw new Error("Unexpected database acquisition");
    });
    const owner = createAgentDatabaseCommandOwner({
      options: { agentId: "main", path: ":memory:" },
      getPreparedDatabase: forbidden,
      assertCurrent: forbidden,
      assertCleanupCurrent: forbidden,
      admit: forbidden,
    });
    const command =
      kind === "unknown"
        ? { type: "fixture.unknown", input: undefined }
        : {
            type: "session.entries.replace",
            input: {
              expectedRows: new Map(),
              labelOwnerKeys: [],
              validationKeys: [],
              replacements: [],
            },
          };
    try {
      // The unknown cell deliberately crosses the runtime command decoder boundary.
      expect(() => owner.execute(command as SqliteWorkerCommand<AgentDatabaseOperations>)).toThrow(
        "Unknown agent database operation",
      );
      expect(forbidden).not.toHaveBeenCalled();
      owner.assertSettled();
    } finally {
      owner.close();
    }
  },
);

it("retains execution and consume-once domain facts across preparation failure and the next job", async () => {
  const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
  db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY)");
  const forbidden = (): never => {
    throw new Error("Unexpected WAL maintenance");
  };
  const database = {
    agentId: "main",
    path: ":memory:",
    db,
    walMaintenance: { checkpoint: forbidden, reclaimFreePages: forbidden, close: forbidden },
  };
  const owner = createAgentDatabaseCommandOwner({
    options: database,
    getPreparedDatabase: () => db,
    assertCurrent: () => database,
    assertCleanupCurrent: () => expect(db.isOpen).toBe(true),
    admit() {},
  });
  const failure = new Error("Original asynchronous preparation failed");
  try {
    const missingOwner = createSqliteWorkerOperationAdmission(() => {}, { domain: "orphan" });
    try {
      withSqliteWorkerOperationAdmission({ port: missingOwner.port }, () => {
        expect(() => owner.beginRequest()).toThrow("requires its request-local preparation facts");
        expect(owner.hasRequest()).toBe(false);
        expect(() => takeSqliteWorkerOperationAdmissionAttachment()).toThrow(
          "attachment is unavailable",
        );
      });
    } finally {
      missingOwner.finish();
    }
    for (const [index, startupJournal] of [false, true, false].entries()) {
      const payload = { operationId: `request-${index}` };
      const domain = index === 2 ? undefined : payload;
      const admission = createSqliteWorkerOperationAdmission(() => {}, {
        kind: "agent-execution",
        startupJournal,
        ...(domain === undefined ? {} : { domain }),
      });
      fixture.prepareDomain = (take) => {
        expect(take()).toEqual(domain);
        expect(() => take()).toThrow("domain preparation is unavailable");
      };
      fixture.prepareRead = startupJournal
        ? async () => {
            throw failure;
          }
        : undefined;
      const command = {
        type: "database.domain.run" as const,
        input: {
          id: payload.operationId,
          moduleUrl,
          input: undefined,
          command: { type: "fixture.read", input: { id: payload.operationId } },
        },
      };
      try {
        withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
          owner.beginRequest();
          expect(() => takeSqliteWorkerOperationAdmissionAttachment()).toThrow(
            "attachment is unavailable",
          );
        });
        expect(owner.startupJournal()).toBe(startupJournal);
        if (startupJournal) {
          await expect(owner.prepare(command)).rejects.toBe(failure);
        } else {
          await owner.prepare(command);
          expect(owner.execute(command)).toEqual([]);
        }
        owner.assertSettled();
      } finally {
        owner.cleanupPublication(payload.operationId);
        owner.endRequest();
        admission.finish();
      }
      expect(owner.hasRequest()).toBe(false);
      expect(() => owner.startupJournal()).toThrow("lost its request-local");
    }
  } finally {
    owner.close();
    db.close();
  }
});

it("restores parent request facts after a nested child's SQL and domain preparation roll back", async () => {
  fixture.phase = "settlement";
  fixture.staged.length = 0;
  const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
  db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY)");
  const forbidden = (): never => {
    throw new Error("Unexpected WAL maintenance");
  };
  const database = {
    agentId: "main",
    path: ":memory:",
    db,
    walMaintenance: { checkpoint: forbidden, reclaimFreePages: forbidden, close: forbidden },
  };
  const owner = createAgentDatabaseCommandOwner({
    options: database,
    getPreparedDatabase: () => db,
    assertCurrent: () => database,
    assertCleanupCurrent: () => expect(db.isOpen).toBe(true),
    admit() {},
  });
  const parent = createSqliteWorkerOperationAdmission(() => {}, {
    kind: "agent-execution",
    startupJournal: true,
    domain: "parent",
  });
  const child = createSqliteWorkerOperationAdmission(() => {}, {
    kind: "agent-execution",
    startupJournal: false,
    domain: "child",
  });
  let parentTake: (() => unknown) | undefined;
  const command = {
    type: "database.domain.run" as const,
    input: {
      id: "parent",
      moduleUrl,
      input: undefined,
      command: { type: "fixture.read", input: { id: "parent" } },
    },
  };
  try {
    await prepareAgentDatabaseScopedDomains();
    withSqliteWorkerOperationAdmission({ port: parent.port }, () => owner.beginRequest());
    fixture.prepareDomain = (take) => {
      parentTake = take;
      expect(take()).toBe("parent");
    };
    await owner.prepare(command);
    fixture.prepareDomain = (take) => {
      expect(owner.startupJournal()).toBe(false);
      expect(take()).toBe("child");
      expect(() => take()).toThrow("domain preparation is unavailable");
    };
    withSqlitePostCommitPublications(db, () =>
      runSqliteDeferredTransactionSync(db, () => {
        withSqliteWorkerOperationAdmission({ port: child.port }, () => {
          expect(() =>
            owner.executeScoped(
              {
                type: "database.domain.run",
                input: {
                  id: "child",
                  moduleUrl,
                  input: undefined,
                  command: { type: "fixture.write", input: { id: "failed" } },
                },
              },
              (retained) => expect(retained).toBe(db),
            ),
          ).toThrow(fixture.failure);
          expect(() => takeSqliteWorkerOperationAdmissionAttachment()).toThrow(
            "attachment is unavailable",
          );
        });
        expect(owner.startupJournal()).toBe(true);
        expect(parentTake).toBeTypeOf("function");
        expect(() => parentTake!()).toThrow("domain preparation is unavailable");
        expect(owner.execute(command)).toEqual([]);
      }),
    );
    expect(fixture.staged).toEqual([]);
    owner.assertSettled();
  } finally {
    owner.endRequest();
    owner.close();
    child.finish();
    parent.finish();
    db.close();
  }
});
