import { beforeEach, vi } from "vitest";
import type { AgentCommandDeliveryResult } from "../../agents/command/delivery-result.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import type { CreatedDetachedTaskRun } from "../../tasks/detached-task-runtime-contract.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { TaskRunOwner } from "../../tasks/task-run-owner.types.js";

const mocks = vi.hoisted(() => ({
  createTaskReceipt:
    vi.fn<(params: unknown, assertCurrent: () => void) => Promise<CreatedDetachedTaskRun | null>>(),
  createRunningTaskRun: vi.fn<() => TaskRecord | null>(),
  agentCommand: vi.fn(
    async (
      options: Pick<AgentCommandOpts, "onExecutionStarted">,
    ): Promise<
      Pick<AgentCommandDeliveryResult, "payloads"> & {
        meta: Partial<AgentCommandDeliveryResult["meta"]>;
      }
    > => {
      await options.onExecutionStarted?.();
      return { payloads: [], meta: {} };
    },
  ),
  taskRunOwners: new Map<string, TaskRunOwner>(),
  bindTaskRunOwner: vi.fn<(task: TaskRecord, cancel: TaskRunOwner["cancel"]) => () => void>(),
  getTaskRunOwner: vi.fn<(task: TaskRecord) => TaskRunOwner | undefined>(),
  finalizeTrackedTask: vi.fn(),
  finalizeActive:
    vi.fn<
      (
        task: TaskRecord,
        terminal: Parameters<CreatedDetachedTaskRun["finalizeActive"]>[0],
        canSettle: (task: TaskRecord) => boolean,
      ) => Promise<void>
    >(),
  clearAgentRunContext: vi.fn(),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: mocks.agentCommand,
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));
vi.mock("../../tasks/detached-task-runtime.js", () => ({
  prepareRunningTaskRun: (params: unknown, assertCurrent: () => void) => ({
    kind: "receipt",
    create: () => mocks.createTaskReceipt(params, assertCurrent),
  }),
  createRunningTaskRun: mocks.createRunningTaskRun,
}));
vi.mock("../../tasks/runtime-internal.js", () => ({ getTaskById: vi.fn() }));
vi.mock(import("../../tasks/task-flow-registry.store.sqlite.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  bindTaskFlowExecution: vi.fn(),
}));
vi.mock(import("../../tasks/task-registry.store.sqlite.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  bindTaskRunExecution: vi.fn(),
}));
vi.mock("../../tasks/task-run-owner.js", () => ({
  bindTaskRunOwner: mocks.bindTaskRunOwner,
  getTaskRunOwner: mocks.getTaskRunOwner,
}));
vi.mock("../server-methods/agent-task-tracking.js", () => ({
  tryFinalizeTrackedAgentTask: mocks.finalizeTrackedTask,
}));
vi.mock("../../infra/agent-run-registry.js", () => ({
  clearAgentRunContext: mocks.clearAgentRunContext,
  getAgentRunLifecycleGeneration: () => "fixture-generation",
  validateAgentRunDelegatedAuthority: () => true,
}));
vi.mock("../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(),
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  isAgentEventLifecycleGenerationCurrent: () => true,
  assertAgentRunLifecycleGenerationCurrent: () => {},
}));
vi.mock("../../agents/cron-creator-authority-context.js", () => ({
  createCronCreatorAuthorityCapability: vi.fn(),
  runWithCronCreatorAuthorityCapability: vi.fn(),
}));
vi.mock("../chat-abort-ops.js", () => ({ createChatAbortOps: vi.fn() }));
vi.mock("../chat-abort.js", () => ({ abortChatRunById: vi.fn() }));
vi.mock("./agent-dedupe.js", () => ({ setGatewayDedupeEntries: vi.fn() }));

export function taskReceipt(
  task: TaskRecord,
  settleUnstarted: CreatedDetachedTaskRun["settleUnstarted"],
): CreatedDetachedTaskRun {
  return {
    task,
    async bindRunOwner(cancel, assertCurrent) {
      assertCurrent();
      const release = mocks.bindTaskRunOwner(task, cancel);
      const owner = mocks.getTaskRunOwner(task);
      if (!owner) {
        throw new Error("Expected the bound fixture task owner");
      }
      return { owner, release };
    },
    settleUnstarted,
    finalizeActive: (terminal, canSettle) => mocks.finalizeActive(task, terminal, canSettle),
  };
}

export function useDispatchOwnerFixture() {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taskRunOwners.clear();
    mocks.finalizeTrackedTask.mockReset();
    mocks.finalizeActive.mockImplementation(async (task, terminal, canSettle) => {
      if (!canSettle(task)) {
        return;
      }
      Object.assign(task, terminal);
    });
    mocks.bindTaskRunOwner.mockImplementation((task, cancel) => {
      const owner = {
        task,
        cancel,
        readCurrent: () => task,
        resumeExecution: async (assertCurrent: () => void) => assertCurrent(),
      };
      mocks.taskRunOwners.set(task.taskId, owner);
      return () => {
        if (mocks.taskRunOwners.get(task.taskId) === owner) {
          mocks.taskRunOwners.delete(task.taskId);
        }
      };
    });
    mocks.getTaskRunOwner.mockImplementation((task) => mocks.taskRunOwners.get(task.taskId));
    mocks.agentCommand.mockImplementation(async (options) => {
      await options.onExecutionStarted?.();
      return { payloads: [], meta: {} };
    });
  });
  return mocks;
}
