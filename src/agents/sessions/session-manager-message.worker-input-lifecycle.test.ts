import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessage,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputSources,
  completeSessionPendingInputReceipt,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import {
  isSessionPendingInputSettlementUnknown,
  withSessionPendingInputRelocation,
} from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { bindMessageWorkerObservation } from "./session-manager-message.worker-observation.test-support.js";
import { committed, setup, queuedInput } from "./session-manager-message.worker.test-support.js";
import type { SessionMessageAppendOutcome } from "./session-message-append-operation.js";

const observation = vi.hoisted(() => ({
  control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8),
  path: new SharedArrayBuffer(4096),
}));
vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  const { createMessageWorkerMock } =
    await import("./session-manager-message.worker-observation.test-support.js");
  return createMessageWorkerMock(actual, observation);
});
const { arm, releaseBarrier, reachBarrier } = bindMessageWorkerObservation(observation);

it("replays a natively promoted closed input without retaining another execution reference", async () => {
  await withOpenClawTestState({ label: "message-worker-native-closed" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await setup(state);
    const input = await queuedInput(fixture, cfg, "native-closed");
    const executionModule = await import("../../state/openclaw-agent-execution.js");
    const release = vi.spyOn(fixture.execution, "release");
    let captures: { mockRestore(): void } | undefined;
    const failures: unknown[] = [];
    try {
      const promoted = await input.receipt.run(() =>
        appendTranscriptMessage(fixture.scope, { message: input.receipt.message }),
      );
      expect(promoted?.messageId).toBe(input.receipt.inputId);
      await input.work.release();
      expect(input.admission.isActive()).toBe(false);
      const before = fixture.rows();
      captures = vi.spyOn(executionModule, "captureOpenClawAgentDatabaseExecution");
      const sql = observeHostDataSql(state.env);
      try {
        const replay = committed(
          await withSessionPendingInputPersistence(input.receipt, () =>
            fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
          ),
        );
        expect(replay.facts.receipt).toMatchObject({
          messageId: input.receipt.inputId,
          appended: false,
        });
        await fixture.runtime.close();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(fixture.rows()).toEqual(before);
      expect(captures).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(() => fixture.execution.assertCurrent()).toThrow("reference is released");
    } catch (error) {
      failures.push(error);
    } finally {
      for (const cleanup of [() => input.work.release(), () => fixture.runtime.close()]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      captures?.mockRestore();
      release.mockRestore();
    }
    if (failures.length) {
      throw new AggregateError(failures, "Native closed input fixture failed");
    }
  });
});

it.each(["result", "write error"] as const)(
  "retains late worker completion %s after the message runtime closes",
  async (kind) => {
    await withOpenClawTestState({ label: "message-worker-late-completion" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const fixture = await setup(state);
      const input = await queuedInput(fixture, cfg, "late-completion", "accepted", true);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: fixture.scope.storePath,
      });
      const failures: unknown[] = [];
      try {
        committed(
          await input.receipt.run(() =>
            fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
          ),
        );
        await fixture.runtime.close();
        expect(input.admission.isActive()).toBe(true);
        if (kind === "write error") {
          database.db.exec(
            "CREATE TRIGGER refuse_worker_completion BEFORE INSERT ON session_input_completions BEGIN SELECT RAISE(ABORT, 'worker completion fixture refusal'); END",
          );
        }
        const expected = buildAgentRunTerminalOutcome({ status: "ok" });
        const sql = observeHostDataSql(state.env);
        try {
          const completion = completeSessionPendingInputReceipt(input.receipt, expected);
          expect(completion).toBeInstanceOf(Promise);
          expect(completeSessionPendingInputReceipt(input.receipt, expected)).toBe(completion);
          if (kind === "result") {
            expect(await completion).toEqual(expected);
          } else {
            let original: unknown;
            try {
              await completion;
            } catch (error) {
              original = error;
            }
            expect(original).toBeInstanceOf(Error);
            expect(inspect(original, { depth: null })).toContain(
              "worker completion fixture refusal",
            );
            await expect(completeSessionPendingInputReceipt(input.receipt, expected)).rejects.toBe(
              original,
            );
          }
          await input.work.release();
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        expect(input.admission.isActive()).toBe(false);
        expect(
          database.db.prepare("SELECT succeeded FROM session_input_completions").all(),
        ).toEqual(kind === "result" ? [{ succeeded: 1 }] : []);
      } catch (error) {
        failures.push(error);
      } finally {
        const cleanups: Array<() => void | Promise<void>> = [
          () => database.db.exec("DROP TRIGGER IF EXISTS refuse_worker_completion"),
          () => input.work.release(),
          () => fixture.runtime.close(),
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Late completion fixture failed");
      }
    });
  },
);

it.each([false, true])(
  "consumes fresh input inside a relocation scope without publishing a relocation (collected=%s)",
  async (collected) => {
    await withOpenClawTestState({ label: "message-worker-fresh-relocation" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const fixture = await setup(state);
      const first = await queuedInput(fixture, cfg, "fresh-first");
      const inputs = [first];
      if (collected) {
        inputs.push(await queuedInput(fixture, cfg, "fresh-second"));
      }
      const receipt = collected
        ? bindSessionPendingInputSources(
            inputs.map((input) => input.receipt),
            {
              role: "user",
              content: "collected fresh input",
              timestamp: 1,
              idempotencyKey: "collected-fresh:user",
            },
          )!
        : first.receipt;
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: fixture.scope.storePath,
      });
      const foreign = new DatabaseSync(fixture.scope.storePath);
      const failures: unknown[] = [];
      try {
        expect(inputs).toHaveLength(collected ? 2 : 1);
        const outcome = committed(
          await receipt.run(() =>
            withSessionPendingInputRelocation(receipt.inputId, receipt.message, () =>
              fixture.runtime.append({
                message: castAgentMessage(receipt.message),
                idempotencyLookup: "caller-checked",
              }),
            ),
          ),
        );
        expect(outcome.failures).toEqual([]);
        expect(outcome.facts.receipt.messageId).toBe(receipt.inputId);
        expect(outcome.facts.pendingInput?.consumedInputIds).toEqual(
          inputs.map((input) => input.receipt.inputId),
        );
        expect(outcome.facts.pendingInput?.relocatedInputId).toBeUndefined();
        const pendingRows = () =>
          database.db
            .prepare("SELECT input_id, consumed_event_id FROM session_pending_inputs ORDER BY seq")
            .all();
        const expectedRows = collected
          ? inputs.map((input) => ({
              input_id: input.receipt.inputId,
              consumed_event_id: receipt.inputId,
            }))
          : [];
        expect(pendingRows()).toEqual(expectedRows);
        foreign.exec("BEGIN IMMEDIATE");
        const sql = observeHostDataSql(state.env);
        try {
          for (const input of inputs) {
            await input.work.release();
            expect(input.admission.isActive()).toBe(false);
          }
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
          foreign.exec("ROLLBACK");
        }
        expect(pendingRows()).toEqual(expectedRows);
      } catch (error) {
        failures.push(error);
      } finally {
        const cleanups: Array<() => void | Promise<void>> = [
          () => {
            if (foreign.isTransaction) {
              foreign.exec("ROLLBACK");
            }
          },
          () => foreign.close(),
          ...inputs.map((input) => () => input.work.release()),
          () => fixture.runtime.close(),
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Fresh relocation fixture failed");
      }
    });
  },
);

it("moves worker input custody only on native relocation COMMIT before publication", async () => {
  await withOpenClawTestState({ label: "message-worker-input-relocation" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await setup(state);
    const input = await queuedInput(fixture, cfg, "relocation");
    let operation: Promise<SessionMessageAppendOutcome> | undefined;
    const failures: unknown[] = [];
    const sentinel = new Error("relocation publication refused");
    const relocate = (id: string, publish = () => {}) =>
      input.receipt.run(() =>
        withSessionPendingInputRelocation(input.receipt.inputId, input.receipt.message, () =>
          fixture.runtime.append(
            {
              message: castAgentMessage(input.receipt.message),
              eventId: id,
              parentId: null,
              idempotencyLookup: "caller-checked",
            },
            {},
            { adopt: () => {}, publish },
          ),
        ),
      );
    try {
      committed(
        await input.receipt.run(() =>
          fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
        ),
      );
      const before = fixture.rows();
      arm(fixture.owner.databasePath, 4);
      operation = relocate("rolled-back");
      await reachBarrier(operation);
      releaseBarrier();
      expect((await operation).kind).toBe("not-committed");
      expect(fixture.rows()).toEqual(before);
      arm(fixture.owner.databasePath);
      const sql = observeHostDataSql(state.env);
      try {
        const outcome = committed(
          await relocate("relocated", () => {
            throw sentinel;
          }),
        );
        expect(outcome.failures).toContain(sentinel);
        expect(outcome.facts.pendingInput?.relocatedInputId).toBe("relocated");
        await input.work.release();
        const replay = committed(
          await withSessionPendingInputPersistence(input.receipt, () =>
            fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
          ),
        );
        expect(replay.facts.receipt).toMatchObject({ appended: false, messageId: "relocated" });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    } catch (error) {
      failures.push(error);
    } finally {
      releaseBarrier();
      for (const result of await Promise.allSettled([operation])) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      for (const cleanup of [() => input.work.release(), () => fixture.runtime.close()]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Input relocation fixture failed");
    }
  });
});

it("refuses one revoked collected source while an unrelated original input waits behind it", async () => {
  await withOpenClawTestState({ label: "message-worker-collected-revocation" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await setup(state);
    const inputs: Awaited<ReturnType<typeof queuedInput>>[] = [];
    let operation: Promise<SessionMessageAppendOutcome> | undefined;
    let queued: Promise<SessionMessageAppendOutcome> | undefined;
    const failures: unknown[] = [];
    const before = fixture.rows();
    try {
      for (const id of ["first", "second", "unrelated"]) {
        inputs.push(await queuedInput(fixture, cfg, id));
      }
      expect(inputs).toHaveLength(3);
      const [first, second, unrelated] = inputs;
      if (!first || !second || !unrelated) {
        throw new Error("Missing prepared collected input fixtures");
      }
      const collected = bindSessionPendingInputSources([first.receipt, second.receipt], {
        role: "user",
        content: "collected",
        timestamp: 1,
        idempotencyKey: "aggregate:user",
      })!;
      const control = arm(fixture.owner.databasePath, 2);
      const sql = observeHostDataSql(state.env);
      try {
        operation = collected.run(() =>
          fixture.runtime.append({ message: castAgentMessage(collected.message) }),
        );
        await reachBarrier(operation);
        let unrelatedSettled = false;
        queued = unrelated.receipt.run(() =>
          fixture.runtime.append({ message: castAgentMessage(unrelated.receipt.message) }),
        );
        void queued.then(() => {
          unrelatedSettled = true;
        });
        second.controller.abort();
        expect(unrelatedSettled).toBe(false);
        expect(Atomics.load(control, 4)).toBe(0);
        releaseBarrier();
        expect((await operation).kind).toBe("not-committed");
        expect(committed(await queued).facts.receipt.messageId).toBe(unrelated.receipt.inputId);
        expect(Atomics.load(control, 4)).toBe(1);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      const rows = fixture.rows();
      expect(rows.slice(0, before.length)).toEqual(before);
      expect(rows.filter((row) => JSON.parse(row.eventJson).id === collected.inputId)).toEqual([]);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: fixture.scope.storePath,
      });
      expect(
        database.db
          .prepare(
            "SELECT input_id, consumed_event_id FROM session_pending_inputs ORDER BY input_id",
          )
          .all(),
      ).toEqual(
        [first, second]
          .map((input) => ({ input_id: input.receipt.inputId, consumed_event_id: null }))
          .toSorted((a, b) => a.input_id.localeCompare(b.input_id)),
      );
      expect(
        committed(
          await first.receipt.run(() =>
            fixture.runtime.append({ message: castAgentMessage(first.receipt.message) }),
          ),
        ).facts.receipt.messageId,
      ).toBe(first.receipt.inputId);
    } catch (error) {
      failures.push(error);
    } finally {
      releaseBarrier();
      for (const result of await Promise.allSettled([operation, queued])) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      for (const cleanup of [
        ...inputs.map((input) => () => input.work.release()),
        () => fixture.runtime.close(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Collected input fixture failed");
    }
  });
});

it("mirrors an input without taking its source custody, then promotes the original", async () => {
  await withOpenClawTestState({ label: "message-worker-bound-input" }, async (state) => {
    const cfg = { agents: { entries: { main: {}, other: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const source = await setup(state);
    const target = await setup(state, "other");
    const input = await queuedInput(source, cfg, "bound");
    const failures: unknown[] = [];
    try {
      const mirror = committed(
        await input.receipt.run(() =>
          target.runtime.append({ message: castAgentMessage(input.receipt.message) }),
        ),
      );
      expect(mirror.facts.receipt.messageId).not.toBe(input.receipt.inputId);
      const database = openOpenClawAgentDatabase({ agentId: "main", path: source.scope.storePath });
      expect(
        database.db.prepare("SELECT input_id, consumed_event_id FROM session_pending_inputs").all(),
      ).toEqual([{ input_id: input.receipt.inputId, consumed_event_id: null }]);
      const promoted = committed(
        await input.receipt.run(() =>
          source.runtime.append({ message: castAgentMessage(input.receipt.message) }),
        ),
      );
      expect(promoted.facts.receipt.messageId).toBe(input.receipt.inputId);
      expect(database.db.prepare("SELECT input_id FROM session_pending_inputs").all()).toEqual([]);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const cleanup of [
        () => input.work.release(),
        () => source.runtime.close(),
        () => target.runtime.close(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Bound input fixture failed");
    }
  });
});

it.each(["deleted", "replaced", "off-branch"] as const)(
  "refuses closed input replay when its exact committed message is %s",
  async (change) => {
    await withOpenClawTestState({ label: "message-worker-closed-input" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const fixture = await setup(state);
      const input = await queuedInput(fixture, cfg, "closed");
      const failures: unknown[] = [];
      try {
        committed(
          await input.receipt.run(() =>
            fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
          ),
        );
        await input.work.release();
        const original = {
          type: "message",
          id: input.receipt.inputId,
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: input.receipt.message,
        };
        await replaceTranscriptEvents(
          fixture.scope,
          change === "deleted"
            ? []
            : change === "replaced"
              ? [{ ...original, id: "replacement" }]
              : [
                  original,
                  {
                    ...original,
                    id: "different-branch",
                    message: { role: "user", content: "other", timestamp: 2 },
                  },
                ],
        );
        const before = fixture.rows();
        const sql = observeHostDataSql(state.env);
        try {
          const outcome = await withSessionPendingInputPersistence(input.receipt, () =>
            fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
          );
          expect(outcome.kind).toBe("not-committed");
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        expect(fixture.rows()).toEqual(before);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const cleanup of [() => input.work.release(), () => fixture.runtime.close()]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Closed input fixture failed");
      }
    });
  },
);

it.each(["receipt delivery", "view adoption", "outward publication"] as const)(
  "finishes a committed input under a foreign writer after %s fails",
  async (fault) => {
    await withOpenClawTestState(
      { label: "message-worker-input-committed-failure" },
      async (state) => {
        const cfg = { agents: { entries: { main: {} } } };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const fixture = await setup(state);
        const input = await queuedInput(fixture, cfg, "committed-failure");
        const publications: string[] = [];
        const sentinel = new Error("input fixture publication refusal");
        const failures: unknown[] = [];
        let foreign: DatabaseSync | undefined;
        try {
          const control = arm(fixture.owner.databasePath, fault === "receipt delivery" ? 3 : 0);
          const outcome = committed(
            await input.receipt.run(() =>
              fixture.runtime.append(
                { message: castAgentMessage(input.receipt.message) },
                {},
                {
                  adopt: () => {
                    publications.push("adopt");
                    if (fault === "view adoption") {
                      throw sentinel;
                    }
                  },
                  publish: () => {
                    publications.push("publish");
                    if (fault === "outward publication") {
                      throw sentinel;
                    }
                  },
                },
              ),
            ),
          );
          expect(outcome.facts.receipt.messageId).toBe(input.receipt.inputId);
          expect(outcome.failures.length).toBeGreaterThan(0);
          expect(publications).toEqual(
            fault === "receipt delivery"
              ? []
              : fault === "view adoption"
                ? ["adopt"]
                : ["adopt", "publish"],
          );
          expect(Atomics.load(control, 4)).toBe(1);
          const before = fixture.rows();
          foreign = new DatabaseSync(fixture.owner.databasePath);
          foreign.exec("BEGIN IMMEDIATE");
          const sql = observeHostDataSql(state.env);
          try {
            await input.work.release();
            expect(sql.queries).toEqual([]);
          } finally {
            sql.restore();
          }
          expect(foreign.isTransaction).toBe(true);
          expect(input.admission.isActive()).toBe(false);
          expect(Atomics.load(control, 4)).toBe(1);
          expect(fixture.rows()).toEqual(before);
          expect(foreign.prepare("SELECT input_id FROM session_pending_inputs").all()).toEqual([]);
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            if (foreign?.isTransaction) {
              foreign.exec("ROLLBACK");
            }
            foreign?.close();
          } catch (error) {
            failures.push(error);
          }
          for (const cleanup of [() => input.work.release(), () => fixture.runtime.close()]) {
            try {
              await cleanup();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Committed input fixture failed");
        }
      },
    );
  },
);

it("retains the original input and terminal custody when COMMIT loses its receipt worker", async () => {
  await withOpenClawTestState({ label: "message-worker-input-unknown" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await setup(state);
    const input = await queuedInput(fixture, cfg, "unknown");
    const before = fixture.rows();
    let operation: Promise<SessionMessageAppendOutcome> | undefined;
    let unknown = false;
    const failures: unknown[] = [];
    const publications: string[] = [];
    const control = arm(fixture.owner.databasePath, 5);
    try {
      operation = input.receipt.run(() =>
        fixture.runtime.append(
          { message: castAgentMessage(input.receipt.message) },
          {},
          {
            adopt: () => {
              publications.push("adopt");
            },
            publish: () => {
              publications.push("publish");
            },
          },
        ),
      );
      await reachBarrier(operation);
      expect(Atomics.load(control, 1)).toBe(1);
      expect(Atomics.load(control, 5)).toBe(1);
      expect(Atomics.load(control, 4)).toBe(1);
      expect(publications).toEqual([]);
      // Native exit occurs before receipt delivery; the original operation
      // joins its failed carrier while keeping input settlement UNKNOWN.
      releaseBarrier();
      const outcome = await operation;
      unknown = outcome.kind === "unknown";
      expect(outcome.kind).toBe("unknown");
      expect(() => input.receipt.run(() => {})).toThrow("Pending input ownership ended");
      expect(() =>
        withSessionPendingInputPersistence(input.receipt, () =>
          fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
        ),
      ).toThrow();
      const sql = observeHostDataSql(state.env);
      try {
        const released = Promise.resolve().then(() => input.work.release());
        expect(await released.then(() => false, isSessionPendingInputSettlementUnknown)).toBe(true);
        expect(
          await Promise.resolve()
            .then(() => input.work.release())
            .then(() => false, isSessionPendingInputSettlementUnknown),
        ).toBe(true);
        expect(
          await fixture.runtime.close().then(() => false, isSessionPendingInputSettlementUnknown),
        ).toBe(true);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(input.admission.isActive()).toBe(true);
      expect(input.device.isCurrent()).toBe(true);
      expect(publications).toEqual([]);
      const after = fixture.rows();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        after.filter((row) => JSON.parse(row.eventJson).id === input.receipt.inputId),
      ).toHaveLength(1);
      expect(Atomics.load(control, 4)).toBe(1);
    } catch (error) {
      failures.push(error);
    } finally {
      releaseBarrier();
      for (const result of await Promise.allSettled([operation])) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      for (const cleanup of [() => input.work.release(), () => fixture.runtime.close()]) {
        try {
          await cleanup();
        } catch (error) {
          if (!unknown || !isSessionPendingInputSettlementUnknown(error)) {
            failures.push(error);
          }
        }
      }
      // The terminated native owner is joined. Logical UNKNOWN custody remains
      // retained; fixture-root teardown does not claim a rollback or recovery.
    }
    if (failures.length) {
      throw new AggregateError(failures, "Unknown input fixture failed");
    }
  });
});
