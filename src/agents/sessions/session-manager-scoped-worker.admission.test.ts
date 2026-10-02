import fs from "node:fs";
import { getEnvironmentData, type Worker } from "node:worker_threads";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputWorkerAuthority,
  joinSessionPendingInputReceipt,
  type SessionPendingInputReceipt,
} from "../../config/sessions/session-accessor.pending-input-receipt.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { readSessionTranscriptContextMessages } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import * as pendingInputOwners from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { resolveSqliteTranscriptScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionPendingInputOwner } from "../../config/sessions/session-pending-input.types.js";
import {
  captureSessionTranscriptExecution,
  captureSessionTranscriptReadExecution,
  retainSessionTranscriptRead,
} from "../../config/sessions/session-transcript-execution.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { createChatSendWorkAdmission } from "../../gateway/server-methods/chat-send-work-lifetime.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
  captureGatewayPendingInputWorkerAuthority,
  prepareGatewayPendingInputWorkerAuthority,
} from "../../gateway/server-methods/session-mutation-guards.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "../../gateway/server-shared-auth-generation.js";
import { createOperatorWsClient } from "../../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resolveSessionMutationAuthorization } from "../../gateway/session-sharing.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { runInDetachedAsyncContext } from "../../shared/async-work-scope.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  retainGatewaySessionBroker,
} from "../../state/openclaw-agent-execution.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import * as messageRuntime from "./session-manager-message-runtime.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-metadata-contract.js";
import {
  createScopedWorkerFixture,
  runReadyPredecessorChild,
} from "./session-manager-scoped-worker.test-support.js";
import {
  captureSessionManagerHostExecution,
  withSessionManagerReadyWrite,
} from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
import type { SessionMessageAppendOutcome } from "./session-message-append-operation.js";
const nativeFault = vi.hoisted(() => ({
  control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3),
}));
const nativeFaultKey = "openclaw.test.sessionScopedNativeFault";
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 1,
}));
vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  // The data worker exits at the real receipt boundary. The service remains the
  // native parent and reports actual exit. Consume the arm before stopping so
  // the original owner's cleanup carrier cannot fire the same fault again.
  const preload = `
    import { getEnvironmentData, MessagePort } from "node:worker_threads";
    const control = new Int32Array(getEnvironmentData("openclaw.test.sessionScopedNativeFault"));
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...rest) {
      const mode = message?.kind === "native-commit" ? 1 :
        message?.kind === "native-settlement" ? 2 : 0;
      if (mode && Atomics.compareExchange(control, 0, mode, 0) === mode) {
        Atomics.add(control, mode, 1);
        process.exit(19);
      }
      return post.call(this, message, ...rest);
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      if (
        !options?.workerData?.carrierUrl ||
        getEnvironmentData(nativeFaultKey) !== nativeFault.control
      ) {
        return actual.createCpuTrackedWorker(filename, options);
      }
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        workerData: {
          ...options.workerData,
          execArgv: [
            ...options.workerData.execArgv,
            "--import",
            `data:text/javascript,${encodeURIComponent(preload)}`,
          ],
        },
      });
    },
  };
});

afterEach(() => vi.restoreAllMocks());
const { withReadyManager } = createScopedWorkerFixture(nativeFault, nativeFaultKey);

it("commits once through the retained manager host and refuses closed or foreign capture", async () => {
  await withReadyManager(async ({ manager, target, read }) => {
    const foreignTarget = {
      ...target,
      agentId: "other",
      sessionId: "foreign-host-owner",
      sessionKey: "agent:other:dashboard:incognito-foreign-host-owner",
      storePath: agentDatabase.resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "other",
        env: target.env,
      }),
    };
    const foreign = SessionManager.open(foreignTarget);
    foreign.appendMessage({ role: "user", content: "foreign original", timestamp: 1 });
    const beforeForeign = SessionManager.open(foreignTarget).getPersistedEntries();
    let retained: ReturnType<typeof captureSessionManagerHostExecution> | undefined;
    const message = {
      role: "user" as const,
      content: "retained host commit",
      timestamp: 2,
      idempotencyKey: "retained-host-once",
    };
    let committedId: string | undefined;
    withSessionManagerReadyWrite(manager, () => {
      retained = captureSessionManagerHostExecution(manager);
      expect(() => captureSessionManagerHostExecution(foreign)).toThrow(
        "no original host execution owner",
      );
      const host = retained;
      // A captured capability restores its owner; ambient async context is not authority.
      committedId = runInDetachedAsyncContext(() => host.run(() => manager.appendMessage(message)));
      expect(host.run(() => manager.appendMessage(message))).toBe(committedId);
    });
    assert(retained);
    expect(committedId).toEqual(expect.any(String));
    expect(read().map((entry) => entry.content)).toEqual(["opening turn", "retained host commit"]);
    const committed = SessionManager.open(target).getPersistedEntries();
    expect(manager.getEntries().filter((entry) => entry.id === committedId)).toHaveLength(1);
    const closedHost = retained;
    expect(() =>
      closedHost.run(() =>
        manager.appendMessage({
          role: "user",
          content: "closed host must not commit",
          timestamp: 3,
        }),
      ),
    ).toThrow("already settled");
    expect(SessionManager.open(target).getPersistedEntries()).toEqual(committed);
    expect(SessionManager.open(foreignTarget).getPersistedEntries()).toEqual(beforeForeign);
  });
});

it.each(["allowed", "revoked"] as const)(
  "retains maintenance authority through the nested SQLite commit grant (%s)",
  async (mode) => {
    await withReadyManager(async ({ manager, target, read }) => {
      const before = SessionManager.open(target).getPersistedEntries();
      const failure = new Error("Nested maintenance owner was revoked");
      let current = true;
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        assertOwnerCurrent() {
          if (!current) {
            throw failure;
          }
        },
      });
      const beforeFresh = vi.fn(() => {
        current = mode === "allowed";
      });
      let caught: unknown;
      try {
        try {
          maintenance.run(() =>
            SessionManager.readSessionContext(target, () => {
              manager.appendMessage(
                { role: "user", content: "nested maintenance commit", timestamp: 2 },
                { beforeFreshMessageCommit: beforeFresh },
              );
            }),
          );
        } catch (error) {
          caught = error;
        }
        // Restore only the injected fault, then inspect the original owner's final rows.
        current = true;
        expect(beforeFresh).toHaveBeenCalledOnce();
        if (mode === "allowed") {
          expect(caught).toBeUndefined();
          expect(read().map((message) => message.content)).toEqual([
            "opening turn",
            "nested maintenance commit",
          ]);
        } else {
          expect(caught).toBeDefined();
          expect(SessionManager.open(target).getPersistedEntries()).toEqual(before);
          expect(read()).toMatchObject([{ content: "opening turn" }]);
        }
      } finally {
        current = true;
        await maintenance.close();
      }
    });
  },
);

it.skipIf(Boolean(process.versions.bun)).for(["scope-free", "scoped", "queued-scoped"] as const)(
  "preserves original ready predecessor ownership (%s)",
  { timeout: 60_000 },
  async (mode, { signal }) => {
    const result = await runReadyPredecessorChild(mode, signal);
    expect(result.stdout).toContain("ready-predecessor:entered");
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ready-predecessor:complete");
  },
);

it("retires the logical volatile owner after requested native failure cleanup", async () => {
  await withReadyManager(async ({ target }) => {
    const execution = captureOpenClawAgentDatabaseExecution({
      agentId: target.agentId,
      path: target.storePath,
      env: target.env,
    });
    expect(execution.backend).toBe("volatile");
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent: () => execution.assertCurrent(),
      requiresHostContinuation: false,
      createAdmission: (binding) => () => ({
        nativeLocations: binding.nativeLocations,
        admission: operationAdmission.createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          execution.assertCurrent();
          if (!grant()) {
            throw new Error("Volatile retirement admission was refused");
          }
        }, binding.attachment),
      }),
    };
    const failure = new Error("Original volatile operation failed");
    const failedOperation = vi.fn(async () => {
      throw failure;
    });
    const successorOperation = vi.fn(async () => undefined);
    try {
      await expect(
        execution.runExisting(source, failedOperation, { retireNativeOnFailure: true }),
      ).rejects.toBe(failure);
      expect(failedOperation).toHaveBeenCalledOnce();
      expect(() => execution.assertCurrent()).toThrow();
      await expect(execution.runExisting(source, successorOperation)).rejects.toThrow();
      expect(successorOperation).not.toHaveBeenCalled();
      expect(fs.existsSync(target.storePath)).toBe(false);
    } finally {
      await execution.release();
    }
  });
});

it.each(
  (["message", "metadata"] as const).flatMap((first) =>
    (["commit", "rollback"] as const).map((boundary) => ({ first, boundary })),
  ),
)(
  "publishes the original volatile identity for $first-first initialization after outer $boundary",
  async ({ first, boundary }) => {
    await withReadyManager(async ({ target }) => {
      const selected = {
        ...target,
        sessionId: "initial-identity",
        sessionKey: "agent:main:initial-identity",
      };
      const manager = SessionManager.open(selected);
      const capturedTarget = manager.getSessionTarget();
      assert(capturedTarget);
      const readOwner = retainSessionTranscriptRead(capturedTarget, () => {});
      const metadataModule = resolveRuntimeWorkerUrl(
        runtimeProcessEntrypoints.sessionManagerMetadata,
      );
      const events: SessionIdentityMutation[] = [];
      const stop = onSessionIdentityMutation((event) => {
        if (event.kind !== "delete" && event.current.sessionKeys.includes(selected.sessionKey)) {
          events.push(event);
        }
      });
      const sourceIdentity = () => {
        const { env: _env, ...scope } = resolveSqliteTranscriptScope(capturedTarget);
        const reply = readOwner.executeReady(
          readOwner.command(metadataModule, {
            type: "session.metadata.entryRead",
            input: { scope, query: { kind: "row" } },
          }),
        ) as SessionMetadataWorkerOperations["session.metadata.entryRead"]["output"];
        assert(reply.ok);
        expect(reply.value.result.kind).toBe("row");
        return reply.value.physical.identity;
      };
      const appendInitial = () =>
        first === "message"
          ? manager.appendMessage({ role: "user", content: "initial identity", timestamp: 2 })
          : manager.appendCustomEntry("initial identity", { retained: true });
      const failure = new Error("Original initialization rolled back");
      let originalIdentity: string | undefined;
      try {
        const initialize = () =>
          SessionManager.readSessionContext(selected, () => {
            appendInitial();
            originalIdentity = sourceIdentity();
            expect(events).toEqual([]);
            if (boundary === "rollback") {
              throw failure;
            }
          });
        if (boundary === "rollback") {
          expect(initialize).toThrow(failure);
          expect(events).toEqual([]);
          appendInitial();
        } else {
          initialize();
        }
        expect(originalIdentity).toEqual(expect.any(String));
        expect(sourceIdentity()).toBe(originalIdentity);
        expect(events).toEqual([
          expect.objectContaining({
            kind: "create",
            agentId: selected.agentId,
            databaseIdentity: originalIdentity,
            current: { sessionId: selected.sessionId, sessionKeys: [selected.sessionKey] },
          }),
        ]);
        manager.appendMessage({ role: "user", content: "warm identity", timestamp: 3 });
        manager.appendCustomEntry("warm metadata", {});
        expect(events).toHaveLength(1);
        expect(sourceIdentity()).toBe(originalIdentity);
      } finally {
        stop();
        await readOwner.close();
      }
    });
  },
);

it.each(["resolved", "retained"] as const)(
  "retains the resolved logical read identity when agentId is omitted (%s)",
  async (route) => {
    await withReadyManager(async ({ target }) => {
      const selected = {
        agentId: "secondary",
        sessionId: "logical-read-owner",
        sessionKey: "agent:secondary:dashboard:incognito-logical-read",
        storePath: agentDatabase.resolveIncognitoOpenClawAgentSqlitePath({
          agentId: "secondary",
          env: target.env,
        }),
        env: target.env,
      };
      const manager = SessionManager.open(selected);
      manager.appendMessage({ role: "user", content: "secondary owner", timestamp: 2 });
      const original =
        route === "retained"
          ? captureSessionTranscriptExecution(captureSessionTranscriptTargetBinding(selected))
          : selected;
      const { agentId: omitted, ...source } = original;
      expect(omitted).toBe("secondary");
      const captured = captureSessionTranscriptReadExecution(source);
      assert(captured);
      expect(captured.scope.agentId).toBe("secondary");
      expect(captured.scope.sessionKey).toBe(selected.sessionKey);
      expect(captured.execution.agentId).toBe("secondary");
      expect(
        readSessionTranscriptContextMessages(source, (messages) => [...messages]),
      ).toMatchObject([{ content: "secondary owner" }]);
      expect(
        captureSessionTranscriptReadExecution({
          sessionId: selected.sessionId,
          storePath: selected.storePath,
          env: selected.env,
        }),
      ).toBeUndefined();
      expect(
        captureSessionTranscriptReadExecution({
          ...selected,
          sessionKey: "agent:secondary:ordinary",
          storePath: `${selected.storePath}.ordinary`,
        }),
      ).toBeUndefined();
      await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(selected.storePath, "secondary");
      expect(() => captured.execution.assertCurrent()).toThrow();
      expect(fs.existsSync(selected.storePath)).toBe(false);
    });
  },
);

it("binds only the original pending-input component to its opaque durable authority", async () => {
  await withOpenClawTestState({ label: "session-pending-component" }, async (state) => {
    const database = agentDatabase.openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const foreignDatabase = agentDatabase.openOpenClawAgentDatabase({
      agentId: "main",
      path: state.path("foreign-agent.sqlite"),
      env: state.env,
    });
    const selected = {
      agentId: "main",
      sessionId: "outer-durable",
      sessionKey: "agent:main:outer-durable",
      storePath: database.path,
      env: state.env,
    };
    const { storePath, sessionKey } = selected;
    const owners: SessionPendingInputOwner[] = [];
    const receipts: SessionPendingInputReceipt[] = [];
    const register = pendingInputOwners.registerSessionPendingInputOwner;
    const registration = vi
      .spyOn(pendingInputOwners, "registerSessionPendingInputOwner")
      .mockImplementation((owner) => {
        register(owner);
        owners.push(owner);
      });
    const finishReceipts = async () => {
      const settlements = await Promise.allSettled(
        receipts.map(async (receipt) => {
          try {
            receipt.finish("interrupted");
          } finally {
            await joinSessionPendingInputReceipt(receipt);
          }
        }),
      );
      const failures = settlements.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Pending component cleanup failed");
      }
    };
    let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
    try {
      const client = createOperatorWsClient();
      const cfg = { agents: { list: [{ id: "main" }] } };
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const device = captureGatewayDeviceRevocation(context, {}, () => !client.invalidated);
      const authorities: Awaited<ReturnType<typeof prepareGatewayPendingInputWorkerAuthority>>[] =
        [];
      let work: ReturnType<typeof createChatSendWorkAdmission> | undefined;
      try {
        const params = {
          sessionKey,
          message: "component input",
          idempotencyKey: "component-durable",
        };
        for (const current of [database, foreignDatabase]) {
          writeSessionEntry(current, sessionKey, {
            sessionId: selected.sessionId,
            updatedAt: 1,
          });
        }
        const resolved = resolveSessionMutationAuthorization({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        expect(resolved.error).toBeNull();
        const authorization = resolved.authorization;
        assert(authorization);
        // Stage through the native producer before enrollment. Incognito staging has
        // no worker producer, so a registry-only volatile owner would fake its lifetime.
        const receiptFor = async (current: typeof database, suffix: string) => {
          const receipt = await stageSessionPendingInput(
            { ...selected, storePath: current.path },
            {
              runId: `${params.idempotencyKey}:${suffix}`,
              message: {
                role: "user",
                content: params.message,
                timestamp: 1,
                idempotencyKey: `${params.idempotencyKey}:${suffix}:user`,
              },
              assertCurrent: authorization.assertCurrent,
            },
          );
          assert(receipt);
          receipts.push(receipt);
          expect(receipt.state).toBe("queued");
          const owner = owners.find((candidate) => candidate.inputId === receipt.inputId);
          assert(owner);
          return { owner, receipt };
        };
        const original = await receiptFor(database, "original");
        const foreign = await receiptFor(foreignDatabase, "foreign");
        expect(registration).toHaveBeenCalledTimes(2);
        expect(original.owner.databasePath).toBe(database.path);
        expect(foreign.owner.databasePath).toBe(foreignDatabase.path);
        expect(foreign.owner.databasePath).not.toBe(original.owner.databasePath);
        registration.mockRestore();
        broker = retainGatewaySessionBroker();
        await broker.ready;
        const hostOpen = vi
          .spyOn(agentDatabase, "openOpenClawAgentDatabase")
          .mockImplementation(() => {
            throw new Error("Pending component binding attempted to open agent SQLite on the host");
          });
        try {
          const request: GatewayRequestOptions = {
            req: { type: "req", id: params.idempotencyKey, method: "chat.send", params },
            client,
            context,
            respond: vi.fn(),
            isWebchatConnect: () => true,
            hasCurrentClientAuthority: device.isCurrent,
          };
          bindWebSocketRequestMutationAuthority(
            request,
            client,
            new SharedGatewaySessionGenerationState({ current: undefined, required: null }).reader,
          );
          const handler = bindGatewayRequestHandlerMutationAuthority(
            request,
            { ...request, params, sessionMutationAuthorization: authorization },
            undefined,
          );
          const admission = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, selected.sessionId],
            assertAllowed: authorization.assertCurrent,
          });
          work = createChatSendWorkAdmission({
            admission,
            logGateway: { warn: vi.fn() },
            releaseCallerAuthority: device.release,
          });
          const lifetime = work.captureInputLifetime({
            controller: new AbortController(),
            queuedTurns: new Map(),
            runId: params.idempotencyKey,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          });
          const prepare = async () => {
            const authority = await prepareGatewayPendingInputWorkerAuthority(handler, lifetime);
            assert(authority);
            authorities.push(authority);
            expect(authority.workerRead.kind).toBe("durable");
            return authority;
          };
          const first = await prepare();
          expect(() =>
            captureGatewayPendingInputWorkerAuthority({ workerRead: first.workerRead }),
          ).toThrow("original worker authority");
          expect(() => bindSessionPendingInputWorkerAuthority(foreign.receipt, first)).toThrow(
            "another physical session",
          );
          expect(foreign.owner.worker).toBeUndefined();
          expect(bindSessionPendingInputWorkerAuthority({ ...original.receipt }, first)).toBe(
            false,
          );
          expect(original.owner.worker).toBeUndefined();
          const authority = await prepare();
          expect(bindSessionPendingInputWorkerAuthority(original.receipt, authority)).toBe(true);
          expect(original.owner.worker?.authority).toBe(authority);
          expect(original.owner.worker?.authority.workerRead).toEqual(authority.workerRead);
          const run = vi.fn(() => "original lifetime");
          expect(original.receipt.run(run)).toBe("original lifetime");
          admission.release();
          expect(() => original.receipt.run(run)).toThrow();
          expect(run).toHaveBeenCalledOnce();
          expect(hostOpen).not.toHaveBeenCalled();
        } finally {
          hostOpen.mockRestore();
        }
        await finishReceipts();
        for (const [current, pending] of [
          [database, original],
          [foreignDatabase, foreign],
        ] as const) {
          expect(
            pendingInputOwners.readSessionPendingInputByKey(
              current,
              selected,
              pending.owner.idempotencyKey,
            ),
          ).toMatchObject({
            input_id: pending.receipt.inputId,
            state: "interrupted",
            consumed_event_id: null,
            message_json: pending.owner.messageJson,
          });
          expect(() => pending.receipt.run(() => {})).toThrow("ownership ended");
        }
      } finally {
        try {
          await finishReceipts();
        } finally {
          try {
            for (const authority of authorities) {
              authority?.release();
            }
          } finally {
            if (work) {
              await work.release();
            } else {
              device.release();
            }
          }
        }
      }
    } finally {
      registration.mockRestore();
      try {
        await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(database.path);
      } finally {
        try {
          await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(foreignDatabase.path);
        } finally {
          await broker?.stop();
        }
      }
    }
  });
});

it.each(["ready", "async"] as const)(
  "adopts the native initialization header before %s first-message publication",
  async (mode) => {
    await withReadyManager(async ({ manager, target }) => {
      const freshTarget = {
        ...target,
        sessionId: "canonical-initial-header",
        sessionKey: "agent:main:dashboard:canonical-initial-header",
      };
      const fresh = SessionManager.open(freshTarget, manager.getCwd());
      const view = (owner: SessionManager) =>
        structuredClone({
          header: owner.getHeader(),
          entries: owner.getEntries(),
          tree: owner.getTree(),
          branch: owner.getBranch(),
          context: owner.buildSessionContext(),
          leaf: owner.getLeafId(),
          parent: owner.getAppendParentId(),
          mode: owner.getAppendMode(),
          boundaries: owner.getBoundaryCount(),
          cwd: owner.getCwd(),
        });
      const observed: ReturnType<typeof view>[] = [];
      installSessionToolResultGuard(fresh, {
        onMessagePersisted: () => {
          observed.push(view(fresh));
        },
      });
      const outcomes: SessionMessageAppendOutcome[] = [];
      const routes: string[] = [];
      const createRuntime = messageRuntime.createSessionManagerMessageRuntime;
      const runtimeSpy = vi
        .spyOn(messageRuntime, "createSessionManagerMessageRuntime")
        .mockImplementation((params) => {
          const runtime = createRuntime(params);
          return {
            ...runtime,
            async append(...args) {
              const outcome = await runtime.append(...args);
              if (params.scope.sessionId === freshTarget.sessionId) {
                outcomes.push(outcome);
                routes.push("async");
              }
              return outcome;
            },
            appendReady(...args) {
              const outcome = runtime.appendReady(...args);
              if (params.scope.sessionId === freshTarget.sessionId) {
                outcomes.push(outcome);
                routes.push("ready");
              }
              return outcome;
            },
          };
        });
      try {
        for (const index of [0, 1]) {
          const message = { role: "user" as const, content: `turn ${index}`, timestamp: index + 1 };
          const id =
            mode === "ready"
              ? fresh.appendMessage(message)
              : await fresh.appendMessageAsync(message);
          expect(routes).toEqual(Array(index + 1).fill(mode));
          expect(outcomes).toHaveLength(index + 1);
          const outcome = outcomes[index];
          assert(outcome?.kind === "committed");
          expect(outcome.failures).toEqual([]);
          assert(outcome.facts.kind === "manager");
          expect(outcome.facts.receipt.appended).toBe(true);
          expect(outcome.facts.receipt.messageId).toBe(id);
          assert(outcome.value);
          if (index === 0) {
            expect(outcome.facts.initial?.owned).toBe(true);
            expect(outcome.value.reload?.kind).toBe("full");
          } else {
            expect(outcome.facts.initial).toBeUndefined();
            expect(outcome.value.reload).toBeUndefined();
          }
          const committed = view(SessionManager.open(freshTarget, manager.getCwd()));
          expect(view(fresh)).toStrictEqual(committed);
          expect(observed).toHaveLength(index + 1);
          expect(observed[index]).toStrictEqual(committed);
        }
      } finally {
        runtimeSpy.mockRestore();
      }
    });
  },
);

it.each(["ready", "async"] as const)(
  "adopts the native bounded initialization header before %s first-message publication",
  async (mode) => {
    await withReadyManager(async ({ manager, target }) => {
      const freshTarget = {
        ...target,
        sessionId: "bounded-canonical-initial-header",
        sessionKey: "agent:main:dashboard:bounded-canonical-initial-header",
      };
      const limits = { cwd: manager.getCwd(), maxBytes: 4096, maxEvents: 1 };
      const openBounded = () =>
        mode === "ready"
          ? SessionManager.openBounded(freshTarget, limits)
          : SessionManager.openBoundedAsync(freshTarget, limits);
      const fresh = await openBounded();
      const view = (owner: SessionManager) =>
        structuredClone({
          header: owner.getHeader(),
          entries: owner.getEntries(),
          tree: owner.getTree(),
          branch: owner.getBranch(),
          context: owner.buildSessionContext(),
          leaf: owner.getLeafId(),
          parent: owner.getAppendParentId(),
          mode: owner.getAppendMode(),
          boundaries: owner.getBoundaryCount(),
          cwd: owner.getCwd(),
        });
      expect(fresh.getEntries()).toEqual([]);
      const observed: ReturnType<typeof view>[] = [];
      installSessionToolResultGuard(fresh, {
        onMessagePersisted: () => {
          observed.push(view(fresh));
        },
      });
      const outcomes: SessionMessageAppendOutcome[] = [];
      const routes: string[] = [];
      const createRuntime = messageRuntime.createSessionManagerMessageRuntime;
      const runtimeSpy = vi
        .spyOn(messageRuntime, "createSessionManagerMessageRuntime")
        .mockImplementation((params) => {
          const runtime = createRuntime(params);
          return {
            ...runtime,
            async append(...args) {
              const outcome = await runtime.append(...args);
              if (params.scope.sessionId === freshTarget.sessionId) {
                outcomes.push(outcome);
                routes.push("async");
              }
              return outcome;
            },
            appendReady(...args) {
              const outcome = runtime.appendReady(...args);
              if (params.scope.sessionId === freshTarget.sessionId) {
                outcomes.push(outcome);
                routes.push("ready");
              }
              return outcome;
            },
          };
        });
      const beforeFresh = vi.fn();
      const messages = [0, 1].map((index) => ({
        role: "user" as const,
        content: `bounded turn ${index}`,
        timestamp: index + 1,
        idempotencyKey: `bounded-header-${index}`,
      }));
      const ids: string[] = [];
      const committedViews: ReturnType<typeof view>[] = [];
      const append = (message: (typeof messages)[number]) =>
        mode === "ready"
          ? fresh.appendMessage(message, { beforeFreshMessageCommit: beforeFresh })
          : fresh.appendMessageAsync(message, { beforeFreshMessageCommit: beforeFresh });
      try {
        for (const [index, message] of messages.entries()) {
          const id = await append(message);
          assert(typeof id === "string");
          ids.push(id);
          expect(routes).toEqual(Array(index + 1).fill(mode));
          expect(outcomes).toHaveLength(index + 1);
          expect(beforeFresh).toHaveBeenCalledTimes(index + 1);
          const outcome = outcomes[index];
          assert(outcome?.kind === "committed");
          expect(outcome.failures).toEqual([]);
          assert(outcome.facts.kind === "manager");
          expect(outcome.facts.receipt.appended).toBe(true);
          expect(outcome.facts.receipt.messageId).toBe(id);
          if (index === 0) {
            expect(outcome.facts.initial?.owned).toBe(true);
          } else {
            expect(outcome.facts.initial).toBeUndefined();
          }
          assert(outcome.value?.reload?.kind === "bounded");
          expect(outcome.value.reload.snapshot.truncated).toBe(index === 1);
          expect(outcome.value.reload.snapshot.serializedBytes).toBeLessThanOrEqual(
            limits.maxBytes,
          );

          const bounded = view(await openBounded());
          const committed = view(SessionManager.open(freshTarget, manager.getCwd()));
          expect(view(fresh)).toStrictEqual(bounded);
          expect(observed).toHaveLength(index + 1);
          expect(observed[index]).toStrictEqual(bounded);
          expect(bounded.header).toStrictEqual(committed.header);
          expect(bounded.entries.map((entry) => entry.id)).toEqual([id]);
          expect(committed.entries.map((entry) => entry.id)).toEqual(ids);
          expect(committed.context.messages).toEqual(messages.slice(0, index + 1));
          if (index === 1) {
            expect(fresh.getEntry(ids[0]!)).toBeUndefined();
            expect(committed.header).toStrictEqual(committedViews[0]!.header);
          }
          committedViews.push(committed);
        }
        const beforeReplay = view(fresh);
        // Current-key replay still validates its real anchor, but must not append again.
        expect(await append({ ...messages[1]!, content: "ignored bounded replay" })).toBe(ids[1]);
        expect(routes).toEqual([mode, mode]);
        expect(outcomes).toHaveLength(2);
        expect(beforeFresh).toHaveBeenCalledTimes(2);
        expect(observed).toHaveLength(2);
        expect(view(fresh)).toStrictEqual(beforeReplay);
        expect(view(SessionManager.open(freshTarget, manager.getCwd()))).toStrictEqual(
          committedViews[1],
        );
      } finally {
        runtimeSpy.mockRestore();
      }
    });
  },
);
