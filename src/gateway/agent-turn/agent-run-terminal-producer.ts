import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { getRpcSourceStartedAt } from "../../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";

/** Binds canonical transcript settlement to the exact registered API producer. */
export function bindGatewayAgentTerminalProducer(params: {
  runId: string;
  entry: ChatAbortControllerEntry | undefined;
  controller: Pick<AbortController, "signal" | "abort">;
  ingressOpts: { abortSignal?: AbortSignal };
  rpcSources: Map<string, ChatAbortControllerEntry>;
  isOwnerReleased: () => boolean;
}): {
  complete: () => Promise<void>;
  settle: <T>(execution: Promise<T>) => Promise<T>;
} {
  const { entry, controller } = params;
  const registeredRunInstance = entry?.adapter.operationalRunInstance;
  const registeredLifecycleGeneration = entry?.adapter.lifecycleGeneration;
  const registeredSessionKey = entry?.adapter.sessionKey;
  const producerCompletion = createDeferredCore();
  let terminalSettlement: Promise<void> | undefined;
  if (entry && params.ingressOpts.abortSignal === controller.signal) {
    entry.adapter.resolveTerminalProducer = () => {
      const { sessionId, sessionKey } = entry.adapter;
      const isCurrent = () => {
        const authority = entry.adapter.agentRunDelegatedAuthority;
        return (
          !params.isOwnerReleased() &&
          !controller.signal.aborted &&
          params.ingressOpts.abortSignal === controller.signal &&
          params.rpcSources.get(params.runId) === entry &&
          entry.input.abortSignal === controller.signal &&
          entry.adapter.operationalRunInstance === registeredRunInstance &&
          entry.adapter.lifecycleGeneration === registeredLifecycleGeneration &&
          entry.adapter.sessionId === sessionId &&
          entry.adapter.sessionKey === sessionKey &&
          sessionKey === registeredSessionKey &&
          !entry.adapter.registrationCleanupRequested &&
          (!registeredLifecycleGeneration ||
            isAgentEventLifecycleGenerationCurrent(registeredLifecycleGeneration)) &&
          (getRpcSourceStartedAt(entry) === undefined || authority !== undefined) &&
          (!authority ||
            (authority.operationalRunInstance === registeredRunInstance &&
              validateAgentRunDelegatedAuthority(authority)))
        );
      };
      if (!isCurrent()) {
        return undefined;
      }
      return {
        sessionId,
        sessionKey,
        handoff: (settle) => {
          if (!isCurrent()) {
            return false;
          }
          const settlement = settle(producerCompletion.promise);
          terminalSettlement = terminalSettlement
            ? Promise.all([terminalSettlement, settlement]).then(() => undefined)
            : settlement;
          return true;
        },
      };
    };
  }
  const complete = async () => {
    producerCompletion.resolve();
    let joined: Promise<void> | undefined;
    do {
      joined = terminalSettlement;
      await joined;
    } while (joined !== terminalSettlement);
  };
  return {
    complete,
    async settle<T>(execution: Promise<T>): Promise<T> {
      try {
        return await execution;
      } finally {
        await complete();
      }
    },
  };
}
