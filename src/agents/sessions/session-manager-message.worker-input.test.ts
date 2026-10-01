import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { assert, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputWorkerAuthority,
  joinSessionPendingInputReceipt,
} from "../../config/sessions/session-accessor.pending-input-receipt.js";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareGatewayPendingInputWorkerAuthority } from "../../gateway/server-methods/session-mutation-guards.js";
import { createOperatorWsClient } from "../../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareSessionInputAuthorization } from "../../gateway/session-sharing-input-capability.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { getUserProfileDisplay, readUserProfileAliases } from "../../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

it.each([false, true])(
  "promotes accepted compressed input with exact worker custody (collected=%s)",
  async (collected) => {
    await withOpenClawTestState({ label: "message-worker-pending" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const fixture = await setup(state);
      const first = await queuedInput(fixture, cfg, "first", "approved ".repeat(16_000));
      const second = collected
        ? await queuedInput(fixture, cfg, "second", "second ".repeat(16_000))
        : undefined;
      const receipt = second
        ? bindSessionPendingInputSources([first.receipt, second.receipt], {
            role: "user",
            content: "collected ".repeat(16_000),
            timestamp: 1,
            idempotencyKey: "collected:user",
          })!
        : first.receipt;
      const failures: unknown[] = [];
      try {
        const sql = observeHostDataSql(state.env);
        let outcome: SessionMessageAppendOutcome;
        try {
          outcome = await receipt.run(() =>
            fixture.runtime.append({
              message: castAgentMessage({
                ...receipt.message,
                content: "mutable candidate must not replace accepted bytes",
              }),
            }),
          );
        } finally {
          sql.restore();
        }
        const accepted = committed(outcome);
        expect(accepted.failures).toEqual([]);
        expect(accepted.value?.message).toEqual(receipt.message);
        expect(accepted.facts.receipt.messageId).toBe(receipt.inputId);
        expect(first.prepare).toHaveBeenCalledOnce();
        if (second) {
          expect(second.prepare).toHaveBeenCalledOnce();
        }
        expect(sql.queries).toEqual([]);
        const database = openOpenClawAgentDatabase({
          agentId: "main",
          path: fixture.scope.storePath,
        });
        const physical = database.db
          .prepare(
            "SELECT event.event_json, event.event_zstd FROM transcript_events AS event JOIN transcript_event_identities AS identity ON identity.session_id = event.session_id AND identity.seq = event.seq WHERE identity.session_id = ? AND identity.event_id = ?",
          )
          .get(fixture.scope.sessionId, receipt.inputId);
        expect(physical?.event_json).toBeNull();
        expect(physical?.event_zstd).toBeInstanceOf(Uint8Array);
        const compressed = physical?.event_zstd;
        assert(compressed instanceof Uint8Array);
        expect(compressed.byteLength).toBeGreaterThan(0);
        const before = fixture.rows();
        await first.work.release();
        await second?.work.release();
        const replay = committed(
          await withSessionPendingInputPersistence(receipt, () =>
            fixture.runtime.append({ message: castAgentMessage(receipt.message) }),
          ),
        );
        expect(replay.facts.receipt.appended).toBe(false);
        expect(fixture.rows()).toEqual(before);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const cleanup of [
          () => first.work.release(),
          () => second?.work.release(),
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
        throw new AggregateError(failures, "Accepted input fixture failed");
      }
    });
  },
);

it("refuses copied authorization objects and copied pending receipts", async () => {
  await withOpenClawTestState({ label: "message-worker-copied-authority" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await setup(state);
    const input = await queuedInput(fixture, cfg, "copied");
    const foreign = await setup(state, "other");
    let foreignReceipt: Awaited<ReturnType<typeof stageSessionPendingInput>>;
    let physicalAuthority: Awaited<ReturnType<typeof prepareGatewayPendingInputWorkerAuthority>>;
    const failures: unknown[] = [];
    try {
      const original = input.handler.sessionMutationAuthorization!;
      const copied = Object.create(
        Object.getPrototypeOf(original),
        Object.getOwnPropertyDescriptors(original),
      );
      expect(await prepareSessionInputAuthorization(copied)).toBeUndefined();
      const forged = Object.create(
        Object.getPrototypeOf(input.authority),
        Object.getOwnPropertyDescriptors(input.authority),
      );
      expect(() => bindSessionPendingInputWorkerAuthority({ ...input.receipt }, forged)).toThrow(
        "original worker authority",
      );
      expect(() =>
        Reflect.construct(Object.getPrototypeOf(input.authority).constructor, [Symbol("copied")]),
      ).toThrow("original Gateway producer");
      expect(() =>
        Reflect.construct(Object.getPrototypeOf(input.lifetime).constructor, [
          Symbol("copied"),
          () => {},
        ]),
      ).toThrow("original admission owner");
      const prepared = await prepareSessionInputAuthorization(original);
      expect(prepared).toBeDefined();
      try {
        expect(() =>
          Reflect.construct(Object.getPrototypeOf(prepared).constructor, [
            Symbol("copied"),
            prepared!.workerRead,
            () => {},
            () => {},
          ]),
        ).toThrow("original resolver");
      } finally {
        prepared?.release();
      }
      const originalAuthority = await prepareGatewayPendingInputWorkerAuthority(
        input.handler,
        input.lifetime,
      );
      expect(originalAuthority).toBeDefined();
      expect(bindSessionPendingInputWorkerAuthority({ ...input.receipt }, originalAuthority!)).toBe(
        false,
      );
      const copiedRead = input.authority.workerRead;
      copiedRead.expected.sessionId = "foreign-session";
      expect(input.authority.workerRead.expected.sessionId).toBe(fixture.scope.sessionId);
      foreignReceipt = await stageSessionPendingInput(foreign.scope, {
        runId: "foreign",
        message: { role: "user", content: "foreign", timestamp: 1, idempotencyKey: "foreign:user" },
        assertCurrent: () => {},
      });
      physicalAuthority = await prepareGatewayPendingInputWorkerAuthority(
        input.handler,
        input.lifetime,
      );
      expect(() =>
        bindSessionPendingInputWorkerAuthority(foreignReceipt!, physicalAuthority!),
      ).toThrow("another physical session");
      const before = fixture.rows();
      const outcome = await fixture.runtime.append({
        message: castAgentMessage({ ...input.receipt.message }),
      });
      expect(outcome.kind).toBe("not-committed");
      expect(fixture.rows()).toEqual(before);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const cleanup of [
        () => physicalAuthority?.release(),
        () => foreignReceipt?.finish("interrupted"),
        () => input.work.release(),
        () => fixture.runtime.close(),
        () => foreign.runtime.close(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Copied input fixture failed");
    }
  });
});

it.each([
  { boundary: "transaction grant", mode: 6, committed: false },
  { boundary: "commit grant", mode: 2, committed: false },
  { boundary: "native rollback", mode: 4, committed: false },
  { boundary: "native commit", mode: 1, committed: true },
])("joins input finish after the held $boundary without host SQL", async (cell) => {
  await withOpenClawTestState({ label: "message-worker-pending-finish" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await setup(state);
    const input = await queuedInput(fixture, cfg, "held-finish");
    let operation: Promise<SessionMessageAppendOutcome> | undefined;
    let joined: Promise<void> | undefined;
    const failures: unknown[] = [];
    const before = fixture.rows();
    const control = arm(fixture.owner.databasePath, cell.mode);
    const sql = observeHostDataSql(state.env);
    try {
      operation = input.receipt.run(() =>
        fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
      );
      await reachBarrier(operation);
      input.receipt.finish("cancelled");
      joined = joinSessionPendingInputReceipt(input.receipt);
      expect(joined).toBeInstanceOf(Promise);
      expect(input.admission.isActive()).toBe(true);
      releaseBarrier();
      const outcome = await operation;
      expect(outcome.kind).toBe(cell.committed ? "committed" : "not-committed");
      await joined;
      expect(sql.queries).toEqual([]);
      // Either promotion committed, or its rollback was followed by the exact disposition write.
      expect(Atomics.load(control, 4)).toBe(1);
      sql.restore();
      const after = fixture.rows();
      expect(after.length - before.length).toBe(cell.committed ? 2 : 0);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: fixture.scope.storePath,
      });
      expect(
        database.db
          .prepare("SELECT state FROM session_pending_inputs WHERE input_id = ?")
          .all(input.receipt.inputId),
      ).toEqual(cell.committed ? [] : [{ state: "cancelled" }]);
    } catch (error) {
      failures.push(error);
    } finally {
      releaseBarrier();
      sql.restore();
      const cleanupJoins: Array<void | Promise<unknown>> = [operation, joined];
      for (const cleanup of [() => input.work.release(), () => fixture.runtime.close()]) {
        try {
          cleanupJoins.push(cleanup());
        } catch (error) {
          failures.push(error);
        }
      }
      for (const result of await Promise.allSettled(
        cleanupJoins.map((join) => Promise.resolve(join)),
      )) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Input finish fixture failed");
    }
  });
});

it("refuses an unreported duplicate in an unchanged searched store while the final grant is paused", async () => {
  await withOpenClawTestState({ label: "message-worker-external-selection" }, async (state) => {
    const secondary = state.statePath("configured", "agents", "main", "sessions", "sessions.json");
    const cfg = {
      agents: { entries: { main: {} } },
      session: {
        store: state.statePath("configured", "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fixture = await setup(state);
    const otherScope = {
      agentId: "main",
      sessionId: "other",
      sessionKey: "agent:main:other",
      storePath: secondary,
    };
    await replaceSessionEntry(otherScope, { sessionId: "other", updatedAt: 1 });
    const otherPath = resolveOpenClawAgentSqlitePath(
      toDatabaseOptions(resolveSqliteTranscriptScope(otherScope)),
    );
    const input = await queuedInput(fixture, cfg, "late-duplicate");
    const before = fixture.rows();
    const identities = [fixture.scope.storePath, otherPath].map((file) => fs.statSync(file).ino);
    const published: unknown[] = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      published.push(change);
    });
    const external = new DatabaseSync(otherPath);
    let operation: Promise<SessionMessageAppendOutcome> | undefined;
    const failures: unknown[] = [];
    try {
      arm(fixture.owner.databasePath, 2);
      operation = input.receipt.run(() =>
        fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
      );
      await reachBarrier(operation);
      // This independent writer emits no local publication. Both physical files
      // remain the same, so only fresh canonical selection can detect the duplicate.
      external
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) SELECT ?, current_session_id, entry_json, entry_valid, updated_at FROM session_nodes WHERE session_key = ?",
        )
        .run(fixture.scope.sessionKey, otherScope.sessionKey);
      expect([fixture.scope.storePath, otherPath].map((file) => fs.statSync(file).ino)).toEqual(
        identities,
      );
      expect(published).toEqual([]);
      releaseBarrier();
      const outcome = await operation;
      expect(outcome.kind).toBe("not-committed");
      expect(inspect(outcome, { depth: null })).toContain(
        "duplicate rows resolve to canonical session key",
      );
      expect(fixture.rows()).toEqual(before);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: fixture.scope.storePath,
      });
      expect(
        database.db
          .prepare("SELECT state, consumed_event_id FROM session_pending_inputs WHERE input_id = ?")
          .get(input.receipt.inputId),
      ).toEqual({ state: "queued", consumed_event_id: null });
    } catch (error) {
      failures.push(error);
    } finally {
      releaseBarrier();
      const cleanupJoins: Array<void | Promise<unknown>> = [operation];
      for (const cleanup of [
        stop,
        () => external.close(),
        () => input.work.release(),
        () => fixture.runtime.close(),
      ]) {
        try {
          cleanupJoins.push(cleanup());
        } catch (error) {
          failures.push(error);
        }
      }
      for (const result of await Promise.allSettled(
        cleanupJoins.map((join) => Promise.resolve(join)),
      )) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "External selection fixture failed");
    }
  });
});

