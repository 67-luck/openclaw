import crypto from "node:crypto";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { ReplyOperation, ReplyTurnKind } from "../../sessions/session-controller.js";
import {
  attachSessionControllerInputOperation,
  bindSessionControllerInputOperation,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { normalizeVerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { resolveAdmittedRunSessionFile } from "./agent-runner-core.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
} from "./agent-runner-utils.js";
import {
  shouldNotifyUserAboutCompaction,
  type CompactionNoticePhase,
} from "./compaction-notice.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { refreshActiveGoalContext } from "./inbound-meta.js";
import { isFollowupRunAborted, resolveFollowupAbortSignal, type FollowupRun } from "./queue.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { prepareReplyTurnContext } from "./reply-turn-preflight.js";
import type { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import type { TypingController } from "./typing.js";
export type FollowupRunnerParams = {
  resolveGatewayContext?: GatewayContextResolver;
  opts?: InternalGetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  toolProgressDetail?: "explain" | "raw";
};
export type ReplyTurnSessionOwner = {
  current: () => SessionEntry | undefined;
  publish(entry: SessionEntry | undefined): void;
} & ({ kind: "detached" } | { kind: "session"; key: string; storePath?: string });
export type AdmittedFollowupTurn = {
  runId: string;
  queued: FollowupRun;
  operation: ReplyOperation;
  config: OpenClawConfig;
  session: ReplyTurnSessionOwner;
  sessionStore?: Record<string, SessionEntry>;
  sendPolicy: "allow" | "deny";
  preflightCompactionApplied: boolean;
  preflightFailurePayload?: ReplyPayload;
  preflightError?: unknown;
};

/** Claims and prepares an immediate or queued reply through one admission and preflight path. */
export async function prepareReplyAgentTurn<TConfigured = undefined>(params: {
  queued: FollowupRun;
  defaults: FollowupRunnerParams;
  kind?: ReplyTurnKind;
  resetTriggered?: boolean;
  routeThreadId?: string | number;
  providedReplyOperation?: ReplyOperation;
  rotationEvidence?: ReturnType<typeof createReplyTurnRotationEvidence>;
  claimSource?: () => Promise<SessionControllerMailboxClaim | undefined>;
  onBeforeClaimWait?: () => void;
  configure?: (config: OpenClawConfig) => Promise<TConfigured> | TConfigured;
  signalRunStart?: () => Promise<void>;
  trace?: <T>(phase: string, run: () => Promise<T>) => Promise<T>;
  onCompactionNotice?: (
    phase: CompactionNoticePhase,
    text: string | undefined,
    turn: AdmittedFollowupTurn,
  ) => Promise<void>;
}) {
  const assertOperatorCurrent = () => params.queued.operatorAuthority?.assertCurrent();
  assertOperatorCurrent();
  const existingClaim = params.queued.controllerInput?.claim;
  // A queued source is claimed before async preparation so Stop selects it as an owned
  // source; an immediate turn waits for its claim only after configuration.
  const claimQueuedFirst = !params.providedReplyOperation && !params.claimSource;
  let mailboxClaim: SessionControllerMailboxClaim | undefined;
  try {
    if (claimQueuedFirst) {
      mailboxClaim = await claimSessionControllerInput(params.queued);
    }
    const resolvedConfig = await resolveQueuedReplyExecutionConfig(params.queued.run.config, {
      originatingChannel: params.queued.originatingChannel,
      messageProvider: params.queued.run.messageProvider,
      originatingAccountId: params.queued.originatingAccountId,
      agentAccountId: params.queued.run.agentAccountId,
    });
    assertOperatorCurrent();
    const config = resolveQueuedReplyRuntimeConfig(resolvedConfig);
    const configured = (await params.configure?.(config)) as TConfigured;
    params.onBeforeClaimWait?.();
    if (!claimQueuedFirst) {
      mailboxClaim = await (params.providedReplyOperation ? undefined : params.claimSource?.());
    }
    if (!mailboxClaim && !params.providedReplyOperation) {
      return { kind: "skipped", reason: "active-run" } as const;
    }

    const sessionKey = params.queued.run.sessionKey ?? params.defaults.sessionKey;
    const initialEntry = sessionKey
      ? (params.defaults.sessionStore?.[sessionKey] ?? params.defaults.sessionEntry)
      : params.defaults.sessionEntry;
    const sourceSignal = resolveFollowupAbortSignal(params.queued);
    const kind = params.kind ?? "queued_followup";
    const admission = params.providedReplyOperation
      ? {
          status: "owned" as const,
          operation: params.providedReplyOperation,
          sessionEntry: initialEntry,
        }
      : await admitReplyTurn({
          mailboxClaim,
          rotationEvidence: params.rotationEvidence,
          runId: params.queued.controllerInput?.protocolRunId,
          providerReviewAcknowledgment: params.defaults.opts?.providerReviewAcknowledgment,
          agentId: params.queued.run.agentId,
          resolveGatewayContext: params.defaults.resolveGatewayContext,
          sessionId: params.queued.admissionSessionId ?? params.queued.run.sessionId,
          sessionKey: sessionKey ?? "",
          expectedSessionId: initialEntry?.sessionId,
          storePath: params.defaults.storePath,
          kind,
          resetTriggered: params.resetTriggered === true,
          routeThreadId: params.routeThreadId ?? params.queued.originatingThreadId,
          originatingLeafEntryId: params.queued.turnAdoptionLifecycle?.originatingLeafEntryId,
          upstreamAbortSignal:
            sourceSignal && mailboxClaim
              ? AbortSignal.any([sourceSignal, mailboxClaim.abortController.signal])
              : (sourceSignal ?? mailboxClaim?.abortController.signal),
        });
    if (admission.status === "skipped") {
      if (!existingClaim && mailboxClaim) {
        releaseSessionControllerClaim(mailboxClaim);
      }
      return {
        kind: "skipped",
        reason:
          kind === "queued_followup" && admission.reason === "active-run"
            ? "lifecycle-invalidated"
            : admission.reason,
      } as const;
    }

    const operation = admission.operation;
    if (params.providedReplyOperation) {
      attachSessionControllerInputOperation(params.queued, operation);
    } else {
      bindSessionControllerInputOperation(params.queued, operation);
    }
    try {
      if (isFollowupRunAborted(params.queued)) {
        return { kind: "skipped", reason: "aborted", operation } as const;
      }
      if (kind === "queued_followup") {
        await params.defaults.opts?.onQueuedFollowupAdmitted?.();
      }
      assertOperatorCurrent();

      let activeEntry = [admission.sessionEntry, initialEntry].find(
        (entry) => entry?.sessionId === operation.sessionId,
      );
      let run = { ...params.queued.run, config };
      if (operation.sessionId !== run.sessionId) {
        run.sessionId = operation.sessionId;
        run.sessionFile = resolveAdmittedRunSessionFile({ sessionKey }) ?? run.sessionFile;
        run.cliSessionBindingFacts = undefined;
        run.autoFallbackPrimaryProbe = undefined;
        run.modelSelectionLocked = activeEntry?.modelSelectionLocked === true;
      }
      const entryHandle = createReplySessionEntryHandle({
        sessionEntry: activeEntry,
        sessionKey,
        sessionStore: params.defaults.sessionStore,
      });
      const session: ReplyTurnSessionOwner = {
        ...(sessionKey
          ? { kind: "session" as const, key: sessionKey, storePath: params.defaults.storePath }
          : { kind: "detached" as const }),
        current: entryHandle.getCurrent,
        publish: (entry) => entry && entryHandle.replaceCurrent(entry),
      };
      const sessionStore = sessionKey
        ? entryHandle.toCompatSessionStore()
        : params.defaults.sessionStore;
      const runId = params.queued.controllerInput?.protocolRunId ?? crypto.randomUUID();
      const turn: AdmittedFollowupTurn = {
        runId,
        queued: { ...params.queued, run },
        operation,
        config,
        session,
        sessionStore,
        sendPolicy: "allow",
        preflightCompactionApplied: false,
      };
      try {
        await params.signalRunStart?.();
        const preflightCompactionCount = activeEntry?.compactionCount ?? 0;
        activeEntry = await prepareReplyTurnContext({
          cfg: config,
          followupRun: { ...params.queued, run },
          promptForEstimate: params.queued.prompt,
          defaultModel: params.defaults.defaultModel,
          resolvedVerboseLevel:
            normalizeVerboseLevel(
              run.verboseLevelOverride ?? activeEntry?.verboseLevel ?? run.verboseLevel,
            ) ?? "off",
          opts: { ...params.defaults.opts, runId },
          sessionEntry: activeEntry,
          sessionStore,
          sessionKey,
          runtimePolicySessionKey: run.runtimePolicySessionKey,
          storePath: params.defaults.storePath,
          isHeartbeat: params.defaults.opts?.isHeartbeat === true,
          replyOperation: operation,
          publishCheckpoint: session.publish,
          onCompactionNotice:
            params.queued.currentInboundEventKind !== "room_event" &&
            shouldNotifyUserAboutCompaction(config)
              ? async (phase, text) => params.onCompactionNotice?.(phase, text, turn)
              : undefined,
          trace: params.trace,
        });
        turn.preflightCompactionApplied =
          (activeEntry?.compactionCount ?? 0) > preflightCompactionCount;
        if (activeEntry) {
          session.publish(activeEntry);
          if (activeEntry.sessionId !== operation.sessionId) {
            operation.updateSessionId(activeEntry.sessionId);
            run.sessionId = activeEntry.sessionId;
            run.sessionFile = resolveAdmittedRunSessionFile({ sessionKey }) ?? run.sessionFile;
            run.cliSessionBindingFacts = undefined;
            run.autoFallbackPrimaryProbe = undefined;
            run.modelSelectionLocked = activeEntry.modelSelectionLocked === true;
          }
        }
      } catch (error) {
        turn.preflightError = error;
      }
      if (params.defaults.opts?.isHeartbeat !== true) {
        turn.queued.currentInboundContext = refreshActiveGoalContext(
          params.queued.currentInboundContext,
          session.current(),
        );
      }
      return { kind: "admitted", configured, turn } as const;
    } catch (error) {
      operation.complete();
      throw error;
    }
  } catch (error) {
    if (!existingClaim && mailboxClaim) {
      releaseSessionControllerClaim(mailboxClaim);
    }
    throw error;
  }
}
