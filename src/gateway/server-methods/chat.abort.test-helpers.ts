/**
 * Shared helpers for chat abort gateway method tests.
 */
import { randomUUID } from "node:crypto";
import { afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  abortSessionControllerInput,
  retireSessionControllerInput,
  releaseSessionControllerClaim,
  claimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import type {
  RpcSourceAdapter,
  RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { removeChatAbortControllerEntry } from "../chat-abort.js";
import { createChatRunState, type ChatRunState } from "../server-chat-state.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

type TestChatRunRecord =
  ReturnType<typeof createChatRunState>["runs"] extends Map<string, infer Record> ? Record : never;

export function createAbortTestRunState(entries: Array<[string, Partial<TestChatRunRecord>]>) {
  const state = createChatRunState();
  for (const [runId, record] of entries) {
    Object.assign(state.getOrCreate(runId), record);
  }
  return state;
}

const testSources = new Set<RpcSourceRef>();
const testAdmissions: Array<Promise<{ error: unknown } | undefined>> = [];
afterEach(async () => {
  const settlements = [...testSources].map((ref) => ref.input.settlement.promise);
  for (const ref of testSources) {
    abortSessionControllerInput(ref.input, "Fixture finished");
    if (!ref.input.claim) {
      retireSessionControllerInput(ref.input);
    }
  }
  testSources.clear();
  await Promise.allSettled(settlements);
  const results = await Promise.all(testAdmissions.splice(0));
  const failures = results.flatMap((result) => (result ? [result.error] : []));
  if (failures.length) {
    throw new AggregateError(failures, "Fixture admission failed");
  }
});

export function createActiveRun(
  sessionKey: string,
  params: {
    sessionId?: string;
    storeScope?: string;
    agentId?: string;
    controlUiVisible?: boolean;
    owner?: { connId?: string; deviceId?: string };
    turnKind?: "main" | "btw";
    queued?: boolean;
    runId?: string;
  } = {},
): RpcSourceRef {
  const adapter: RpcSourceAdapter = {
    sessionId: params.sessionId ?? `${sessionKey}-session`,
    sessionKey,
    agentId: params.agentId,
    controlUiVisible: params.controlUiVisible,
    ownerConnId: params.owner?.connId,
    ownerDeviceId: params.owner?.deviceId,
    turnKind: params.turnKind,
  };
  const input = reserveSessionControllerSource(sessionKey, {
    protocolRunId: params.runId,
    target: captureSessionTarget({
      storeScope: params.storeScope ?? `/synthetic/chat-abort/${randomUUID()}/sessions.db`,
      sessionKey,
      incarnation: adapter.sessionId,
      agentId: params.agentId,
    }),
    policy: { mode: "followup" },
    adapter,
  });
  const ref = { input, adapter };
  testSources.add(ref);
  if (!params.queued) {
    // Drive the actual mailbox admission before attaching the operation. Each
    // fixture has an isolated physical owner, not a fake activity field.
    let started = false;
    const admission = claimSessionControllerTask(input, (claim) => {
      started = true;
      const operation = createReplyOperation({
        sessionKey,
        sessionId: adapter.sessionId,
        agentId: params.agentId,
        resetTriggered: false,
        mailboxClaim: claim,
      });
      // This fixture owns a real producer that returns after observing cancellation.
      // Stop must still join its finally block rather than treating abort as settlement.
      void (async () => {
        try {
          await new Promise<void>((resolve) => {
            input.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          operation.complete();
          releaseSessionControllerClaim(claim);
        }
      })();
    });
    testAdmissions.push(
      admission.then(
        () => undefined,
        (error: unknown) => (!started && input.abortSignal.aborted ? undefined : { error }),
      ),
    );
  }
  return ref;
}

type ChatAbortTestContext = Record<string, unknown> & {
  rpcSources: Map<string, RpcSourceRef>;
  chatRunState: ChatRunState;
  dedupe: Map<string, unknown>;
  removeChatRun: (
    ...args: unknown[]
  ) => { sessionKey: string; agentId?: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (...args: unknown[]) => void;
  nodeSendToSession: (...args: unknown[]) => void;
  logGateway: { warn: (...args: unknown[]) => void };
};

type ChatAbortRespondMock = Mock<RespondFn>;

export function createChatAbortContext(
  overrides: Record<string, unknown> = {},
): ChatAbortTestContext {
  const chatRunState =
    overrides.chatRunState && typeof overrides.chatRunState === "object"
      ? (overrides.chatRunState as ChatRunState)
      : createChatRunState();
  const context = {
    rpcSources: new Map(),
    chatRunState,
    dedupe: new Map(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  } as ChatAbortTestContext;
  // Synthetic registrations retire through the real index owner only after the
  // producer's exact source receipt, preserving replacements and foreign runs.
  for (const [runId, ref] of context.rpcSources) {
    const remove = () => removeChatAbortControllerEntry(context.rpcSources, runId, ref);
    void ref.input.settlement.promise.then(remove, remove);
  }
  return context;
}

export async function invokeChatAbortHandler(params: {
  handler: GatewayRequestHandler;
  context: ChatAbortTestContext;
  request: {
    sessionKey: string;
    agentId?: string;
    runId?: string;
    preserveSideRuns?: boolean;
    discardPendingInput?: boolean;
  };
  client?: {
    connId?: string;
    connect?: {
      device?: { id?: string };
      scopes?: string[];
    };
  } | null;
  respond?: ChatAbortRespondMock;
}): Promise<ChatAbortRespondMock> {
  const respond = params.respond ?? vi.fn();
  await params.handler({
    params: params.request,
    respond: respond as never,
    context: params.context as never,
    req: {} as never,
    client: (params.client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return respond;
}