it.each(["permission", "profile"] as const)(
  "keeps %s refusal inside the physical input COMMIT hook",
  async (reason) => {
    await withOpenClawTestState(
      { label: "message-worker-input-final-authority" },
      async (state) => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          gateway: {
            roles: {
              default: "writer",
              definitions: {
                writer: {
                  scopes: ["operator.read", "operator.write"],
                  agents: "*",
                  sessions: { others: "write" },
                },
                refused: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
              },
            },
          },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const profile = ensureProfileForEmail("queued-authority@example.test");
        const client = createOperatorWsClient();
        client.connect.scopes = ["operator.read", "operator.write"];
        client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: null,
          avatarRevision: getUserProfileDisplay(profile.id).avatarRevision,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        const fixture = await setup(state);
        const input = await queuedInput(fixture, cfg, "final-authority", "accepted", false, client);
        const before = fixture.rows();
        let operation: Promise<SessionMessageAppendOutcome> | undefined;
        const failures: unknown[] = [];
        try {
          const control = arm(fixture.owner.databasePath, reason === "permission" ? 7 : 2);
          operation = input.receipt.run(() =>
            fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
          );
          await reachBarrier(operation);
          // The barrier is the new innermost withCommit call, after the body and
          // ordinary permission repair. These changes must affect its final grant.
          if (reason === "permission") {
            fs.chmodSync(fixture.owner.databasePath, 0o644);
          } else {
            setUserProfileRole(profile.id, "refused");
          }
          const sql = observeHostDataSql(state.env);
          try {
            releaseBarrier();
            const outcome = await operation;
            expect(outcome.kind).toBe("not-committed");
            expect(sql.queries).toEqual([]);
            if (reason === "permission") {
              expect(inspect(outcome, { depth: null })).toContain(
                "message fixture permission refusal",
              );
              expect(Atomics.load(control, 6)).toBeGreaterThan(0);
            }
          } finally {
            sql.restore();
          }
          expect(Atomics.load(control, 4)).toBe(0);
          expect(fixture.rows()).toEqual(before);
        } catch (error) {
          failures.push(error);
        } finally {
          releaseBarrier();
          for (const result of await Promise.allSettled([operation])) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }
          // Remove only the injected permission fault before terminal disposition.
          Atomics.store(new Int32Array(observation.control), 0, 0);
          for (const cleanup of [() => input.work.release(), () => fixture.runtime.close()]) {
            try {
              await cleanup();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Final authority fixture failed");
        }
      },
    );
  },
);

