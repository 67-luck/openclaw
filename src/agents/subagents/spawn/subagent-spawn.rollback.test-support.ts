import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withTimeout } from "../../../infra/fs-safe.js";
import {
  getRpcSourceIdentity,
  requestRpcSourceCancellation,
} from "../../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import type { SqliteWorkerCommand } from "../../../infra/sqlite-worker-contract.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../../state/openclaw-state-worker-contract.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import type { AdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "../registry/subagent-registry-persistence.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;
type RegistryWrite = Extract<
  SqliteWorkerCommand<OpenClawStateWorkerOperations>,
  { type: "subagents.persistChanges" }
>;

function interceptChildRegistrationWrite(
  requesterSessionKey: string,
  fail: (
    row: RegistryWrite["input"]["values"][number],
    context: OpenClawStateWorkerContext,
  ) => Promise<never>,
) {
  const failure = vi.fn(fail);
  const runWorkerOperation = stateWorker.runOpenClawStateWorkerOperation;
  let intercepted = false;
  const spy = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((workerContext, operation, workerOptions) =>
      runWorkerOperation(
        workerContext,
        (scope) =>
          operation({
            execute: vi
              .fn()
              .mockImplementation(
                async (command: SqliteWorkerCommand<OpenClawStateWorkerOperations>) => {
                  const row =
                    !intercepted && command.type === "subagents.persistChanges"
                      ? command.input.values.find(
                          (entry) => entry.requester_session_key === requesterSessionKey,
                        )
                      : undefined;
                  if (!row) {
                    return scope.execute(command);
                  }
                  intercepted = true;
                  return failure(row, workerContext);
                },
              ),
          }),
        workerOptions,
      ),
    );
  return { failure, restore: () => spy.mockRestore() };
}

export function registerOperatorSpawnRollbackCases(options: {
  createBoundParent: (
    authority?: AdmittedRunOperatorAuthority,
    settings?: { maxChildrenPerAgent?: number; guestProfileId?: string },
  ) => Promise<BoundParent>;
  createBoundGateway: (bound: BoundParent) => Promise<{
    context: GatewayRequestContext;
    runtime: GatewayRuntime;
  }>;
  closeBoundGateway: (
    bound: BoundParent,
    runtime: GatewayRuntime,
    childRunId?: string,
  ) => Promise<unknown[]>;
  throwBoundFailures: (failures: unknown[]) => void;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
}) {
  it.each([
    { phase: "preparation", label: "revoked-source preparation", scope: "operator.write" },
    {
      phase: "accepted registration",
      label: "revoked-source accepted registration",
      scope: "operator.write",
    },
    { phase: "uncertain registration", label: "uncertain registration", scope: "operator.write" },
    {
      phase: "accepted registration",
      label: "guest revoked-source accepted registration",
      scope: "operator.sessions.write",
    },
  ] as const)(
    "rolls back an ordinary operator spawn and joins cleanup after $label failure",
    async ({ phase, scope: operatorScope }) => {
      const guest = operatorScope === "operator.sessions.write";
      const source = createSpawnOperatorSource(
        guest ? ensureProfileForEmail("rollback-guest@example.test").id : "spawn-operator",
        [operatorScope],
      );
      const bound = await options.createBoundParent(source.authority, {
        guestProfileId: guest ? source.authority.profileId : undefined,
      });
      const { context, runtime } = await options.createBoundGateway(bound);
      const preserveSession = phase === "uncertain registration";
      let childSessionKey: string | undefined;
      let childRunId: string | undefined;
      let embeddedSignal: AbortSignal | undefined;
      let embeddedSettled = false;
      const embeddedStarted = createDeferred();
      let invocation: Promise<unknown> | undefined;
      let registrationUncertain = false;
      let registrationWrite: ReturnType<typeof interceptChildRegistrationWrite> | undefined;
      let retainedChildIdentity: { sessionId: string; lifecycleRevision?: string } | undefined;
      const cleanupAttemptSettled = createDeferred();
      const dispatchSessionMethod = runtime.recovery.dispatchSessionMethod;
      const cleanupDispatch = preserveSession
        ? vi
            .spyOn(runtime.recovery, "dispatchSessionMethod")
            .mockImplementation(async (...args) => {
              try {
                return await dispatchSessionMethod(...args);
              } finally {
                cleanupAttemptSettled.resolve();
              }
            })
        : undefined;
      const failures: unknown[] = [];
      if (phase === "preparation") {
        spawnTesting.setDepsForTest({
          forkSessionEntryFromParent: async (params) => {
            childSessionKey = params.sessionKey;
            source.revoke();
            return { status: "failed" };
          },
        });
      } else {
        options.runEmbeddedAgent.mockImplementationOnce(async (params) => {
          const signal = expectDefined(params.abortSignal, "accepted child abort signal");
          embeddedSignal = signal;
          embeddedStarted.resolve();
          try {
            return await new Promise<never>((_resolve, reject) => {
              const abort = () =>
                reject(toErrorObject(signal.reason, "Accepted child execution aborted"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) {
                signal.removeEventListener("abort", abort);
                abort();
              }
            });
          } finally {
            embeddedSettled = true;
          }
        });
        registrationWrite = interceptChildRegistrationWrite(
          bound.parentSessionKey,
          async (record) => {
            childSessionKey = record.child_session_key;
            childRunId = record.run_id;
            expect(subagentRuns.has(record.run_id)).toBe(false);
            const acceptedRun = expectDefined(
              rpcSourceTesting.get(record.run_id),
              "accepted child execution owner",
            );
            expect(getRpcSourceIdentity(acceptedRun).sessionKey).toBe(record.child_session_key);
            if (phase === "uncertain registration") {
              await embeddedStarted.promise;
              expect(expectDefined(embeddedSignal, "running child abort signal").aborted).toBe(
                false,
              );
              expect(rpcSourceTesting.get(record.run_id)).toBe(acceptedRun);
              const childEntry = expectDefined(
                loadSessionEntry({
                  storePath: bound.storePath,
                  sessionKey: record.child_session_key,
                }),
                "uncertain registration child session",
              );
              retainedChildIdentity = {
                sessionId: childEntry.sessionId,
                lifecycleRevision: childEntry.lifecycleRevision,
              };
              expect(getRpcSourceIdentity(acceptedRun)).toMatchObject({
                sessionKey: record.child_session_key,
                sessionId: childEntry.sessionId,
              });
              registrationUncertain = true;
            }
            if (phase === "accepted registration") {
              source.revoke();
            }
            throw new SubagentRegistryWriteError(
              phase === "uncertain registration" ? "unknown" : "not-committed",
              new Error("ordinary child registry write failed"),
            );
          },
        );
      }
      try {
        const pending = createBoundSpawnInvocation(bound, {
          context: phase === "preparation" ? "fork" : "isolated",
        })();
        invocation = pending;
        const completion = preserveSession
          ? (async () => {
              await Promise.race([cleanupAttemptSettled.promise, pending]);
              const childKey = expectDefined(childSessionKey, "registered child session");
              const runId = expectDefined(childRunId, "registered child run");
              const dispatch = expectDefined(cleanupDispatch, "bound cleanup dispatch observer");
              source.authority.assertCurrent();
              expect(expectDefined(embeddedSignal, "accepted child abort signal").aborted).toBe(
                true,
              );
              expect(dispatch).toHaveBeenCalledWith(
                "chat.abort",
                { sessionKey: childKey, runId },
                expect.objectContaining({ assertCurrent: expect.any(Function) }),
              );
              const result = await pending;
              await bound.execution.drain();
              return result;
            })()
          : pending;
        const result = await withTimeout(completion, 60_000, {
          message: "ordinary spawn rollback cleanup did not settle",
        });
        const childKey = expectDefined(childSessionKey, "created child session");
        expect(result.details).toMatchObject({ status: "error", childSessionKey: childKey });
        if (preserveSession) {
          expect(registrationUncertain).toBe(phase === "uncertain registration");
          const dispatch = expectDefined(cleanupDispatch, "bound cleanup dispatch observer");
          expect(dispatch.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
          ).toMatchObject(expectDefined(retainedChildIdentity, "original retained child identity"));
          expect(options.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(embeddedSignal).toBeDefined();
          if (phase === "uncertain registration") {
            expect(registrationWrite?.failure).toHaveBeenCalledOnce();
          }
        } else {
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
          ).toBeUndefined();
        }
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: bound.parentSessionKey }),
        ).toMatchObject({ sessionId: "parent-session" });
        if (phase === "preparation") {
          expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        } else {
          const runId = expectDefined(childRunId, "accepted child run");
          expect(rpcSourceTesting.has(runId)).toBe(false);
          expect(context.dedupe.get(`agent:${runId}`)).toMatchObject({
            payload: { runId, status: expect.stringMatching(/^(error|timeout)$/) },
          });
          expect(subagentRuns.has(runId)).toBe(false);
          if (embeddedSignal) {
            expect(embeddedSignal.aborted).toBe(true);
            expect(embeddedSettled).toBe(true);
          } else {
            expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
          }
        }
      } catch (error) {
        failures.push(error);
      } finally {
        embeddedStarted.resolve();
        spawnTesting.setDepsForTest();
        registrationWrite?.restore();
        for (const entry of rpcSourceTesting.values()) {
          if (entry !== bound.parent.entry) {
            requestRpcSourceCancellation(entry, new Error("spawn rollback fixture cleanup"));
          }
        }
        if (preserveSession) {
          await invocation?.catch(() => {});
        }
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        if (preserveSession) {
          try {
            await settleSubagentRegistryPersistenceWork();
          } catch (error) {
            failures.push(error);
          }
        }
        cleanupDispatch?.mockRestore();
        try {
          await resetSubagentRegistryForTests({ persist: false });
          expect(source.holds).toBe(0);
        } catch (error) {
          failures.push(error);
        }
        options.throwBoundFailures(failures);
      }
    },
  );

}
