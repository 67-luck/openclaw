import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { finalizeTaskRecordByRunId, getTaskById } from "../../tasks/runtime-internal.js";
import * as taskBacking from "../../tasks/task-backing-authority.js";
import { createAcpTaskBackingDetailForTest } from "../../tasks/task-backing-authority.test-support.js";
import { updateTask } from "../../tasks/task-registry-mutation.js";
import { reloadTaskRegistryFromStoreAsync } from "../../tasks/task-registry-state.js";
import { transitionTaskRecordsByRunAsync } from "../../tasks/task-registry-transition.async.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import { seedTaskRegistryRowsForTests } from "../../test-utils/task-registry-sqlite.js";
import {
  getTaskPayload,
  mainSessionTaskScope,
  useTaskGatewayFixture,
} from "./tasks.fixture.test-support.js";
import { createSnapshotTask, identifiedClient, runTaskHandler } from "./tasks.test-helpers.js";

const { cancelSessionMock } = useTaskGatewayFixture();

async function prepareMemberCancellation() {
  const profile = ensureProfileForEmail("canceller@example.test");
  const replacement = ensureProfileForEmail("replacement@example.test");
  const sessionKey = "agent:main:member-cancellation";
  const scope = { agentId: "main", sessionKey };
  await upsertSessionEntryCore(scope, {
    sessionId: "member-cancellation-session",
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "another-owner" },
    visibility: "read-only",
  });
  addSessionMember(scope, {
    identityId: profile.id,
    addedBy: "another-owner",
    expectedSessionId: "member-cancellation-session",
  });
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "participant",
        definitions: {
          participant: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          restricted: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  const task = createSnapshotTask({
    taskId: "member-cancel-task",
    runtime: "acp",
    requesterSessionKey: sessionKey,
    requesterAgentId: "main",
    ownerKey: sessionKey,
    agentId: "main",
    childSessionKey: "agent:main:acp:member-cancel-child",
    runId: "member-cancel-run",
    notifyPolicy: "silent",
    detail: createAcpTaskBackingDetailForTest("member-cancel-instance"),
  });
  seedTaskRegistryRowsForTests([task]);
  await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
  cancelSessionMock.mockResolvedValue(undefined);
  return {
    cfg,
    task,
    scope,
    profile,
    replacement,
    client: identifiedClient(["operator.read", "operator.write"], profile.id),
  };
}