it.each(["membership", "own creator"] as const)(
  "revalidates %s from original prepared identity and worker row facts",
  async (authority) => {
    await withOpenClawTestState({ label: "message-worker-input-policy" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const profile = ensureProfileForEmail("queued-member@example.test");
      const old = ensureProfileForEmail("queued-old-creator@example.test");
      if (authority === "own creator") {
        linkEmail("queued-old-creator@example.test", profile.id);
      }
      const client = createOperatorWsClient();
      client.connect.scopes =
        authority === "own creator"
          ? ["operator.sessions.write"]
          : ["operator.read", "operator.write"];
      client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: null,
        avatarRevision: getUserProfileDisplay(profile.id).avatarRevision,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      const fixture = await setup(
        state,
        "main",
        undefined,
        undefined,
        authority === "own creator"
          ? {
              initialEntry: {
                visibility: "read-only",
                createdActor: { type: "human", source: "profile", id: old.id },
              },
            }
          : undefined,
      );
      if (authority === "membership") {
        await replaceSessionEntry(fixture.scope, {
          sessionId: fixture.scope.sessionId,
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: old.id },
        });
        await addSessionMember(fixture.scope, { identityId: profile.id, addedBy: old.id });
      }
      const inputs: Awaited<ReturnType<typeof queuedInput>>[] = [];
      const failures: unknown[] = [];
      try {
        for (const id of ["allowed", "refused"]) {
          if (authority === "own creator") {
            expect(loadSessionEntry(fixture.scope)?.createdActor).toEqual({
              type: "human",
              source: "profile",
              id: old.id,
            });
            expect(readUserProfileAliases(profile.id).has(old.id)).toBe(true);
          }
          inputs.push(
            await queuedInput(
              fixture,
              cfg,
              id,
              "accepted",
              false,
              client,
              authority === "own creator" ? "operator.sessions.write" : undefined,
            ),
          );
        }
        expect(inputs).toHaveLength(2);
        const [allowed, refused] = inputs;
        if (!allowed || !refused) {
          throw new Error("Missing prepared input policy fixtures");
        }
        const sql = observeHostDataSql(state.env);
        try {
          expect(
            committed(
              await allowed.receipt.run(() =>
                fixture.runtime.append({ message: castAgentMessage(allowed.receipt.message) }),
              ),
            ).failures,
          ).toEqual([]);
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        if (authority === "membership") {
          await removeSessionMember(fixture.scope, profile.id);
        } else {
          const external = new DatabaseSync(fixture.scope.storePath);
          const published = vi.fn();
          const stop = sessionChanges.subscribeFacts(published);
          try {
            const readNode = external.prepare(
              "SELECT session_key, current_session_id, entry_valid, updated_at, entry_json FROM session_nodes WHERE session_key = ?",
            );
            const beforeNode = readNode.get(fixture.scope.sessionKey);
            if (!beforeNode) {
              throw new Error("Missing original input session node");
            }
            expect(beforeNode.current_session_id).toBe(fixture.scope.sessionId);
            const beforeEntry = JSON.parse(String(beforeNode.entry_json)) as Parameters<
              typeof replaceSessionEntry
            >[1];
            // Deliberate out-of-band facts injection, not an ordinary creator rewrite.
            // Native invalidation triggers remain responsible for the changed JSON.
            const changed = external
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdActor.id', ?) WHERE session_key = ? AND current_session_id = ?",
              )
              .run("unrelated-profile", fixture.scope.sessionKey, fixture.scope.sessionId);
            expect(changed.changes).toBe(1);
            const afterNode = readNode.get(fixture.scope.sessionKey);
            expect(afterNode).toEqual({
              ...beforeNode,
              entry_valid: 0,
              entry_json: expect.any(String),
            });
            expect(JSON.parse(String(afterNode?.entry_json))).toEqual({
              ...beforeEntry,
              createdActor: { ...beforeEntry.createdActor, id: "unrelated-profile" },
            });
            expect(
              external
                .prepare(
                  "SELECT session_key FROM session_canonical_validation_pending WHERE session_key = ?",
                )
                .get(fixture.scope.sessionKey),
            ).toEqual({ session_key: fixture.scope.sessionKey });
            expect(published).not.toHaveBeenCalled();
          } finally {
            stop();
            external.close();
          }
        }
        const before = fixture.rows();
        const finalSql = observeHostDataSql(state.env);
        try {
          const outcome = await refused.receipt.run(() =>
            fixture.runtime.append({ message: castAgentMessage(refused.receipt.message) }),
          );
          expect(outcome.kind).toBe("not-committed");
          if (authority === "own creator") {
            expect(inspect(outcome, { depth: null })).toContain("require your own session");
          }
          expect(finalSql.queries).toEqual([]);
        } finally {
          finalSql.restore();
        }
        expect(fixture.rows()).toEqual(before);
      } catch (error) {
        failures.push(error);
      } finally {
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
        throw new AggregateError(failures, "Input policy fixture failed");
      }
    });
  },
);

