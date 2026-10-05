import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import {
  buildAgentRunBlockedUserMessage,
  runBeforeAgentRunGate,
} from "../../harness/before-agent-run.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { prepareSessionMessagePublication } from "../../sessions/agent-session-publication.js";
import { sessionManagerPrepareHistoryRead } from "../../sessions/session-manager-history.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { log } from "../logger.js";
import { sessionMessagesContainIdempotencyKey } from "./pre-persisted-user-turn.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;
type BeforeAgentRunHookRunner = Pick<HookRunner, "hasHooks" | "runBeforeAgentRun">;
type HookContext = Parameters<HookRunner["runBeforeAgentRun"]>[1];

type BeforeAgentRunSession = {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
};

type BeforeAgentRunBlockOutcome = {
  blockedBy: string;
  promptError: Error;
};

export async function runEmbeddedAttemptBeforeAgentRun(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "agentAccountId" | "runId" | "senderId" | "senderIsOwner"
  >;
  activeSession: BeforeAgentRunSession;
  hookContext: HookContext;
  hookMessages: AgentMessage[];
  hookRunner: BeforeAgentRunHookRunner | null;
  modelPrompt: string;
  sessionManager: ReturnType<typeof guardSessionManager>;
  systemPrompt: string;
  withOwnedTranscriptWrite: <T>(operation: () => Promise<T> | T) => Promise<T>;
}): Promise<BeforeAgentRunBlockOutcome | undefined> {
  const block = await runBeforeAgentRunGate(
    input.hookRunner,
    {
      prompt: input.modelPrompt,
      systemPrompt: input.systemPrompt,
      messages: input.hookMessages,
      channelId: input.hookContext.channelId,
      accountId: input.attempt.agentAccountId,
      senderId: input.attempt.senderId ?? undefined,
      senderIsOwner: input.attempt.senderIsOwner,
    },
    input.hookContext,
  );
  if (!block) {
    return undefined;
  }
  const redactedUserMessage = buildAgentRunBlockedUserMessage(input.attempt.runId, block);
  if (
    !sessionMessagesContainIdempotencyKey(
      input.activeSession.messages,
      redactedUserMessage.idempotencyKey,
    )
  ) {
    try {
      const publication = prepareSessionMessagePublication(() => input.activeSession.agent.state);
      const beforeAppend = input.sessionManager[sessionManagerPrepareHistoryRead]();
      await input.withOwnedTranscriptWrite(() =>
        withSessionManagerWrite(input.sessionManager, async () => {
          await input.sessionManager.appendMessageAsync(redactedUserMessage);
          input.sessionManager.flushPendingPersistence();
        }),
      );
      beforeAppend.assertNavigationCurrent();
      const history = input.sessionManager[sessionManagerPrepareHistoryRead]();
      const context = await history.readContext();
      history.assertCurrent();
      publication.publish(sanitizeCompactionReplayMessages(context.messages));
    } catch (err) {
      log.warn(
        `before_agent_run block: failed to finalize redacted user transcript: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { blockedBy: block.blockedBy, promptError: new Error(block.message) };
}
