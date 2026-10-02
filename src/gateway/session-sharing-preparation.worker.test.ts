import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerCoordination } from "../config/sessions/session-accessor.sqlite-worker-coordination.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

it.for(["Error", "undefined", "deleted"] as const)(
  "preserves the native sharing row outcome before transport (%s)",
  async (failure, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:sharing-row-outcome" };
      replaceSessionEntrySync(scope, {
        sessionId: "sharing-row-outcome",
        lifecycleRevision: "original",
        updatedAt: 1,
        visibility: "shared",
      });
      const databaseOptions = toDatabaseOptions(
        captureLifecycleDatabaseScope(resolveSqliteScope(scope)),
      );
      const prepared = await prepareSessionMutationFacts({ cfg, ...scope });
      let worker: Worker | undefined;
      let operation: Promise<void> | undefined;
      try {
        const read = prepared.workerRead;
        if (read?.kind !== "durable") {
          throw new Error("sharing fixture requires its original durable worker read");
        }
        worker = new Worker(
          new URL("./session-sharing-worker-read.worker.test-support.mjs", import.meta.url),
          {
            execArgv: [],
            workerData: {
              read,
              databaseOptions,
              failure,
              sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
            },
          },
        );
        const owned = worker;
        const response = Promise.all([once(owned, "message"), once(owned, "exit")]).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        operation = withSqliteMutationWorkerCoordination(
          captureOpenClawStateWorkerContext(),
          { kind: "dedicated", channel: owned },
          1,
          async (coordination) => {
            owned.postMessage(coordination, []);
            const outcome = await withinTest(response, signal);
            if ("error" in outcome) {
              throw outcome.error;
            }
            const [[report], exit] = outcome.value;
            expect(report).toEqual(
              failure === "deleted"
                ? { empty: true, unavailable: true, observations: [], closed: true }
                : {
                    producerIdentity: true,
                    guardIdentity: true,
                    observations: ["cohort", "single", "cohort", "single"],
                    closed: true,
                  },
            );
            expect(exit).toEqual([0]);
            expect(owned.threadId).toBe(-1);
          },
        );
        await operation;
      } finally {
        await worker?.terminate();
        await Promise.allSettled([operation]);
        prepared.release();
      }
    });
  },
);