it("does not replay preacceptance profile callbacks at worker promotion", async () => {
  await withOpenClawTestState({ label: "message-worker-accepted-selection" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const profile = ensureProfileForEmail("accepted-selection@example.test");
    const client = createOperatorWsClient();
    client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: null,
      avatarRevision: getUserProfileDisplay(profile.id).avatarRevision,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    const fixture = await setup(state);
    const input = await queuedInput(fixture, cfg, "selection", "accepted", false, client);
    const binding = input.expectedProfileBinding!;
    const failure = new Error("preacceptance selector must not authorize accepted work");
    const callbacks = [
      vi.spyOn(binding, "assertCurrent"),
      vi.spyOn(binding, "assertMatchesResolvedProfile"),
    ];
    const failures: unknown[] = [];
    try {
      // Only the request-local callbacks are observed here. The recognized
      // profile, request lifetime and worker target validators remain real.
      for (const callback of callbacks) {
        callback.mockImplementation(() => {
          throw failure;
        });
      }
      const sql = observeHostDataSql(state.env);
      try {
        expect(
          committed(
            await input.receipt.run(() =>
              fixture.runtime.append({ message: castAgentMessage(input.receipt.message) }),
            ),
          ).failures,
        ).toEqual([]);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      for (const callback of callbacks) {
        expect(callback).not.toHaveBeenCalled();
      }
    } catch (error) {
      failures.push(error);
    } finally {
      for (const callback of callbacks) {
        callback.mockRestore();
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
      throw new AggregateError(failures, "Accepted selection fixture failed");
    }
  });
});
