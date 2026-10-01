// Implements session abort commands and active-run stop targeting.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../../config/sessions.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
  type AbortCutoff,
} from "./abort-cutoff.js";
import {
  abortSessionRunTargetWithOutcome,
  captureChannelSessionStop,
  stopSubagentsForRequester,
  type ChannelStopCapture,
} from "./abort-operation.js";
import { setAbortMemory } from "./abort-primitives.js";
import { isAbortTrigger } from "./abort-trigger-text.js";
import { formatAbortReplyText } from "./abort.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import {
  persistAbortTargetEntry,
  resolveCommandSessionEntryForKey,
} from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

type AbortTarget = {
  entry?: SessionEntry;
  key?: string;
  sessionId?: string;
};

function resolveAbortTarget(params: {
  ctx: { CommandTargetSessionKey?: string | null };
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}): AbortTarget {
  const targetSessionKey =
    normalizeOptionalString(params.ctx.CommandTargetSessionKey) || params.sessionKey;
  const resolved = resolveCommandSessionEntryForKey(params.sessionStore, targetSessionKey);
  const entry =
    resolved.entry ??
    (targetSessionKey && targetSessionKey === params.sessionKey ? params.sessionEntry : undefined);
  const key = resolved.key ?? targetSessionKey;
  return {
    entry,
    key,
    sessionId: entry?.sessionId,
  };
}

function resolveAbortCutoffForTarget(params: {
  ctx: Parameters<CommandHandler>[0]["ctx"];
  commandSessionKey?: string;
  targetSessionKey?: string;
}): AbortCutoff | undefined {
  if (
    !shouldPersistAbortCutoff({
      commandSessionKey: params.commandSessionKey,
      targetSessionKey: params.targetSessionKey,
    })
  ) {
    return undefined;
  }
  return resolveAbortCutoffFromContext(params.ctx);
}

async function applyAbortTarget(params: {
  isCurrent?: () => boolean;
  capture: ChannelStopCapture;
  source: "channel-stop" | "channel-abort";
  retirements: Promise<void>[];
  abortTarget: AbortTarget;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortKey?: string;
  abortCutoff?: AbortCutoff;
}) {
  const { abortTarget } = params;
  if (params.isCurrent?.() === false) {
    throw new Error("The selected session changed before it could be stopped.");
  }
  const abortOutcome = abortSessionRunTargetWithOutcome({
    capture: params.capture,
    source: params.source,
    retirements: params.retirements,
    assertCurrent: () => {
      if (params.isCurrent?.() === false) {
        throw new Error("The selected session changed before it could be stopped.");
      }
    },
  });
  if (abortOutcome.active && !abortOutcome.aborted) {
    return abortOutcome;
  }

  const persisted = await persistAbortTargetEntry({
    isCurrent: params.isCurrent,
    entry: abortTarget.entry,
    key: abortTarget.key,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortCutoff: params.abortCutoff,
  });
  if (!persisted && params.abortKey && params.isCurrent?.() !== false) {
    setAbortMemory(params.abortKey, true);
  }
  return abortOutcome;
}

function buildAbortTargetApplyParams(
  params: Parameters<CommandHandler>[0],
  abortTarget: AbortTarget,
) {
  return {
    isCurrent: params.opts?.isCommandTargetCurrent,
    abortTarget,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortKey: params.command.abortKey,
    abortCutoff: resolveAbortCutoffForTarget({
      ctx: params.ctx,
      commandSessionKey: params.sessionKey,
      targetSessionKey: abortTarget.key,
    }),
  };
}

function captureAbortTarget(
  params: Parameters<CommandHandler>[0],
  abortTarget: AbortTarget,
  includeQueued: boolean,
) {
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: abortTarget.key ?? params.sessionKey ?? "",
    fallbackAgentId: params.agentId,
  });
  return captureChannelSessionStop({
    key: abortTarget.key,
    sessionId: abortTarget.sessionId,
    agentId,
    storePath:
      params.storePath ?? resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
    includeQueued,
  });
}

async function completeAbortRetirements<T>(
  run: () => Promise<T>,
  retirements: Promise<void>[],
): Promise<T> {
  const [outcome] = await Promise.allSettled([run()]);
  const settled = await Promise.allSettled(retirements);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

export const handleStopCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/stop", match: (body) => (body === "/stop" ? true : null) },
  async (params) => {
    const abortTarget = resolveAbortTarget(params);
    const capture = captureAbortTarget(params, abortTarget, true);
    abortTarget.sessionId = capture.sessionId;
    const retirements: Promise<void>[] = [];
    let abortOutcome = { active: false, aborted: false };
    const assertCurrent = () => {
      if (params.opts?.isCommandTargetCurrent?.() === false) {
        throw new Error("The selected session changed before it could be stopped.");
      }
    };
    const stop = async () => {
      // Capture child generations/holds synchronously; use only the parent's
      // already-captured controller references inside the awaited callback.
      const { stopped, failed } = await stopSubagentsForRequester({
        cfg: params.cfg,
        requesterSessionKey: abortTarget.key ?? params.sessionKey,
        requesterAgentId: params.agentId,
        assertCurrent,
        beforeKill: async () => {
          abortOutcome = await applyAbortTarget({
            ...buildAbortTargetApplyParams(params, abortTarget),
            capture,
            source: "channel-stop",
            retirements,
          });
          // A frozen parent can refuse cancellation without vetoing independent
          // queue cleanup, the command hook, or authorized child cancellation.
          assertCurrent();
          const hookEvent = createInternalHookEvent(
            "command",
            "stop",
            abortTarget.key ?? params.sessionKey ?? "",
            {
              sessionEntry: abortTarget.entry,
              sessionId: abortTarget.sessionId,
              commandSource: params.command.surface,
              senderId: params.command.senderId,
            },
          );
          assertCurrent();
          await triggerInternalHook(hookEvent);
          return true;
        },
      });
      const rejectionReason =
        abortOutcome.active && !abortOutcome.aborted ? ("finalizing" as const) : undefined;
      return commandReply(formatAbortReplyText(stopped, rejectionReason, failed));
    };
    return await completeAbortRetirements(stop, retirements);
  },
);

export const handleAbortTrigger: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "abort trigger",
    match: (_body, params) => (isAbortTrigger(params.command.rawBodyNormalized) ? true : null),
  },
  async (params) => {
    const abortTarget = resolveAbortTarget(params);
    // Bare abort retains its narrow active-turn scope: no queued inputs or children.
    const capture = captureAbortTarget(params, abortTarget, false);
    const retirements: Promise<void>[] = [];
    const abort = async () => {
      const abortOutcome = await applyAbortTarget({
        ...buildAbortTargetApplyParams(params, abortTarget),
        capture,
        source: "channel-abort",
        retirements,
      });
      const rejectionReason =
        abortOutcome.active && !abortOutcome.aborted ? ("finalizing" as const) : undefined;
      return commandReply(formatAbortReplyText(undefined, rejectionReason));
    };
    return await completeAbortRetirements(abort, retirements);
  },
);
