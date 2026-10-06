import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import * as entryPatch from "../../config/sessions/session-entry-patch.js";
import { SqliteSessionMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import * as placementContext from "../../gateway/session-worker-placement-context.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { isAgentRunStaleLifecycleError } from "../../infra/agent-lifecycle-error.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ClaimControllerParams = Parameters<typeof createReplyRestartRecoveryClaimController>[0];

function createController(
  params: Pick<ClaimControllerParams, "getEntry" | "getSessionId" | "setEntry"> &
    Partial<ClaimControllerParams>,
) {
  return createReplyRestartRecoveryClaimController({
    agentId: "main",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    isRestartAbort: () => false,
    resolveDeliveryContext: () => undefined,
    ...params,
  });
}

async function createTrackedClaim(
  fields: Partial<InternalSessionEntry> = {},
  params: Partial<ClaimControllerParams> = {},
) {
  const scope = {
    agentId: params.agentId ?? "main",
    storePath:
      params.storePath ?? path.join(tempDirs.make("openclaw-reply-claim-"), "sessions.json"),
    sessionKey: params.sessionKey ?? "agent:main:main",
  };
  let entry: InternalSessionEntry = {
    sessionId: "session",
    updatedAt: 1,
    status: "running",
    restartRecoveryDeliveryRunId: "recovery-run",
    ...fields,
  };
  const sessionId = entry.sessionId;
  await replaceSessionEntry(scope, entry);
  const controller = createController({
    ...scope,
    admissionRunId: "recovery-run",
    getEntry: () => entry,
    getSessionId: () => sessionId,
    setEntry: (next) => {
      entry = next;
    },
    ...params,
  });
  return {
    controller,
    scope,
    current: () => entry,
    read: () => loadSessionEntry(scope),
    update: async (patch: Partial<InternalSessionEntry>) => {
      entry = (await updateSessionEntry(scope, () => patch))!;
    },
  };
}

async function createAcknowledgedClaim() {
  const sourceTurnId = "acknowledged-source";
  const fixture = await createTrackedClaim(
    {
      lifecycleRunId: "recovery-run",
      restartRecoveryDeliveryRequestFingerprint: "acknowledged-fingerprint",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      startedAt: 1,
    },
    { sourceTurnId },
  );
  const entry = fixture.current();
  const transcriptScope = { ...fixture.scope, sessionId: entry.sessionId };
  const recorder = createUserTurnTranscriptRecorder({
    message: {
      role: "user",
      content: "Synthetic acknowledged input",
      timestamp: 1,
      idempotencyKey: `${sourceTurnId}:user`,
    },
    target: { ...transcriptScope, sessionEntry: entry },
    updateMode: "none",
  });
  await recorder.persistApproved();
  expect(recorder.hasPersisted()).toBe(true);
  return { ...fixture, recorder, sourceTurnId, transcriptScope };
}

describe("createReplyRestartRecoveryClaimController", () => {
  describe("placement observations", () => {
    const placementDirs = useStateDatabaseTempDirs();

    async function createPlacementAdmission() {
      const root = placementDirs.make("openclaw-reply-placement-admission-");
      const scope = {
        agentId: "main",
        storePath: path.join(root, "sessions.json"),
        sessionKey: "agent:main:placement",
      };
      const entry: InternalSessionEntry = { sessionId: "placement-session", updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const service = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ path: path.join(root, "placement.sqlite") }),
      });
      await service.startDispatch({
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        sessionId: entry.sessionId,
      });
      const context: placementContext.SessionWorkerPlacementContext = {
        workerSessionPlacementService: service,
      };
      vi.spyOn(placementContext, "resolveSessionWorkerPlacementContext").mockImplementation(
        () => context,
      );
      const sourceTurnId = "placement-source";
      const recorder = createUserTurnTranscriptRecorder({
        message: { role: "user", content: "continue", timestamp: 1, idempotencyKey: sourceTurnId },
        target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
        updateMode: "none",
      });
      await expect(
        recorder.stageApproved?.({ runId: "placement-run", assertCurrent: () => {} }),
      ).resolves.toBe(true);
      const persistApproved = vi.spyOn(recorder, "persistApproved");
      const setEntry = vi.fn();
      let sessionId = entry.sessionId;
      const controller = createController({
        ...scope,
        getEntry: () => entry,
        getSessionId: () => sessionId,
        setEntry,
        sourceTurnId,
      });
      return {
        context,
        controller,
        entry,
        persistApproved,
        recorder,
        scope,
        service,
        setEntry,
        sourceTurnId,
        retarget: () => {
          sessionId = "successor-session";
        },
      };
    }

    it("leaves staged worker input with placement admission without caller-thread SQL", async () => {
      const fixture = await createPlacementAdmission();
      const hostSql = observeHostDataSql();
      try {
        expect(fixture.service.getMany([fixture.entry.sessionId]).size).toBe(1);
        expect(hostSql.queries.length).toBeGreaterThan(0);
        hostSql.calls.forEach((call) => call.mockClear());
        hostSql.queries.length = 0;

        await expect(fixture.controller.admitUserTurn(fixture.recorder)).resolves.toBe("admitted");

        expect(hostSql.queries).toEqual([]);
        expect(fixture.persistApproved).not.toHaveBeenCalled();
        expect(fixture.recorder.hasPersisted()).toBe(false);
        expect(fixture.setEntry).not.toHaveBeenCalled();
      } finally {
        hostSql.restore();
      }
    });

    it("refuses an unavailable placement observation instead of reading synchronously", async () => {
      const fixture = await createPlacementAdmission();
      fixture.context.workerSessionPlacementService = {
        getMany: (ids) => fixture.service.getMany(ids),
      };
      const hostSql = observeHostDataSql();
      try {
        await expect(fixture.controller.admitUserTurn(fixture.recorder)).rejects.toThrow(
          "Worker placement observation service is unavailable",
        );
        expect(hostSql.queries).toEqual([]);
        expect(fixture.persistApproved).not.toHaveBeenCalled();
      } finally {
        hostSql.restore();
      }
    });

    it.each([
      "placement-publication",
      "session-retarget",
      "lifecycle-rotation",
      "service-replacement",
      "service-removal",
      "pending-input-persisted",
      "terminal-source",
    ] as const)("revalidates %s while placement preparation is pending", async (change) => {
      const fixture = await createPlacementAdmission();
      const prepared = createDeferred();
      const resume = createDeferred();
      const prepare = fixture.service.prepareRuntimeRefresh.bind(fixture.service);
      vi.spyOn(fixture.service, "prepareRuntimeRefresh").mockImplementation(async (sessionId) => {
        const observation = await prepare(sessionId);
        prepared.resolve();
        await resume.promise;
        return observation;
      });
      const admission = fixture.controller.admitUserTurn(fixture.recorder);
      const outcome = admission.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          admission,
          "admission settled before placement preparation",
        );
        if (change === "placement-publication") {
          await fixture.service.fail({
            sessionId: fixture.entry.sessionId,
            recoveryError: "placement interrupted",
          });
        } else if (change === "session-retarget") {
          fixture.retarget();
        } else if (change === "lifecycle-rotation") {
          rotateAgentEventLifecycleGeneration();
        } else if (change === "service-replacement") {
          fixture.context.workerSessionPlacementService = { ...fixture.service };
        } else if (change === "service-removal") {
          fixture.context.workerSessionPlacementService = undefined;
        } else if (change === "pending-input-persisted") {
          fixture.recorder.markRuntimePersisted(fixture.recorder.getPendingInputMessage?.());
        } else {
          await updateSessionEntry(fixture.scope, () => ({
            restartRecoveryTerminalRunIds: [fixture.sourceTurnId],
          }));
        }
        resume.resolve();
        const result = await outcome;
        if (change === "terminal-source") {
          expect(result).toBe("duplicate-source");
        } else if (change === "lifecycle-rotation") {
          expect(isAgentRunStaleLifecycleError(result)).toBe(true);
        } else {
          const message = {
            "placement-publication": `Session ${fixture.entry.sessionId} placement authority changed`,
            "session-retarget": "session changed before durable user-turn admission",
            "service-replacement":
              "Worker placement service changed before durable user-turn admission",
            "service-removal":
              "Worker placement service changed before durable user-turn admission",
            "pending-input-persisted":
              "pending user turn changed before durable user-turn admission",
          }[change];
          expect(result).toMatchObject({ message });
        }
        expect(fixture.persistApproved).not.toHaveBeenCalled();
        expect(fixture.setEntry).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await outcome;
      }
    });
  });

  it.each(["session-retarget", "lifecycle-rotation"] as const)(
    "does not adopt a recovery claim after %s while its row read is pending",
    async (change) => {
      const scope = {
        agentId: "ops",
        storePath: path.join(tempDirs.make("openclaw-reply-read-owner-"), "sessions.json"),
        sessionKey: "global",
      };
      const entry: InternalSessionEntry = {
        sessionId: "original-session",
        updatedAt: 1,
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryBeforeAgentReplyState: "handled-reply",
      };
      await replaceSessionEntry(scope, entry);
      const before = loadSessionEntry(scope);
      const operation = createReplyOperation({
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        sessionId: entry.sessionId,
        resetTriggered: false,
      });
      const setEntry = vi.fn();
      const controller = createController({
        ...scope,
        admissionRunId: "recovery-run",
        getEntry: () => entry,
        getSessionId: () => operation.sessionId,
        setEntry,
      });
      const admission = controller.admitUserTurn();
      const outcome = admission.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        if (change === "session-retarget") {
          operation.updateSessionId("successor-session");
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        const failure = await outcome;
        if (change === "session-retarget") {
          expect(failure).toMatchObject({
            message: "session changed before durable user-turn admission",
          });
        } else {
          expect(isAgentRunStaleLifecycleError(failure)).toBe(true);
        }
        expect(setEntry).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)).toEqual(before);
      } finally {
        await outcome;
        operation.complete();
      }
    },
  );

  it.each(["global", "unknown"])(
    "keeps the selected agent through a %s hook checkpoint",
    async (sessionKey) => {
      const root = tempDirs.make("openclaw-owned-reply-claim-");
      const storePath = path.join(root, "sessions.json");
      const main = { agentId: "main", storePath, sessionKey };
      const ops = { agentId: "ops", storePath, sessionKey };
      await replaceSessionEntry(main, { sessionId: "main-session", updatedAt: 1 });
      const mainBefore = loadSessionEntry(main);
      const { controller } = await createTrackedClaim(
        { sessionId: "ops-session", restartRecoveryDeliveryRunId: "ops-recovery" },
        { ...ops, admissionRunId: "ops-recovery" },
      );
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      const hostSql = observeHostDataSql();
      try {
        expect(loadSessionEntry(ops)?.sessionId).toBe("ops-session");
        expect(hostSql.calls.some((call) => call.mock.calls.length > 0)).toBe(true);
        hostSql.calls.forEach((call) => call.mockClear());
        expect(await controller.isArmed()).toBe(false);
        hostSql.calls.forEach((call) => expect(call).not.toHaveBeenCalled());
      } finally {
        hostSql.restore();
      }
      await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
      await controller.checkpointBeforeAgentReply({
        state: "handled-reply",
        pendingFinalDelivery: {
          intentId: "ops-intent",
          text: "ops hook reply",
          deliveries: [{ id: "ops-delivery", state: "prepared" }],
        },
      });
      await controller.clear();
      expect(loadSessionEntry(ops)).toMatchObject({
        sessionId: "ops-session",
        restartRecoveryBeforeAgentReplyState: "handled-reply",
        pendingFinalDelivery: { intentId: "ops-intent", text: "ops hook reply" },
      });
      expect(loadSessionEntry(ops)?.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(loadSessionEntry(main)).toEqual(mainBefore);
    },
  );

  it.each([
    { receiptState: undefined, expectedStatus: "done", restartAbort: false },
    { receiptState: "terminal-pending" as const, expectedStatus: "failed", restartAbort: false },
    { receiptState: undefined, expectedStatus: "running", restartAbort: true },
  ])(
    "settles lifecycle ownership as $expectedStatus during claim cleanup",
    async ({ receiptState, expectedStatus, restartAbort }) => {
      let restartAborted = false;
      const { controller, update, read } = await createTrackedClaim(
        { abortedLastRun: false, lifecycleRunId: "recovery-run", startedAt: 1 },
        { isRestartAbort: () => restartAborted },
      );

      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      restartAborted = restartAbort;
      if (receiptState) {
        await update({ restartRecoveryDeliveryReceiptState: receiptState });
      } else if (!restartAbort) {
        await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
        await controller.checkpointBeforeAgentReply({ state: "handled-silent" });
      }
      await controller.clear();

      const persisted = read()!;
      expect(persisted.status).toBe(expectedStatus);
      expect(persisted.lifecycleRunId).toBe(restartAbort ? "recovery-run" : undefined);
      expect(persisted.restartRecoveryDeliveryRunId).toBe(
        restartAbort ? "recovery-run" : undefined,
      );
    },
  );

  it.each([
    "restart-handoff",
    "restart-abort",
    "successor-generation",
    "missing-generation",
    "commit-rotation",
    "commit-abort",
  ] as const)(
    "preserves the delivery claim when queued cleanup loses ownership through %s",
    async (interruption) => {
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const deliveryContext = { channel: "telegram", to: "chat", accountId: "default" };
      let restartAborted = false;
      let interruptBeforeCommit = false;
      const { controller, scope, read } = await createTrackedClaim(
        {
          abortedLastRun: false,
          restartRecoveryDeliverySourceRunId: "source-turn",
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoverySourceIngress: "channel",
        },
        {
          lifecycleGeneration:
            interruption === "missing-generation" ? undefined : lifecycleGeneration,
          getSessionId: () => {
            if (interruptBeforeCommit) {
              interruptBeforeCommit = false;
              // The store awaits the prepared patch before entering its write transaction.
              queueMicrotask(() => {
                if (interruption === "commit-rotation") {
                  rotateAgentEventLifecycleGeneration();
                } else {
                  restartAborted = true;
                }
              });
            }
            return "session";
          },
          isRestartAbort: () => restartAborted,
          resolveDeliveryContext: () => deliveryContext,
        },
      );
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");

      const writerEntered = createDeferred();
      const releaseWriter = createDeferred();
      let successorGeneration: string | undefined;
      const handoff = updateSessionEntry(scope, async (current) => {
        writerEntered.resolve();
        await releaseWriter.promise;
        if (interruption === "restart-handoff" || interruption === "successor-generation") {
          transitionMainSessionRecovery(current, {
            kind: "mark_interrupted",
            cycleId: "restart-cycle",
            now: 2,
            runs: [{ runId: "original-run", lifecycleGeneration }],
          });
          if (successorGeneration) {
            const recovery = current.mainRestartRecovery!;
            transitionMainSessionRecovery(current, {
              kind: "prepare_attempt",
              attempt: 1,
              lifecycleGeneration: successorGeneration,
              now: 3,
              observation: {
                sessionId: current.sessionId,
                cycleId: recovery.cycleId,
                revision: recovery.revision,
              },
              runId: "recovery-run",
              executionIdentity: { state: "disabled" },
            });
            transitionMainSessionRecovery(current, {
              kind: "admit_recovery",
              lifecycleGeneration: successorGeneration,
              now: 4,
              runId: "recovery-run",
              sessionId: current.sessionId,
            });
          }
        }
        return current;
      });
      await writerEntered.promise;
      interruptBeforeCommit = interruption === "commit-rotation" || interruption === "commit-abort";
      // The old cleanup enters before shutdown; its actual write waits behind the handoff.
      const clearing = controller.clear().catch((error: unknown) => {
        expect(isAgentRunStaleLifecycleError(error)).toBe(true);
      });
      try {
        if (interruption === "restart-abort") {
          restartAborted = true;
        } else if (interruption === "successor-generation") {
          successorGeneration = rotateAgentEventLifecycleGeneration();
        }
      } finally {
        releaseWriter.resolve();
      }
      await Promise.all([handoff, clearing]);

      const persisted = read();
      expect(persisted).toMatchObject({
        status: "running",
        abortedLastRun: interruption === "restart-handoff",
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "source-turn",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoverySourceIngress: "channel",
      });
      expect(persisted?.restartRecoveryTerminalRunIds).toBeUndefined();
      if (successorGeneration) {
        expect(persisted?.restartRecoveryRuns).toContainEqual({
          runId: "recovery-run",
          lifecycleGeneration: successorGeneration,
        });
      }
    },
  );

  it("retires the source claim after an ordinary user abort", async () => {
    const { controller, scope, read } = await createTrackedClaim({
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryContext: { channel: "telegram", to: "chat" },
      restartRecoverySourceIngress: "channel",
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    await markSessionAbortTarget({ scope });
    await controller.clear();

    const persisted = read();
    expect(persisted?.abortedLastRun).toBe(true);
    expect(persisted?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(persisted?.restartRecoveryTerminalRunIds).toContain("source-turn");
  });

  it("adopts an exact channel recovery claim before execution starts", async () => {
    const deliveryContext = {
      channel: "telegram",
      to: "chat",
      accountId: "default",
      threadId: "thread",
    };
    const { controller, read } = await createTrackedClaim(
      {
        abortedLastRun: false,
        lifecycleRunId: "recovery-run",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
        restartRecoveryDeliverySourceRunId: "source-turn",
        restartRecoveryDeliveryToolCallId: "message-call",
        sessionId: "channel-session",
        startedAt: 1,
        status: "running",
        updatedAt: 1,
      },
      {
        sessionKey: "agent:main:telegram:group:chat:topic:thread",
        resolveDeliveryContext: () => deliveryContext,
        sourceTurnId: "source-turn",
      },
    );

    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    expect(read()).toMatchObject({
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryToolCallId: "message-call",
      status: "running",
    });
  });

  it("adopts and settles acknowledged input through hook checkpoints without caller-thread SQL", async () => {
    const fixture = await createAcknowledgedClaim();
    const persistApproved = vi.spyOn(fixture.recorder, "persistApproved");
    const sql = observeHostDataSql();
    try {
      await expect(fixture.controller.admitUserTurn(fixture.recorder)).resolves.toBe("admitted");
      expect(sql.queries).toEqual([]);
      expect(fixture.current().restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
      invalidateRegisteredAgentDatabasesMemo({});
      await expect(fixture.controller.beginBeforeAgentReply()).resolves.toBe(true);
      expect(fixture.current().restartRecoveryBeforeAgentReplyState).toBe("pending");
      await fixture.controller.checkpointBeforeAgentReply({ state: "handled-silent" });
      expect(fixture.current().restartRecoveryBeforeAgentReplyState).toBe("handled-silent");
      invalidateRegisteredAgentDatabasesMemo({});
      await fixture.controller.clear();
      expect(sql.queries).toEqual([]);
      expect(persistApproved).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      persistApproved.mockRestore();
    }
    const persisted = fixture.read();
    expect(persisted).toMatchObject({
      sessionId: fixture.transcriptScope.sessionId,
      status: "done",
      restartRecoveryTerminalRunIds: [fixture.sourceTurnId],
    });
    expect(persisted?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
    expect(
      loadTranscriptEventsSync(fixture.transcriptScope).filter(
        (event) => isRecord(event) && event.type === "message",
      ),
    ).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "user",
          content: "Synthetic acknowledged input",
          idempotencyKey: `${fixture.sourceTurnId}:user`,
        }),
      }),
    ]);
  });

  it("preserves a foreign source claim that changes after acknowledged-input adoption preparation", async () => {
    const fixture = await createAcknowledgedClaim();
    const databasePath = resolveSqliteTargetFromSessionStorePath(fixture.scope.storePath, {
      agentId: fixture.scope.agentId,
    }).path;
    const foreign = new DatabaseSync(databasePath);
    const patch = entryPatch.patchSessionEntryInWorker;
    const intervened = vi.fn();
    const spy = vi.spyOn(entryPatch, "patchSessionEntryInWorker").mockImplementation((params) => {
      if (
        params.selection.kind !== "target" ||
        params.selection.target.canonicalKey !== fixture.scope.sessionKey
      ) {
        return patch(params);
      }
      return patch({
        ...params,
        async prepare(snapshot) {
          const prepared = await params.prepare(snapshot);
          assert(prepared);
          foreign
            .prepare(
              `UPDATE session_nodes SET entry_json =
               json_set(entry_json, '$.restartRecoveryDeliverySourceRunId', 'foreign-source')
               WHERE session_key = ?`,
            )
            .run(fixture.scope.sessionKey);
          intervened();
          return prepared;
        },
      });
    });
    try {
      await expect(fixture.controller.admitUserTurn(fixture.recorder)).rejects.toBeInstanceOf(
        SqliteSessionMutationConflictError,
      );
      expect(intervened).toHaveBeenCalledOnce();
      expect(
        foreign
          .prepare(
            `SELECT status,
              json_extract(entry_json, '$.restartRecoveryDeliveryRunId') AS runId,
              json_extract(entry_json, '$.restartRecoveryDeliverySourceRunId') AS sourceRunId,
              json_extract(entry_json, '$.restartRecoveryDeliveryRequestFingerprint') AS fingerprint
             FROM session_nodes WHERE session_key = ?`,
          )
          .get(fixture.scope.sessionKey),
      ).toEqual({
        status: "running",
        runId: "recovery-run",
        sourceRunId: "foreign-source",
        fingerprint: "acknowledged-fingerprint",
      });
    } finally {
      spy.mockRestore();
      foreign.close();
    }
  });

  it("retargets durable user-turn admission to the prepared reply session", async () => {
    const storePath = path.join(tempDirs.make("openclaw-reply-admission-"), "sessions.json");
    const sessionKey = "plugin-binding:codex:target";
    const sessionId = "bound-session-id";
    const entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const recorder = createUserTurnTranscriptRecorder({
      message: { role: "user", content: "hello", timestamp: 1 },
      target: {
        agentId: "main",
        sessionId: "unprepared-session",
        sessionKey: "unprepared-key",
        sessionEntry: undefined,
        storePath,
      },
      updateMode: "none",
    });
    const persistApproved = vi.spyOn(recorder, "persistApproved");
    const controller = createController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      resolveUserTurnTarget: (target) => ({
        ...target,
        sessionEntry: target.entry,
        agentId: "main",
      }),
      sessionKey,
      setEntry: () => {},
      storePath,
    });

    await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    expect(persistApproved).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: sessionId,
        target: expect.objectContaining({ sessionId, sessionKey, storePath, agentId: "main" }),
      }),
    );
    expect(recorder.getAdmissionReceipt()?.sessionId).toBe(sessionId);
  });

  it.each(["metadata", "recovery-cycle", "owner-release"] as const)(
    "admits only unchanged recovery ownership after a concurrent %s write",
    async (change) => {
      const storePath = path.join(tempDirs.make("openclaw-reply-admission-race-"), "sessions.json");
      const sessionKey = "agent:main:telegram:group:chat:topic:thread";
      const scope = { storePath, sessionKey };
      const sessionId = "channel-session-id";
      const sourceTurnId = "telegram-update-new";
      const deliveryContext = {
        channel: "telegram",
        to: "chat",
        accountId: "default",
        threadId: "thread",
      };
      let entry: InternalSessionEntry = {
        sessionId,
        updatedAt: 10,
        abortedLastRun: false,
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoveryDeliveryRunId: "orphaned-run",
        restartRecoveryDeliverySourceRunId: "telegram-update-old",
        status: "done",
      };
      let releaseOwner: (() => Promise<unknown>) | undefined;
      if (change === "owner-release") {
        await replaceSessionEntry(scope, {
          sessionId,
          updatedAt: 10,
          abortedLastRun: true,
          status: "running",
          mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
        });
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId,
          target: scope,
        });
        expect(owner.kind).toBe("claimed");
        if (owner.kind !== "claimed") {
          throw new Error("recovery owner was not acquired");
        }
        releaseOwner = () => releaseMainSessionRecoveryOwner(owner.lease);
        entry = (await updateSessionEntry(scope, () => entry)) as InternalSessionEntry;
      } else {
        await replaceSessionEntry(scope, entry);
      }
      const sourceMessage = {
        role: "user" as const,
        content: "continue",
        idempotencyKey: sourceTurnId,
        timestamp: 1,
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: sourceMessage,
        target: { agentId: "main", sessionEntry: entry, sessionId, ...scope },
        updateMode: "none",
      });
      const persist = recorder.persistApproved.bind(recorder);
      const persistApproved = vi.spyOn(recorder, "persistApproved");
      if (change === "metadata") {
        recorder.markRuntimePersisted();
        vi.spyOn(recorder, "resolveMessage").mockImplementation(async () => {
          await updateSessionEntry(scope, (current) => ({
            model: "gpt-5.6-luna",
            updatedAt: current.updatedAt + 1,
          }));
          return sourceMessage;
        });
      } else {
        persistApproved.mockImplementation(async (options) => {
          if (releaseOwner) {
            await releaseOwner();
          } else {
            await updateSessionEntry(scope, () => ({
              mainRestartRecovery: { cycleId: "cycle-new", revision: 1, chargedAttempts: 0 },
            }));
          }
          return persist(options);
        });
      }
      const controller = createController({
        getEntry: () => entry,
        getSessionId: () => sessionId,
        resolveDeliveryContext: () => deliveryContext,
        setEntry: (next) => {
          entry = next;
        },
        sourceTurnId,
        ...scope,
      });

      if (change === "metadata") {
        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
        expect(persistApproved).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)).toMatchObject({
          model: "gpt-5.6-luna",
          restartRecoveryDeliverySourceRunId: sourceTurnId,
          status: "running",
        });
      } else {
        await expect(controller.admitUserTurn(recorder)).rejects.toThrow(
          "session changed before durable user-turn admission",
        );
        const persisted = loadSessionEntry(scope);
        expect(persisted).toMatchObject({
          restartRecoveryDeliveryRunId: "orphaned-run",
          restartRecoveryDeliverySourceRunId: "telegram-update-old",
          status: "done",
        });
        if (change === "owner-release") {
          expect(persisted).not.toHaveProperty("mainRestartRecovery");
        } else {
          expect(persisted?.mainRestartRecovery).toMatchObject({
            cycleId: "cycle-new",
            revision: 1,
          });
        }
      }
    },
  );
});