describe("tasks.cancel gateway handler", () => {
  it("does not report cancellation for an ordinary task without a live owner", async () => {
    const task = createTaskFixture("cli", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-cancel",
      task: "Cancelable task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "user stopped task",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(false);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("running");
    expect(payload?.task?.error).toBeUndefined();
  });

  it("refuses native subagent cancellation and preserves the harness result", async () => {
    const task = createTaskFixture("subagent", {
      ...mainSessionTaskScope,
      taskKind: "codex-native",
      runId: "codex-thread:native-child",
      task: "Native child task",
      notifyPolicy: "silent",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", { taskId: task.taskId });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason:
        "This subagent is controlled by its native harness. Use the parent session's native collaboration tools to stop it.",
      task: { id: task.taskId, status: "running" },
    });
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    expect(getTaskById(task.taskId)).toEqual(task);

    finalizeTaskRecordByRunId({
      runId: task.runId!,
      runtime: "subagent",
      sessionKey: task.ownerKey,
      status: "succeeded",
      endedAt: Date.now(),
      terminalSummary: "Native child completed.",
    });
    const completed = await getTaskPayload(task.taskId);
    expect(completed.payload?.task).toMatchObject({
      status: "completed",
      terminalSummary: "Native child completed.",
    });
  });

  it.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["timed_out", "timed_out"],
    ["lost", "failed"],
    ["cancelled", "cancelled"],
  ] as const)(
    "tasks.cancel preserves ACP %s and explains refused cancellation",
    async (status, wireStatus) => {
      const runId = "run-acp-cancel-race";
      const instanceId = "instance-acp-cancel-race";
      const task = createSnapshotTask({
        runtime: "acp",
        runId,
        notifyPolicy: "silent",
        childSessionKey: "agent:main:acp:cancel-race",
        agentId: "main",
        detail: createAcpTaskBackingDetailForTest(instanceId),
      });
      seedTaskRegistryRowsForTests([task]);
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
      cancelSessionMock.mockImplementationOnce(async () => {
        await transitionTaskRecordsByRunAsync({
          kind: "state",
          params: {
            runId,
            runtime: "acp",
            sessionKey: task.childSessionKey,
            status,
            endedAt: 2_000,
          },
        });
      });

      const { calls, payload } = await runTaskHandler("tasks.cancel", { taskId: task.taskId });

      expect(calls[0]?.[0]).toBe(true);
      expect(cancelSessionMock).toHaveBeenCalledExactlyOnceWith({
        cfg: {},
        sessionKey: "agent:main:acp:cancel-race",
        agentId: "main",
        reason: "task-cancel",
        expectedRunId: runId,
        expectedInstanceId: instanceId,
      });
      expect(payload).toMatchObject({ found: true, cancelled: status === "cancelled" });
      if (status === "cancelled") {
        expect(payload).not.toHaveProperty("reason");
      } else {
        expect(payload).toHaveProperty(
          "reason",
          `Task became ${status} while cancellation was in progress.`,
        );
      }
      expect(payload?.task).toMatchObject({ id: task.taskId, status: wireStatus, endedAt: 2_000 });
      expect(getTaskById(task.taskId)).toMatchObject({ status, endedAt: 2_000 });
    },
  );

  it("cancels the selected ACP instance through the live Gateway handler and control runtime", async () => {
    const instanceId = "instance-acp-primary";
    const task = createSnapshotTask({
      taskId: "task-acp-primary",
      runtime: "acp",
      notifyPolicy: "silent",
      childSessionKey: "agent:codex:acp:child",
      agentId: "codex",
      runId: "run-cancel-acp-gateway",
      task: "Primary ACP task",
      detail: createAcpTaskBackingDetailForTest(instanceId),
    });
    const siblingTask = createSnapshotTask({
      taskId: "task-acp-sibling",
      runtime: "acp",
      notifyPolicy: "silent",
      childSessionKey: "agent:codex:acp:child",
      agentId: "codex",
      runId: "run-cancel-acp-gateway",
      task: "Sibling ACP task",
      createdAt: 1_001,
      startedAt: 1_011,
      lastEventAt: 1_011,
      detail: createAcpTaskBackingDetailForTest("instance-acp-sibling", 2),
    });
    seedTaskRegistryRowsForTests([task, siblingTask]);
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    cancelSessionMock.mockResolvedValue(undefined);

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "operator requested stop",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(cancelSessionMock).toHaveBeenCalledExactlyOnceWith({
      cfg: {},
      sessionKey: "agent:codex:acp:child",
      agentId: "codex",
      reason: "operator requested stop",
      expectedRunId: "run-cancel-acp-gateway",
      expectedInstanceId: instanceId,
    });
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled, JSON.stringify(payload)).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(getTaskById(task.taskId)?.status).toBe("cancelled");
    expect(getTaskById(siblingTask.taskId)).toEqual(siblingTask);
  });

  it("settles a nonadmin member's selected ACP cancellation without host data SQL", async () => {
    const fixture = await prepareMemberCancellation();
    const original = taskBacking.prepareTaskBackingRead;
    let observation: ReturnType<typeof observeHostDataSql> | undefined;
    const preparation = vi.spyOn(taskBacking, "prepareTaskBackingRead").mockImplementation((id) => {
      // Access preparation has completed; count dispatch, settlement, and response readback.
      observation ??= observeHostDataSql();
      return original(id);
    });
    try {
      const { payload } = await runTaskHandler(
        "tasks.cancel",
        { taskId: fixture.task.taskId },
        fixture.cfg,
        fixture.client,
      );
      observation?.restore();
      expect(observation).toBeDefined();
      expect(observation?.queries.length).toBe(0);
      expect(payload).toMatchObject({
        found: true,
        cancelled: true,
        task: { id: fixture.task.taskId, status: "cancelled" },
      });
      expect(cancelSessionMock).toHaveBeenCalledExactlyOnceWith({
        cfg: fixture.cfg,
        sessionKey: fixture.task.childSessionKey,
        agentId: "main",
        expectedRunId: fixture.task.runId,
        expectedInstanceId: "member-cancel-instance",
        reason: "task-cancel",
      });
      expect(getTaskById(fixture.task.taskId)).toMatchObject({
        status: "cancelled",
        endedAt: expect.any(Number),
      });
    } finally {
      observation?.restore();
      preparation.mockRestore();
    }
  });

  it.each(["membership", "role", "alias", "requester", "request lifetime"] as const)(
    "refuses cancellation when %s changes during awaited backing preparation",
    async (changed) => {
      const fixture = await prepareMemberCancellation();
      const entered = createDeferred();
      const release = createDeferred();
      const original = taskBacking.prepareTaskBackingRead;
      const preparation = vi
        .spyOn(taskBacking, "prepareTaskBackingRead")
        .mockImplementationOnce(async (id) => {
          entered.resolve();
          await release.promise;
          return original(id);
        });
      const pending = runTaskHandler(
        "tasks.cancel",
        { taskId: fixture.task.taskId },
        fixture.cfg,
        fixture.client,
      );
      const settled = Promise.allSettled([pending]);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Cancellation returned before reaching backing preparation");
          }),
        ]);
        expect(cancelSessionMock).not.toHaveBeenCalled();
        if (changed === "membership") {
          expect(removeSessionMember(fixture.scope, fixture.profile.id)).not.toBeNull();
        } else if (changed === "role") {
          setUserProfileRole(fixture.profile.id, "restricted");
        } else if (changed === "alias") {
          linkEmail("canceller@example.test", fixture.replacement.id);
        } else if (changed === "requester") {
          updateTask(fixture.task.taskId, { requesterSessionKey: "agent:main:another-requester" });
        } else {
          fixture.client.invalidated = true;
        }
        release.resolve();
        if (changed === "request lifetime") {
          await expect(pending).rejects.toThrow("Gateway requester authority changed");
        } else {
          const { payload } = await pending;
          expect(payload).toMatchObject({ found: true, cancelled: false });
          expect(payload).not.toHaveProperty("task");
        }
        expect(cancelSessionMock).not.toHaveBeenCalled();
        expect(getTaskById(fixture.task.taskId)).toMatchObject({
          status: "running",
          requesterSessionKey:
            changed === "requester"
              ? "agent:main:another-requester"
              : fixture.task.requesterSessionKey,
        });
        expect(getTaskById(fixture.task.taskId)?.endedAt).toBeUndefined();
      } finally {
        release.resolve();
        await settled;
        preparation.mockRestore();
      }
    },
  );
});
