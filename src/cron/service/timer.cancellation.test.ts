import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState as createCronServiceState,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { cancelTaskById, listTaskRecords } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { saveCronStore } from "../store.js";
import { getSuspensionVisibleCronTaskRunCount } from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";
import { stop } from "./ops-lifecycle.js";
import { onTimer } from "./timer.test-support.js";

const timerRegressionFixtures = setupCronRegressionFixtures({ prefix: "cron-task-cancellation-" });

vi.mock("../../tasks/task-registry-control.runtime.js", async () => {
  const cron = await import("./active-run-cancellation.js");
  return { cancelActiveCronTaskRun: cron.cancelActiveCronTaskRun };
});

describe("cron task cancellation settlement", () => {
  it.each(["pending", "on-abort", "before-cancel"] as const)(
    "settles timeout-disabled cron cancellation when the runner finishes %s",
    async (settlement) => {
      vi.useFakeTimers();
      resetTaskRegistryForTests();
      resetActiveCronTaskRunsForTests();
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:10:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "no-timeout-cancel",
        name: "no timeout cancel",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0 },
        state: { nextRunAtMs: scheduledAt },
      });
      if (settlement === "before-cancel") {
        cronJob.delivery = { mode: "webhook", to: "https://example.invalid/completion" };
      }
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      const now = scheduledAt;
      let abortObserved = false;
      let timerSettled = false;
      const runnerStarted = createDeferred();
      const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
      const webhookStarted = createDeferred();
      const webhookResult = createDeferred();
      if (settlement === "before-cancel") {
        runnerResult.resolve({ status: "ok", summary: "completed before cancellation" });
      }
      const state = createCronServiceState({
        storePath: store.storePath,
        nowMs: () => now,
        runIsolatedAgentJob: vi.fn(async ({ abortSignal, onExecutionStarted }) => {
          onExecutionStarted?.();
          runnerStarted.resolve();
          abortSignal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              if (settlement === "on-abort") {
                runnerResult.resolve({ status: "ok", summary: "finished after abort" });
              }
            },
            { once: true },
          );
          return await runnerResult.promise;
        }),
        sendCronWebhook: async () => {
          webhookStarted.resolve();
          await webhookResult.promise;
        },
      });

      const timerPromise = onTimer(state).then(() => {
        timerSettled = true;
      });
      try {
        await runnerStarted.promise;
        if (settlement === "before-cancel") {
          await webhookStarted.promise;
        }

        const runId = `cron:no-timeout-cancel:${scheduledAt}`;
        const task = listTaskRecords().find(
          (entry) =>
            entry.runtime === "cron" &&
            (entry.runId === runId || entry.runId?.startsWith(`${runId}:`)),
        );
        if (!task) {
          throw new Error("Expected timeout-disabled cron task row");
        }

        const cancelResult = await cancelTaskById({
          cfg: {} as never,
          taskId: task.taskId,
        });
        expect(cancelResult.found).toBe(true);
        expect(cancelResult.cancelled, cancelResult.reason).toBe(settlement !== "before-cancel");
        expect(abortObserved).toBe(true);

        await vi.waitFor(() => expect(timerSettled).toBe(true), { interval: 0 });
        await timerPromise;

        const finalTask = listTaskRecords().find((entry) => entry.taskId === task.taskId);
        const job = state.store?.jobs.find((entry) => entry.id === "no-timeout-cancel");
        if (settlement === "before-cancel") {
          expect(finalTask?.status).toBe("failed");
          expect(finalTask?.terminalSummary).toBe("completed before cancellation");
          expect(job?.state.lastStatus).toBe("ok");
          expect(job?.state.lastError).toBeUndefined();
          expect(job?.state.lastDeliveryStatus).toBe("not-delivered");
        } else {
          expect(finalTask?.status).toBe("cancelled");
          expect(job?.state.lastStatus).toBe("error");
          expect(job?.state.lastError).toBe("Cancelled by operator.");
        }
      } finally {
        stop(state);
        runnerResult.resolve({ status: "ok", summary: "done" });
        webhookResult.resolve();
        await Promise.allSettled([timerPromise, runnerResult.promise]);
        await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
        vi.useRealTimers();
        resetActiveCronTaskRunsForTests();
        await closeOpenClawStateDatabaseAsync();
        resetTaskRegistryForTests();
      }
    },
  );
});
