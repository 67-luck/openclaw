import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { appendTranscriptEventSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { sessionTranscriptIndexNeedsReconcile } from "../../config/sessions/session-transcript-index.js";
import * as transcriptReconcile from "../../config/sessions/session-transcript-reconcile.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../../config/sessions/transcript-tree.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionToolResultPending } from "../session-tool-result-pending.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { bindMessageWorkerObservation } from "./session-manager-message.worker-observation.test-support.js";
import {
  assistant,
  result,
  committed,
  setup,
} from "./session-manager-message.worker.test-support.js";
import { appendSessionTranscriptNote } from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
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

it("keeps original pending facts and tokens through live same-transaction growth", () => {
  const pending = createSessionToolResultPending();
  const owner = { databasePath: "/fixture/incognito.sqlite", sessionId: "growth" };
  pending
    .capture(owner)
    .reserve({
      remove: [],
      add: [{ originId: "original", callIndex: 0, id: "shared" }],
    })
    .commit();
  const original = pending.calls(owner)[0]!;
  const transaction = {};
  const parent = pending.capture(owner, transaction);
  const facts = [...parent.facts];
  const child = pending.capture(owner, transaction).reserve({
    remove: [],
    add: [{ originId: "child", callIndex: 0, id: "shared" }],
  });
  let reservation: ReturnType<typeof parent.reserve> | undefined;
  try {
    child.stage();
    const added = pending.calls(owner)[1]!;
    parent.assertCurrent();
    expect(parent.facts).toEqual(facts);
    expect(parent.call(0)).toBe(original);
    expect(parent.token(original)).toBe(0);
    expect(() => parent.token(added)).toThrow("Transcript tool occurrence changed");
    expect(() => parent.reserve({ remove: [1], add: [] })).toThrow(
      "Transcript tool occurrence changed",
    );
    expect(() => pending.capture(owner)).toThrow("Transcript tool occurrence changed");
    expect(() => pending.capture(owner, {})).toThrow("Transcript tool occurrence changed");
    reservation = parent.reserve({ remove: [0], add: [] });
    child.commit();
    expect(() => parent.assertCurrent()).toThrow("Transcript tool occurrence changed");
    // Both grants predate COMMIT. Settling the child cannot revoke the parent receipt.
    reservation.commit();
    expect(pending.calls(owner)).toEqual([added]);
    expect(pending.calls(owner)[0]).toBe(added);
  } finally {
    reservation?.rollback();
    child.rollback();
  }
});

it.each(["missing", "foreign", "committed"] as const)(
  "rejects pending growth without live matching ownership (%s)",
  (kind) => {
    const pending = createSessionToolResultPending();
    const owner = { databasePath: "/fixture/incognito.sqlite", sessionId: "growth" };
    const transaction = {};
    const parent = pending.capture(owner, kind === "missing" ? undefined : transaction);
    const child = pending.capture(owner).stage({
      remove: [],
      add: [{ originId: "child", callIndex: 0, id: "added" }],
    });
    try {
      child.stage(kind === "foreign" ? {} : transaction);
      if (kind === "committed") {
        child.commit();
      }
      expect(() => parent.assertCurrent()).toThrow("Transcript tool occurrence changed");
      expect(() => parent.reserve({ remove: [], add: [] })).toThrow(
        "Transcript tool occurrence changed",
      );
      expect(parent.facts).toEqual([]);
      expect(pending.ids()).toEqual(["added"]);
    } finally {
      child.rollback();
    }
  },
);

it.each(["removal", "replacement"] as const)(
  "rejects changed original pending membership despite same-transaction staging (%s)",
  (kind) => {
    const pending = createSessionToolResultPending();
    const owner = { databasePath: "/fixture/incognito.sqlite", sessionId: "growth" };
    const occurrence = { originId: "original", callIndex: 0, id: "shared" };
    pending
      .capture(owner)
      .reserve({ remove: [], add: [occurrence] })
      .commit();
    const original = pending.calls(owner)[0]!;
    const transaction = {};
    const parent = pending.capture(owner, transaction);
    const child = pending.capture(owner, transaction).reserve({
      remove: [0],
      add: kind === "replacement" ? [occurrence] : [],
    });
    try {
      child.stage();
      expect(() => parent.assertCurrent()).toThrow("Transcript tool occurrence changed");
      expect(() => parent.reserve({ remove: [], add: [] })).toThrow(
        "Transcript tool occurrence changed",
      );
      expect(parent.call(0)).toBe(original);
      if (kind === "replacement") {
        expect(pending.calls(owner)).toEqual([original]);
        expect(pending.calls(owner)[0]).not.toBe(original);
      }
    } finally {
      child.rollback();
    }
    parent.assertCurrent();
    expect(pending.calls(owner)[0]).toBe(original);
  },
);

it("restores exact pending references and attribution through reverse nested rollback", () => {
  const pending = createSessionToolResultPending();
  const owner = { databasePath: "/fixture/incognito.sqlite", sessionId: "growth" };
  pending
    .capture(owner)
    .reserve({
      remove: [],
      add: ["first", "second"].map((id) => ({ originId: id, callIndex: 0, id })),
    })
    .commit();
  const originals = pending.calls(owner);
  const transaction = {};
  const parent = pending.capture(owner, transaction);
  const child = pending.capture(owner, transaction).reserve({
    remove: [],
    add: [{ originId: "child", callIndex: 0, id: "child" }],
  });
  let grandchild: ReturnType<typeof parent.reserve> | undefined;
  try {
    child.stage();
    const added = pending.calls(owner)[2]!;
    grandchild = pending.capture(owner, transaction).reserve({
      remove: [2],
      add: [{ originId: "grandchild", callIndex: 0, id: "grandchild" }],
    });
    grandchild.stage();
    parent.assertCurrent();
    grandchild.rollback();
    parent.assertCurrent();
    expect(pending.calls(owner)[2]).toBe(added);
    child.rollback();
    parent.assertCurrent();
    expect(pending.calls(owner)).toEqual(originals);
    pending.calls(owner).forEach((call, index) => expect(call).toBe(originals[index]));
    const following = pending.capture(owner).stage({
      remove: [],
      add: [{ originId: "following", callIndex: 0, id: "following" }],
    });
    try {
      following.stage({});
      expect(() => parent.assertCurrent()).toThrow("Transcript tool occurrence changed");
    } finally {
      following.rollback();
    }
    parent.assertCurrent();
  } finally {
    grandchild?.rollback();
    child.rollback();
  }
});

it("keeps empty pending reservations owned by their original transaction until settlement", () => {
  const pending = createSessionToolResultPending();
  const owner = { databasePath: "/fixture/incognito.sqlite", sessionId: "retained" };
  const transaction = {};
  const parent = pending.capture(owner, transaction);
  const child = pending.capture(owner, transaction).reserve({ remove: [], add: [] });
  let reservation: ReturnType<typeof parent.reserve> | undefined;
  try {
    child.stage();
    expect(() => pending.capture(owner, {})).toThrow("Transcript tool occurrence changed");
    expect(() => pending.capture(owner)).toThrow("Transcript tool occurrence changed");
    reservation = parent.reserve({ remove: [], add: [] });
    reservation.commit();
    expect(() => pending.capture(owner, {})).toThrow("Transcript tool occurrence changed");
    child.commit();
    expect(pending.capture(owner).facts).toEqual([]);
    expect(pending.size).toBe(0);
  } finally {
    reservation?.rollback();
    child.rollback();
  }
});

it.each(["manager", "target-note"] as const)(
  "keeps the dirty %s projection kick with its original scheduling owner",
  async (kind) => {
    await withOpenClawTestState({ label: "message-worker-reconcile-owner" }, async (state) => {
      const fixture = await setup(state);
      const kick = vi.spyOn(transcriptReconcile, "startSessionTranscriptIndexReconcile");
      try {
        committed(
          await fixture.runtime.append({
            message: { role: "user", content: "retained root", timestamp: 1 },
            eventId: "root",
          }),
        );
        await waitForSessionTranscriptProjection(fixture.scope);
        const dirty = vi.fn();
        expect(
          appendTranscriptEventSnapshotSync(
            fixture.scope,
            {
              type: "custom",
              id: "side",
              parentId: "root",
              appendMode: "side",
              timestamp: "2026-01-01T00:00:00.000Z",
              customType: "side-observation",
              data: { observed: true },
            },
            {},
            { scheduleProjectionReconcile: false, onProjectionReconcileNeeded: dirty },
          ),
        ).toMatchObject({ ok: true, value: { result: { appended: true } } });
        expect(dirty).toHaveBeenCalledOnce();
        const database = openOpenClawAgentDatabase({
          agentId: fixture.scope.agentId,
          path: fixture.scope.storePath,
          env: state.env,
        });
        expect(sessionTranscriptIndexNeedsReconcile(database.db, fixture.scope.sessionId)).toBe(
          true,
        );
        kick.mockClear();
        const message = {
          role: "custom" as const,
          customType: "openclaw.system-note",
          content: "append after dirty side entry",
          display: true,
          timestamp: 2,
          idempotencyKey: "dirty-owner-note",
        };
        if (kind === "manager") {
          const outcome = committed(await fixture.runtime.append({ message }));
          expect(outcome.failures).toEqual([]);
          expect(outcome.facts.projectionNeedsReconcile).toBe(true);
          expect(kick).not.toHaveBeenCalled();
        } else {
          expect(await appendSessionTranscriptNote(fixture.scope, message)).toMatchObject({
            appended: true,
            currentTail: true,
            message,
          });
          expect(kick).toHaveBeenCalledExactlyOnceWith({
            agentId: fixture.scope.agentId,
            path: fixture.scope.storePath,
            env: expect.objectContaining({ OPENCLAW_STATE_DIR: state.stateDir }),
            preferredSessionId: fixture.scope.sessionId,
          });
        }
      } finally {
        kick.mockRestore();
        await fixture.runtime.close();
      }
    });
  },
);

it("replays an off-path target note without granting an empty manager cohort its missing anchor", async () => {
  await withOpenClawTestState({ label: "message-worker-note-owner" }, async (state) => {
    const fixture = await setup(state);
    try {
      const manager = SessionManager.open(fixture.scope);
      const root = manager.appendMessage({
        role: "user",
        content: "retained branch",
        timestamp: 1,
      });
      const note = {
        role: "custom" as const,
        customType: "openclaw.system-note",
        content: "historical branch note",
        display: true,
        timestamp: 2,
        idempotencyKey: "off-path-note",
      };
      const first = await appendSessionTranscriptNote(fixture.scope, note);
      expect(first).toMatchObject({ appended: true, currentTail: true, message: note });
      // Use the current mutation fence while preserving the original manager's retained view.
      const control = SessionManager.open(fixture.scope).appendLeafControl({
        targetId: root,
        appendParentId: root,
      });
      await waitForSessionTranscriptProjection(fixture.scope);
      const before = loadTranscriptReadSnapshotSync(fixture.scope);
      const rows = fixture.rows();
      const tree = scanSessionTranscriptTree(before.events);
      expect(before.events).toContainEqual(control);
      expect(tree.leafId).toBe(root);
      expect(before.events).toContainEqual(
        expect.objectContaining({ id: first.messageId, message: note }),
      );
      expect(
        selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((entry) => entry.id),
      ).not.toContain(first.messageId);
      expect(
        readActiveTranscriptEntryAnchor({ ...fixture.scope, entryId: first.messageId }),
      ).toBeUndefined();
      const view = () => ({
        entries: manager.getEntries(),
        leaf: manager.getLeafId(),
        parent: manager.getAppendParentId(),
        mode: manager.getAppendMode(),
        context: manager.buildSessionContext(),
      });
      const beforeView = view();
      const pending = fixture.pending.capture(fixture.owner);
      expect(pending.facts).toEqual([]);
      const open = vi.spyOn(SessionManager, "open");
      const adopt = vi.fn();
      const publish = vi.fn();
      try {
        expect(await appendSessionTranscriptNote(fixture.scope, note)).toEqual({
          ...first,
          appended: false,
          currentTail: false,
        });
        expect(open).not.toHaveBeenCalled();
        expect(loadTranscriptReadSnapshotSync(fixture.scope)).toEqual(before);
        expect(fixture.rows()).toEqual(rows);
        expect(view()).toEqual(beforeView);
        pending.assertCurrent();

        const refused = await fixture.runtime.append({ message: note }, {}, { adopt, publish });
        expect(refused.kind).toBe("not-committed");
        if (refused.kind !== "not-committed") {
          throw new Error("Manager replay must retain its active-anchor requirement");
        }
        expect(refused.error).toMatchObject({
          message: expect.stringContaining("SQLite transcript changed"),
        });
        expect(adopt).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(loadTranscriptReadSnapshotSync(fixture.scope)).toEqual(before);
        expect(fixture.rows()).toEqual(rows);
        expect(view()).toEqual(beforeView);
        expect(fixture.pending.ids()).toEqual([]);
        pending.assertCurrent();
      } finally {
        open.mockRestore();
      }
    } finally {
      releaseBarrier();
      await fixture.runtime.close();
    }
  });
});

it.each(["fresh", "replay", "mismatched scope"] as const)(
  "settles %s exact occurrences on the native writer",
  async (mode) => {
    await withOpenClawTestState({ label: "message-worker-receipt" }, async (state) => {
      const fixture = await setup(state, "main", undefined, undefined, {
        scopePath:
          mode === "replay" ? "default" : mode === "mismatched scope" ? "mismatched" : undefined,
      });
      arm(fixture.owner.databasePath);
      try {
        if (mode === "mismatched scope") {
          const before = fixture.rows();
          const outcome = await fixture.runtime.append({
            message: assistant(),
            eventId: "refused",
          });
          expect(outcome.kind).toBe("not-committed");
          expect(fixture.rows()).toEqual(before);
          expect(fixture.pending.ids()).toEqual([]);
          expect(fs.existsSync(path.join(state.agentDir("foreign"), "openclaw-agent.sqlite"))).toBe(
            false,
          );
          return;
        }
        const seeded = committed(
          await fixture.runtime.append({ message: assistant(), eventId: "assistant" }),
        );
        expect(seeded.failures).toEqual([]);
        expect(fixture.pending.ids()).toEqual(["shared"]);
        // The replay command exceeds the inline frame threshold, not the facts envelope.
        const message = result(
          mode === "replay" ? "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES + 1024) : "result",
        );
        if (mode === "replay") {
          await appendTranscriptMessage(fixture.scope, {
            message,
            eventId: "result",
            parentId: "assistant",
          });
        }
        const before = fixture.rows();
        const publications: string[][] = [];
        const sql = observeHostDataSql(state.env);
        let outcome: SessionMessageAppendOutcome;
        try {
          outcome = await fixture.runtime.append(
            { message, eventId: "result", parentId: "assistant" },
            {},
            {
              adopt: () => publications.push(["adopt", ...fixture.pending.ids()]),
              publish: () => publications.push(["publish", ...fixture.pending.ids()]),
            },
          );
        } finally {
          sql.restore();
        }
        const receipt = committed(outcome);
        expect(receipt.failures).toEqual([]);
        expect(receipt.facts.receipt).toMatchObject({
          appended: mode === "fresh",
          messageId: "result",
          effectiveParentId: "assistant",
        });
        expect(receipt.facts.delta.remove).toEqual([0]);
        expect(receipt.value?.message).toEqual(message);
        expect(sql.queries).toEqual([]);
        expect(Atomics.load(new Int32Array(observation.control), 3)).toBeGreaterThan(0);
        expect(fixture.pending.ids()).toEqual([]);
        expect(publications).toEqual([["adopt"], ["publish"]]);
        const after = fixture.rows();
        if (mode === "replay") {
          expect(after).toEqual(before);
        }
        const repeated = committed(
          await fixture.runtime.append({ message, parentId: "assistant" }),
        );
        expect(repeated.facts.receipt.appended).toBe(false);
        expect(repeated.facts.delta).toEqual({ remove: [], add: [] });
        expect(fixture.rows()).toEqual(after);
      } finally {
        await fixture.runtime.close();
      }
    });
  },
);

it.each(["commit", "rollback"] as const)(
  "preserves independent custody across a reserved native %s",
  async (mode) => {
    await withOpenClawTestState({ label: "message-worker-reservation" }, async (state) => {
      const pending = createSessionToolResultPending();
      const a = await setup(state, "main", pending);
      const b = await setup(state, "other", pending);
      let operation: Promise<SessionMessageAppendOutcome> | undefined;
      let independentOperation: Promise<SessionMessageAppendOutcome> | undefined;
      const failures: unknown[] = [];
      try {
        committed(await a.runtime.append({ message: assistant(), eventId: "a" }), {
          phase: "A seed",
        });
        const originalA = pending.capture(a.owner).call(0);
        committed(
          await b.runtime.append({
            message: { role: "user", content: "initialize", timestamp: 1 },
            eventId: "b-user",
          }),
          { phase: "B seed" },
        );
        committed(
          await b.runtime.append({
            message: assistant(),
            eventId: "b-prior",
            parentId: "b-user",
          }),
          { phase: "B pending seed" },
        );
        const originalB = pending.capture(b.owner).call(0);
        const beforeB = b.rows();
        expect(pending.capture(b.owner).facts).toMatchObject([
          { originId: "b-prior", name: "read" },
        ]);
        const before = a.rows();
        const control = arm(a.owner.databasePath, mode === "commit" ? 1 : 4);
        const publications: Array<{ phase: string; commits: number }> = [];
        operation = a.runtime.append(
          { message: result(), eventId: "a-result", parentId: "a" },
          {},
          {
            adopt: () => {
              publications.push({ phase: "adopt", commits: Atomics.load(control, 4) });
            },
            publish: () => {
              publications.push({ phase: "publish", commits: Atomics.load(control, 4) });
            },
          },
        );
        await reachBarrier(operation);
        expect(publications).toEqual([]);
        expect(pending.ids()).toEqual(["shared", "shared"]);
        expect(() => pending.capture(a.owner)).toThrow("Transcript tool occurrence changed");
        expect(() => pending.clear()).toThrow("Transcript tool occurrence changed");
        expect(pending.capture(b.owner).call(0)).toBe(originalB);
        independentOperation = b.runtime.append({
          message: assistant("write"),
          eventId: "b-call",
          parentId: "b-prior",
        });
        // B may queue behind A on the same carrier. Submission must not make
        // releasing A depend on B's native completion.
        releaseBarrier();
        const [outcome, independentOutcome] = await Promise.all([operation, independentOperation]);
        const independent = committed(independentOutcome, {
          phase: "independent B",
          native: Array.from(control),
        });
        expect(independent.failures).toEqual([]);
        expect(independent.facts.receipt).toMatchObject({
          appended: true,
          messageId: "b-call",
          effectiveParentId: "b-prior",
        });
        expect(independent.facts.delta).toEqual({
          remove: [],
          add: [{ originId: "b-call", callIndex: 0, id: "shared", name: "write", responseIds: [] }],
        });
        const bRows = b.rows();
        expect(bRows.slice(0, beforeB.length)).toEqual(beforeB);
        expect(bRows).toHaveLength(beforeB.length + 1);
        expect(bRows.map((row) => JSON.parse(row.eventJson).id)).toContain("b-call");
        expect(outcome.kind).toBe(mode === "commit" ? "committed" : "not-committed");
        expect(pending.ids()).toEqual(
          mode === "commit" ? ["shared", "shared"] : ["shared", "shared", "shared"],
        );
        expect(pending.capture(b.owner).facts).toMatchObject([
          { originId: "b-prior", name: "read" },
          { originId: "b-call", name: "write" },
        ]);
        expect(pending.capture(b.owner).call(0)).toBe(originalB);
        expect(pending.capture(b.owner).call(1)).not.toBe(originalB);
        expect(b.rows()).toEqual(bRows);
        expect(publications).toEqual(
          mode === "commit"
            ? [
                { phase: "adopt", commits: 1 },
                { phase: "publish", commits: 1 },
              ]
            : [],
        );
        if (mode === "rollback") {
          expect(a.rows()).toEqual(before);
          expect(pending.capture(a.owner).facts).toMatchObject([{ originId: "a", name: "read" }]);
          expect(pending.capture(a.owner).call(0)).toBe(originalA);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        releaseBarrier();
        for (const outcome of await Promise.allSettled([operation, independentOperation])) {
          if (outcome.status === "rejected") {
            failures.push(outcome.reason);
          }
        }
        for (const outcome of await Promise.allSettled([a.runtime.close(), b.runtime.close()])) {
          if (outcome.status === "rejected") {
            failures.push(outcome.reason);
          }
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Message fixture and lifecycle cleanup failed");
      }
    });
  },
);

it.each(["receipt delivery", "view adoption", "outward publication"] as const)(
  "retains committed custody after %s fails",
  async (fault) => {
    await withOpenClawTestState({ label: "message-worker-committed-failure" }, async (state) => {
      const fixture = await setup(state);
      const publications: string[] = [];
      const sentinel = new Error("fixture view adoption refusal");
      try {
        committed(await fixture.runtime.append({ message: assistant(), eventId: "assistant" }));
        arm(fixture.owner.databasePath, fault === "receipt delivery" ? 3 : 0);
        const outcome = committed(
          await fixture.runtime.append(
            { message: result(), eventId: "result", parentId: "assistant" },
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
        );
        expect(outcome.facts.receipt.messageId).toBe("result");
        expect(outcome.failures.length).toBeGreaterThan(0);
        expect(fixture.pending.ids()).toEqual([]);
        expect(fixture.rows().map((row) => JSON.parse(row.eventJson).id)).toContain("result");
        expect(Atomics.load(new Int32Array(observation.control), 4)).toBe(1);
        expect(publications).toEqual(
          fault === "view adoption"
            ? ["adopt"]
            : fault === "outward publication"
              ? ["adopt", "publish"]
              : [],
        );
        const retained = fixture.rows();
        const next = {
          message: { role: "user" as const, content: "next", timestamp: 2 },
          eventId: "next",
          parentId: "result",
        };
        if (fault === "outward publication") {
          expect(outcome.failures).toContain(sentinel);
          expect(committed(await fixture.runtime.append(next)).failures).toEqual([]);
        } else {
          expect(() => fixture.runtime.append(next)).toThrow("Reload the committed transcript");
          expect(fixture.rows()).toEqual(retained);
          if (fault === "view adoption") {
            expect(outcome.failures).toContain(sentinel);
          }
        }
      } finally {
        await fixture.runtime.close();
      }
    });
  },
);

it("rolls back a revoked source before native COMMIT without retiring custody", async () => {
  await withOpenClawTestState({ label: "message-worker-revoked" }, async (state) => {
    const sentinel = new Error("fixture source revoked");
    let revoked = false;
    const fixture = await setup(state, "main", undefined, () => {
      if (revoked) {
        throw sentinel;
      }
    });
    let operation: Promise<SessionMessageAppendOutcome> | undefined;
    try {
      committed(await fixture.runtime.append({ message: assistant(), eventId: "assistant" }));
      const before = fixture.rows();
      arm(fixture.owner.databasePath, 2);
      operation = fixture.runtime.append({
        message: result(),
        eventId: "result",
        parentId: "assistant",
      });
      await reachBarrier(operation);
      revoked = true;
      releaseBarrier();
      expect((await operation).kind).toBe("not-committed");
      expect(fixture.rows()).toEqual(before);
      expect(fixture.pending.ids()).toEqual(["shared"]);
      expect(() => fixture.pending.capture(fixture.owner)).not.toThrow();
      expect(Atomics.load(new Int32Array(observation.control), 4)).toBe(0);
    } finally {
      releaseBarrier();
      await operation;
      await fixture.runtime.close();
    }
  });
});

it("keeps an absent existing store absent", async () => {
  await withOpenClawTestState({ label: "message-worker-missing" }, async (state) => {
    const fixture = await setup(state, "missing", undefined, undefined, { initialize: false });
    try {
      expect(await fixture.runtime.append({ message: assistant() })).toEqual({ kind: "missing" });
      expect(
        ["", "-wal", "-shm"].map((suffix) => fs.existsSync(fixture.scope.storePath + suffix)),
      ).toEqual([false, false, false]);
      expect(fixture.pending.ids()).toEqual([]);
    } finally {
      await fixture.runtime.close();
    }
  });
});

it("validates exact custody after serialization for non-tool replacements", async () => {
  await withOpenClawTestState({ label: "message-worker-custom-custody" }, async (state) => {
    const fixture = await setup(state);
    const custom = castAgentMessage({
      role: "custom",
      customType: "repair-note",
      content: "retired",
      display: false,
      timestamp: 1,
    });
    try {
      committed(await fixture.runtime.append({ message: assistant(), eventId: "assistant" }));
      const repairedCall = fixture.pending.capture(fixture.owner).call(0)!;
      const retired = committed(
        await fixture.runtime.append(
          { message: custom, eventId: "custom", parentId: "assistant" },
          { repairedCall },
        ),
      );
      expect(retired.facts.delta.remove).toEqual([0]);
      expect(fixture.pending.ids()).toEqual([]);
      committed(
        await fixture.runtime.append({ message: assistant(), eventId: "next", parentId: "custom" }),
      );
      const staleCall = fixture.pending.capture(fixture.owner).call(0)!;
      const before = fixture.rows();
      const replacement = Object.assign({}, custom, {
        toJSON() {
          fixture.pending.clear();
          return custom;
        },
      });
      expect(() =>
        fixture.runtime.append(
          { message: replacement, parentId: "next" },
          { repairedCall: staleCall },
        ),
      ).toThrow("Transcript tool occurrence changed");
      expect(fixture.rows()).toEqual(before);
      expect(fixture.pending.ids()).toEqual([]);
      const ordinary = committed(
        await fixture.runtime.append({ message: custom, parentId: "next" }),
      );
      expect(ordinary.facts.delta).toEqual({ remove: [], add: [] });
    } finally {
      await fixture.runtime.close();
    }
  });
});

it("retains exact custody after native COMMIT loses its worker before receipt delivery", async () => {
  await withOpenClawTestState({ label: "message-worker-unknown-custody" }, async (state) => {
    const fixture = await setup(state);
    let operation: Promise<SessionMessageAppendOutcome> | undefined;
    const failures: unknown[] = [];
    try {
      committed(await fixture.runtime.append({ message: assistant(), eventId: "assistant" }));
      const capture = fixture.pending.capture(fixture.owner);
      const before = fixture.rows();
      const control = arm(fixture.owner.databasePath, 5);
      const publications: string[] = [];
      operation = fixture.runtime.append(
        { message: result(), eventId: "result", parentId: "assistant" },
        {},
        {
          adopt: () => {
            publications.push("adopt");
          },
          publish: () => {
            publications.push("publish");
          },
        },
      );
      await reachBarrier(operation);
      expect(Atomics.load(control, 1)).toBe(1);
      expect(Atomics.load(control, 5)).toBe(1);
      expect(Atomics.load(control, 4)).toBe(1);
      expect(publications).toEqual([]);
      expect(() => capture.assertCurrent()).not.toThrow();
      // Release the actual native receipt hook into exit19. The original append
      // joins its failed native generation before returning UNKNOWN.
      releaseBarrier();
      const outcome = await operation;
      expect(outcome.kind).toBe("unknown");
      expect(() => capture.assertCurrent()).not.toThrow();
      expect(fixture.pending.ids()).toEqual(["shared"]);
      expect(() => fixture.pending.clear()).toThrow("Transcript tool occurrence changed");
      expect(() => fixture.pending.capture(fixture.owner)).toThrow(
        "Transcript tool occurrence changed",
      );
      expect(publications).toEqual([]);
      const after = fixture.rows();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
      expect(
        after.map((row) => JSON.parse(row.eventJson).id).filter((id) => id === "result"),
      ).toHaveLength(1);
      expect(Atomics.load(control, 4)).toBe(1);
    } catch (error) {
      failures.push(error);
    } finally {
      releaseBarrier();
      for (const outcome of await Promise.allSettled([operation])) {
        if (outcome.status === "rejected") {
          failures.push(outcome.reason);
        }
      }
      try {
        await fixture.runtime.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Message fixture and native cleanup failed");
    }
  });
});
