import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createAgentHarnessCompletionScope } from "../agents/agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { buildAgentInternalEventContext } from "../agents/internal-events.js";
import { registerAgentSessionLoopTestLifecycle } from "../agents/sessions/agent-session-loop-correctness.test-support.js";
import { resumeSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import { readMessageIdempotencyKey } from "../config/sessions/transcript-message-identity.js";
import {
  captureAgentHarnessCompletionCustody,
  deliverAgentHarnessCompletion,
  type AgentHarnessCompletionCustody,
} from "../plugin-sdk/agent-harness-completion.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { tryBeginGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { createRegisteredCompletionPair } from "./server.subagent-completion-authority.test-support.js";
import { loadSessionEntry } from "./session-utils.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

type OwnerChange = "live" | "operator-revoked" | "requester-replaced";

async function createCompletion(context: GatewayRequestContext) {
  const id = randomUUID();
  const requesterSessionKey = `agent:main:native-completion:${id}`;
  const sessionId = `requester-${id}`;
  const childSessionKey = `native-child:${id}`;
  const announceId = `native-completion:${id}`;
  const idempotencyKey = buildAnnounceIdempotencyKey(announceId);
  await sessionAccessor.upsertSessionEntryCore(
    { agentId: "main", sessionKey: requesterSessionKey },
    { sessionId, updatedAt: Date.now() },
  );
  const loaded = loadSessionEntry(requesterSessionKey, { agentId: "main" });
  const sessionScope = {
    agentId: "main",
    sessionKey: requesterSessionKey,
    sessionId,
    storePath: loaded.storePath,
  };
  const scope = createAgentHarnessCompletionScope({
    requesterSessionKey,
    gatewayContextResolver: context.resolveGatewayContext,
  });
  const revoked = new AbortController();
  const client = createOperatorClient({
    profileName: "native-completion",
    scopes: ["operator.write"],
  });
  const source = (await captureGatewayOperatorRunAuthority({
    client,
    context,
    sourceAuthority: {
      signal: revoked.signal,
      assertCurrent: () => revoked.signal.throwIfAborted(),
    },
  }))!;
  client.internal = { operatorRunAuthority: source.authority };
  const root = tryBeginGatewayRootWorkAdmission("test:native-completion")!;
  let custody: AgentHarnessCompletionCustody | undefined;
  const dispose = () => {
    custody?.release();
    source.release();
    root.release();
  };
  try {
    const retainedCustody = expectDefined(
      await root.run(async () =>
        withPluginRuntimeGatewayRequestScope(
          {
            client,
            context,
            resolveGatewayContext: context.resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          () => captureAgentHarnessCompletionCustody(scope),
        ),
      ),
      "Expected native completion custody",
    );
    custody = retainedCustody;
    retainedCustody.settleExecution();
    // The original request has ended. Only its retained completion owns the handoff.
    source.release();
    root.release();
    return {
      sessionScope,
      idempotencyKey,
      async changeOwner(change: OwnerChange) {
        if (change === "operator-revoked") {
          revoked.abort(new Error("operator completion authority revoked"));
        } else if (change === "requester-replaced") {
          await sessionAccessor.replaceSessionEntry(sessionScope, {
            sessionId: `replacement-${id}`,
            updatedAt: Date.now(),
          });
        }
      },
      deliver: () =>
        deliverAgentHarnessCompletion({
          scope,
          completionCustody: retainedCustody,
          childSessionKey,
          childSessionId: `child-${id}`,
          announceId,
          status: "succeeded",
          result: "Retained child result",
          isSourceSessionAdmissionAllowed: () => retainedCustody.isCurrent(),
        }),
      [Symbol.dispose]: dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

async function reachBoundary(boundary: Promise<void>, delivery: Promise<unknown>) {
  await Promise.race([
    boundary,
    delivery.then((result) => {
      throw new Error(`Completion ended before the effect boundary: ${JSON.stringify(result)}`);
    }),
  ]);
}

describe("native completion final-effect authority", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      const module = await import("./server-kernel.js");
      const create = module.createGatewayKernel;
      const capture = vi
        .spyOn(module, "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await create(...args);
          return kernel;
        });
      try {
        harness = await startGatewayServerHarness();
      } finally {
        capture.mockRestore();
      }
    },
    cleanup: async () => {
      await harness?.close();
    },
  });
  registerAgentSessionLoopTestLifecycle();
  afterEach(() => vi.restoreAllMocks());

  it.for(["neither", "predecessor", "successor"] as const)(
    "keeps registered turn delivery independent when %s source is revoked in flight",
    async (revokedSource, { signal }) => {
      await prepareGatewayReplyRuntimeForTest();
      const context = kernel.gatewayRequestContext;
      const pair = await createRegisteredCompletionPair(context);
      const createGate = () => ({ entered: createDeferred(), resume: createDeferred() });
      const gates = [createGate(), createGate()] as const;
      const sources: unknown[] = [];
      const attempts: string[] = [];
      const requesterRuntimeContext: unknown[] = [];
      let requesterCommands = 0;
      const release = () => gates.forEach((gate) => gate.resume.resolve());
      signal.addEventListener("abort", release, { once: true });
      const requestWork = vi.spyOn(context, "trackExecution");
      const settleRequests = () =>
        Promise.allSettled(
          requestWork.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
      const stage = sessionAccessor.stageSessionPendingInput;
      const stageSpy = vi
        .spyOn(sessionAccessor, "stageSessionPendingInput")
        .mockImplementation(async (...args) => {
          const index = pair.runs.findIndex(
            (run) =>
              args[0].sessionKey === pair.requesterScope.sessionKey &&
              readMessageIdempotencyKey(args[1].message) === `${run.idempotencyKey}:user`,
          );
          if (index === 0 || index === 1) {
            sources[index] =
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.source;
            attempts.push(pair.runs[index].runId);
            gates[index].entered.resolve();
            await gates[index].resume.promise;
          }
          return stage(...args);
        });
      agentCommandMock.mockImplementation(async (input) => {
        const command = input as AgentCommandOpts;
        const child = pair.handleChildCommand(command);
        if (child) {
          return child;
        }
        requesterCommands += 1;
        requesterRuntimeContext.push(
          ...buildAgentInternalEventContext(
            command.internalEvents,
            command.runtimeContextFragments,
          ),
        );
        const recorder = expectDefined(
          command.userTurnTranscriptRecorder,
          "Expected real registered completion input recorder",
        );
        expect(await recorder.persistApproved()).toMatchObject({ appended: true });
        return { payloads: [{ text: "Child received", mediaUrl: null }], meta: { durationMs: 1 } };
      });
      try {
        await pair.complete(0);
        await withinTest(
          reachBoundary(gates[0].entered.promise, pair.runs[0].settled.promise),
          signal,
        );
        await pair.admitSuccessor();
        expect(attempts).toEqual([pair.runs[0].runId]);
        await pair.complete(1);
        await withinTest(
          reachBoundary(gates[1].entered.promise, pair.runs[1].settled.promise),
          signal,
        );
        const revokedIndex =
          revokedSource === "neither" ? -1 : revokedSource === "predecessor" ? 0 : 1;
        if (revokedIndex !== -1) {
          pair.runs[revokedIndex].revoked.abort(new Error("operator completion authority revoked"));
        }
        release();
        await pair.settle();
        await settleRequests();
        expect(attempts.toSorted()).toEqual(pair.runs.map((run) => run.runId).toSorted());
        const allowed = pair.runs.filter((_, index) => index !== revokedIndex);
        expect(requesterCommands).toBe(allowed.length);
        expect(agentCommandMock).toHaveBeenCalledTimes(2 + allowed.length);
        const events = sessionAccessor.loadTranscriptEventsSync(pair.requesterScope);
        const inputKeys = events.flatMap((event) =>
          isRecord(event) && isRecord(event.message) && event.message.role === "user"
            ? [readMessageIdempotencyKey(event.message)]
            : [],
        );
        expect(inputKeys).toHaveLength(allowed.length);
        expect(inputKeys).toEqual(
          expect.arrayContaining(allowed.map((run) => `${run.idempotencyKey}:user`)),
        );
        expect((await listSessionPendingInputs(pair.requesterScope)).total).toBe(0);
        const stored = loadSubagentRegistryFromSqlite();
        const runtimeContext = JSON.stringify(requesterRuntimeContext);
        for (const [index, run] of pair.runs.entries()) {
          // Exact source identity also catches borrowing when both sources remain live.
          expect(sources[index]).toBe(run.source.authority.source);
          if (index === revokedIndex) {
            expect(stored.get(run.runId)?.delivery?.status).not.toBe("delivered");
            expect(context.dedupe.has(`agent:${run.idempotencyKey}`)).toBe(false);
            expect(runtimeContext).not.toContain(run.result);
          } else {
            expect(stored.get(run.runId)?.delivery?.status).toBe("delivered");
            expect(context.dedupe.get(`agent:${run.idempotencyKey}`)).toMatchObject({ ok: true });
            expect(runtimeContext).toContain(run.result);
          }
          expect(JSON.stringify(events)).not.toContain(run.result);
          resumeSubagentRun(run.runId);
        }
        await pair.settle();
        await settleRequests();
        expect(requesterCommands).toBe(allowed.length);
        expect(agentCommandMock).toHaveBeenCalledTimes(2 + allowed.length);
        expect(sessionAccessor.loadTranscriptEventsSync(pair.requesterScope)).toEqual(events);
      } finally {
        release();
        await pair.dispose();
        await settleRequests();
        stageSpy.mockRestore();
        requestWork.mockRestore();
        signal.removeEventListener("abort", release);
      }
    },
  );

  it.for(["live", "operator-revoked", "requester-replaced"] as const)(
    "revalidates %s authority at real Gateway input staging",
    async (change, { signal }) => {
      await prepareGatewayReplyRuntimeForTest();
      const context = kernel.gatewayRequestContext;
      using completion = await createCompletion(context);
      const before = sessionAccessor.loadTranscriptEventsSync(completion.sessionScope);
      const entered = createDeferred();
      const resume = createDeferred();
      const release = () => resume.resolve();
      signal.addEventListener("abort", release, { once: true });
      const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
      const execution = vi.spyOn(executionModule, "startAgentRunExecution");
      const requestWork = vi.spyOn(context, "trackExecution");
      const settleRequests = () =>
        Promise.all(
          requestWork.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
      const stage = sessionAccessor.stageSessionPendingInput;
      const stageSpy = vi
        .spyOn(sessionAccessor, "stageSessionPendingInput")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          // Hold before acquiring the writer so a requester replacement can commit.
          await resume.promise;
          return await stage(...args);
        });
      agentCommandMock.mockImplementation(async (input) => {
        // SAFETY: The real Gateway dispatcher supplies AgentCommandOpts at this boundary.
        const command = input as AgentCommandOpts;
        const recorder = expectDefined(
          command.userTurnTranscriptRecorder,
          "Expected real native completion input recorder",
        );
        expect(await recorder.persistApproved()).toMatchObject({ appended: true });
        return { payloads: [{ text: "Child received", mediaUrl: null }], meta: { durationMs: 1 } };
      });
      expect(context.dedupe.has(`agent:${completion.idempotencyKey}`)).toBe(false);
      const delivery = completion.deliver();
      try {
        await reachBoundary(entered.promise, delivery);
        await completion.changeOwner(change);
        release();
        const result = await delivery;
        // The RPC responds before its request owner releases the unaccepted reservation.
        await settleRequests();
        if (change === "live") {
          expect(result).toMatchObject({ delivered: true, path: "direct" });
          expect(execution).toHaveBeenCalledOnce();
          expect(agentCommandMock).toHaveBeenCalledOnce();
          expect(context.dedupe.get(`agent:${completion.idempotencyKey}`)).toMatchObject({
            ok: true,
          });
          expect((await listSessionPendingInputs(completion.sessionScope)).total).toBe(0);
          expect(sessionAccessor.loadTranscriptEventsSync(completion.sessionScope)).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "user",
                idempotencyKey: `${completion.idempotencyKey}:user`,
              }),
            }),
          );
        } else {
          expect(result.delivered).toBe(false);
          expect(execution).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
          expect((await listSessionPendingInputs(completion.sessionScope)).total).toBe(0);
          expect(sessionAccessor.loadTranscriptEventsSync(completion.sessionScope)).toEqual(before);
          expect(context.dedupe.get(`agent:${completion.idempotencyKey}`)).toBeUndefined();
        }
      } finally {
        release();
        await Promise.allSettled([delivery, settleRequests()]);
        stageSpy.mockRestore();
        execution.mockRestore();
        requestWork.mockRestore();
        signal.removeEventListener("abort", release);
      }
    },
  );
});
