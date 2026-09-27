import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Result } from "@openclaw/normalization-core/result";
import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.types.js";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
  resolveSessionTranscriptRuntimeTarget,
  type TranscriptEntryAnchor,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputWorkerAuthority,
  joinSessionPendingInputReceipt,
} from "../config/sessions/session-accessor.pending-input-receipt.js";
import { completeSessionPendingInputReceipt } from "../config/sessions/session-accessor.pending-inputs.js";
import { assertGatewayFreshInputWorkerAuthority } from "../gateway/server-methods/session-mutation-guards.js";
import { createUserTurnAdmissionWrite } from "./user-turn-transcript-admission-write.js";
import {
  registerUserTurnTranscriptAdmissionOwner,
  getUserTurnTranscriptAdmissionOwner,
  resolveUserTurnTranscriptAdmission,
} from "./user-turn-transcript-admission.js";
import { confirmPersistedSteerTargetRunId } from "./user-turn-transcript-annotation.js";
import {
  buildLateResolvedMediaMessage,
  resolvePersistedUserTurnMessage,
} from "./user-turn-transcript.message.js";
import {
  buildRunUserTurnIdempotencyKey,
  normalizePersistedSteerTargetRunId,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
  rewritePersistedSteerTargetRunId,
} from "./user-turn-transcript.metadata.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.persistence.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnOriginalInputCommit,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
  UserTurnTranscriptTargetResolver,
  UserTurnTranscriptUpdateMode,
} from "./user-turn-transcript.types.js";

const originalInputCommitNotifiers = new WeakMap<
  UserTurnTranscriptRecorder,
  (anchor: TranscriptEntryAnchor) => void
>();

export {
  bindUserTurnPendingInputWorkerAuthority,
  completeUserTurnTranscriptProcessing,
  joinUserTurnPendingInput,
  finishUserTurnPendingInput,
} from "./user-turn-transcript-admission.js";

export type {
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

export {
  buildLateMediaAttachedProjection,
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
  mergePreparedUserTurnMessageForRuntime,
  resolvePersistedUserTurnText,
} from "./user-turn-transcript.message.js";

export {
  buildRunUserTurnIdempotencyKey,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
};

async function resolveUserTurnTranscriptTarget(
  target: UserTurnTranscriptTargetResolver,
): Promise<UserTurnTranscriptTarget | undefined> {
  return typeof target === "function" ? await target() : target;
}

export function createUserTurnTranscriptRecorder(
  params: CreateUserTurnTranscriptRecorderParams,
): UserTurnTranscriptRecorder {
  const logicalTurnId = randomUUID();
  let message = resolvePersistedUserTurnMessage(params);
  let blocked = false;
  let persisted = false;
  let runtimePersisted = false;
  let persistedResult: UserTurnTranscriptPersistResult | undefined;
  let admissionReceipt: UserTurnTranscriptAdmissionReceipt | undefined;
  let admittedMessage: PersistedUserTurnMessage | undefined;
  let runtimePersistencePromise: Promise<void> | undefined;
  let selfPersistencePromise: Promise<UserTurnTranscriptPersistResult | undefined> | undefined;
  let resolvedMessagePromise: Promise<PersistedUserTurnMessage | undefined> | undefined;
  let persistedMessageNotified = false;
  let originalInputCommitted = false;
  let resolvedSourceMessage: PersistedUserTurnMessage | undefined;
  let runtimePersistedMessage: PersistedUserTurnMessage | undefined;
  let sentToProvider = false;
  const admissionWrite = createUserTurnAdmissionWrite();
  let resolvedBeforeProvider = false;
  let replacementText: string | undefined;
  let confirmedSteerTargetRunId: string | undefined;
  let pendingInput: Awaited<ReturnType<typeof stageSessionPendingInput>>;
  let processingCompletion: Result<AgentRunTerminalOutcome, unknown> | undefined;
  let processingCompletionPromise: Promise<AgentRunTerminalOutcome> | undefined;
  let staging: Promise<boolean> | undefined;
  const completeProcessing = (outcome: AgentRunTerminalOutcome, joined: boolean) => {
    if (!pendingInput?.complete) {
      return undefined;
    }
    if (processingCompletionPromise && !processingCompletion) {
      if (!joined) {
        throw new Error("Worker-owned input completion requires its joined operation");
      }
      return processingCompletionPromise;
    }
    if (!processingCompletion) {
      try {
        const result = joined
          ? completeSessionPendingInputReceipt(pendingInput, outcome)
          : pendingInput.complete(outcome);
        if (result instanceof Promise) {
          processingCompletionPromise = result.then(
            (value) => {
              processingCompletion = { ok: true, value };
              return value;
            },
            (error: unknown) => {
              processingCompletion = { ok: false, error };
              throw error;
            },
          );
          void processingCompletionPromise.catch(() => {});
          return processingCompletionPromise;
        }
        if (result === undefined) {
          return undefined;
        }
        processingCompletion = { ok: true, value: result };
      } catch (error) {
        processingCompletion = { ok: false, error };
      }
    }
    if (!processingCompletion.ok) {
      throw processingCompletion.error;
    }
    return processingCompletion.value;
  };

  const applyReplacementText = (
    candidate: PersistedUserTurnMessage | undefined,
  ): PersistedUserTurnMessage | undefined => {
    if (!candidate || replacementText === undefined) {
      return candidate;
    }
    const metadata = { ...candidate["__openclaw"] };
    if (candidate.content !== replacementText) {
      delete metadata.humanMentions;
      delete metadata.workContext;
    }
    const next = { ...candidate, content: replacementText };
    delete next["__openclaw"];
    return Object.keys(metadata).length > 0 ? { ...next, __openclaw: metadata } : next;
  };

  const applyMessageOverrides = (candidate: PersistedUserTurnMessage | undefined) => {
    const next = rewritePersistedSteerTargetRunId(
      applyReplacementText(candidate),
      confirmedSteerTargetRunId,
    );
    // Native mirrors must reuse this admission even when no transport supplied a key.
    return next && !next.idempotencyKey
      ? { ...next, idempotencyKey: buildRunUserTurnIdempotencyKey(logicalTurnId) }
      : next;
  };

  const handlePersistenceError = (error: unknown) => {
    if (params.onPersistenceError) {
      try {
        params.onPersistenceError(error);
      } catch {
        // Diagnostics cannot change an already committed transcript outcome.
      }
      return;
    }
    void import("../globals.js")
      .then(({ logVerbose }) => {
        logVerbose(
          `failed to persist ${params.errorContext ?? "user turn transcript"}: ${String(error)}`,
        );
      })
      .catch(() => undefined);
  };

  const resolveMessageForPersistence = async (): Promise<PersistedUserTurnMessage | undefined> => {
    if (!params.message && params.resolveInput && !resolvedMessagePromise) {
      resolvedMessagePromise = (async () => {
        try {
          const resolvedInput = await params.resolveInput?.();
          const resolvedMessage =
            resolvePersistedUserTurnMessage({
              message: params.message,
              input: resolvedInput ?? params.input,
            }) ?? message;
          resolvedBeforeProvider = !sentToProvider;
          return applyMessageOverrides(resolvedMessage);
        } catch (error) {
          handlePersistenceError(error);
          return applyMessageOverrides(message);
        }
      })();
    }
    const resolved = await (params.message || !params.resolveInput
      ? applyMessageOverrides(message)
      : resolvedMessagePromise);
    resolvedSourceMessage =
      params.pendingInputSources && resolved ? structuredClone(resolved) : resolved;
    if (!pendingInput && resolved && params.pendingInputSources) {
      const sources = params.pendingInputSources.flatMap(
        (source) => getUserTurnTranscriptAdmissionOwner(source)?.pending.read() ?? [],
      );
      if (sources.length > 0 && sources.length !== params.pendingInputSources.length) {
        throw new Error("Collected input cannot mix staged and unstaged source approval");
      }
      pendingInput = bindSessionPendingInputSources(sources, resolved);
      if (pendingInput) {
        message = pendingInput.message;
        resolvedMessagePromise = Promise.resolve(message);
      }
    }
    return pendingInput?.message ?? resolved;
  };

  const notifyMessagePersisted = (persistedMessage?: PersistedUserTurnMessage) => {
    const notificationMessage = persistedMessage ?? persistedResult?.message ?? message;
    if (!notificationMessage || persistedMessageNotified || !params.onMessagePersisted) {
      return;
    }
    persistedMessageNotified = true;
    try {
      void Promise.resolve(params.onMessagePersisted(notificationMessage)).catch(
        handlePersistenceError,
      );
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const notifyOriginalInputCommitted = (commit: UserTurnOriginalInputCommit) => {
    const sourceMessage = commit.message;
    const metadata = sourceMessage["__openclaw"];
    if (
      originalInputCommitted ||
      blocked ||
      sourceMessage.display === false ||
      sourceMessage.excludeFromContext === true ||
      (sourceMessage.provenance && sourceMessage.provenance.kind !== "external_user") ||
      metadata?.lateMedia === true ||
      metadata?.beforeAgentRunBlocked !== undefined
    ) {
      return;
    }
    originalInputCommitted = true;
    // Collection commits one framed message, but each source owns its sender and
    // selections. A rewritten aggregate no longer attests those original bytes.
    if (
      params.pendingInputSources &&
      metadata?.humanMentions?.length &&
      isDeepStrictEqual(
        sourceMessage.content,
        (pendingInput?.message ?? resolvedSourceMessage ?? message)?.content,
      )
    ) {
      for (const source of params.pendingInputSources) {
        originalInputCommitNotifiers.get(source)?.(commit.anchor);
      }
    }
    try {
      void Promise.resolve(params.onOriginalInputCommitted?.(commit)).catch(handlePersistenceError);
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const recordAdmission = (
    receipt: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt,
    persistedMessage: PersistedUserTurnMessage,
    detached = false,
  ): Promise<void> => {
    if (admissionReceipt) {
      return admissionWrite.pending ?? Promise.resolve();
    }
    admissionReceipt = resolveUserTurnTranscriptAdmission({ logicalTurnId, receipt });
    admittedMessage = persistedMessage;
    return admissionWrite.start(admissionReceipt, detached);
  };

  const refreshAdmission = (
    admission: UserTurnTranscriptAdmissionReceipt,
    persistedMessage: PersistedUserTurnMessage,
  ) => {
    admissionReceipt = admission;
    admittedMessage = persistedMessage;
    runtimePersistedMessage = persistedMessage;
    if (persistedResult) {
      persistedResult = { ...persistedResult, admission, message: persistedMessage };
    }
  };

  const waitForRuntimePersistence = async () => {
    if (runtimePersistencePromise) {
      try {
        await runtimePersistencePromise;
      } catch (error) {
        handlePersistenceError(error);
      }
    }
    // A failed durable admission reaches the turn owner before provider dispatch.
    await admissionWrite.pending;
  };

  const persistPrepared = async (options: {
    waitForRuntime: boolean;
    skipWhenBlocked: boolean;
    message?: PersistedUserTurnMessage;
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
    cwd?: string;
    expectedSessionId?: string;
    expectedSessionState?: SessionTranscriptTurnPersistOptions["expectedSessionState"];
    sessionLifecyclePatch?: SessionTranscriptTurnPersistOptions["sessionLifecyclePatch"];
    retryIfUnpersisted?: boolean;
  }): Promise<UserTurnTranscriptPersistResult | undefined> => {
    if (options.skipWhenBlocked && blocked) {
      return undefined;
    }
    if (!options.message && !message && !params.resolveInput) {
      return undefined;
    }
    if (options.waitForRuntime) {
      await waitForRuntimePersistence();
    }
    if (selfPersistencePromise) {
      const existingPromise = selfPersistencePromise;
      const existingResult = await existingPromise;
      if (existingResult || !options.retryIfUnpersisted) {
        return persistedResult ?? existingResult;
      }
      // A guarded store write can lose a session-generation race without appending.
      // Explicit retry callers may re-resolve the target, but concurrent ownership stays shared.
      if (selfPersistencePromise !== existingPromise) {
        return await selfPersistencePromise;
      }
      selfPersistencePromise = undefined;
    }
    const persistencePromise = (async () => {
      const resolvedMessage = options.message ?? (await resolveMessageForPersistence());
      if (!resolvedMessage) {
        return undefined;
      }
      const target = await resolveUserTurnTranscriptTarget(options.target ?? params.target);
      if (!target) {
        return undefined;
      }
      const resolvedTarget = options.cwd ? { ...target, cwd: options.cwd } : target;
      const updateMode = options.updateMode ?? params.updateMode ?? "inline";
      const persistMessage = async (
        candidate: PersistedUserTurnMessage,
        candidateUpdateMode: UserTurnTranscriptUpdateMode,
      ) => {
        const persist = () => {
          const persistenceParams = {
            ...resolvedTarget,
            logicalTurnId,
            message: candidate,
            sessionTurnMutation: params.sessionTurnMutation,
            expectedSessionId: options.expectedSessionId || resolvedTarget.expectedSessionId,
            sessionLifecyclePatch: options.sessionLifecyclePatch ?? params.sessionLifecyclePatch,
            expectedSessionState: options.expectedSessionState ?? params.expectedSessionState,
            updateMode: candidateUpdateMode,
            beforeMessageWrite: params.beforeMessageWrite ?? resolvedTarget.beforeMessageWrite,
            onOriginalInputCommitted: notifyOriginalInputCommitted,
          };
          // The SDK target keeps config opaque; persistence retains its existing unchecked pass-through.
          return persistUserTurnTranscript({
            ...persistenceParams,
            config: persistenceParams.config as SessionTranscriptTurnPersistOptions["config"],
          });
        };
        // Collection can resolve its media lazily during admission. Bind custody
        // here too so the canonical append always consumes the exact sources.
        return await (pendingInput
          ? withSessionPendingInputPersistence(pendingInput, persist)
          : persist());
      };
      const lateMediaMessage =
        sentToProvider && !resolvedBeforeProvider
          ? buildLateResolvedMediaMessage({
              admittedMessage: runtimePersistedMessage ?? message,
              resolvedMessage,
            })
          : undefined;
      if (lateMediaMessage) {
        // The admitted bytes already crossed the LLM boundary. Persisting media as a
        // second turn preserves that prefix; inline replacement would thrash cache tail (#99495).
        if (!runtimePersisted && !persisted && message) {
          const admittedResult = await persistMessage(message, updateMode);
          if (admittedResult) {
            persisted = true;
            persistedResult = admittedResult;
            await recordAdmission(admittedResult.admission, admittedResult.message);
            notifyMessagePersisted(admittedResult.message);
          }
        }
        const appendedMedia = await persistMessage(lateMediaMessage, "none");
        if (appendedMedia) {
          persisted = true;
          persistedResult = appendedMedia;
        }
        return appendedMedia;
      }
      if (runtimePersisted) {
        return undefined;
      }
      if (persisted) {
        return persistedResult;
      }
      const result = await persistMessage(resolvedMessage, updateMode);
      if (result) {
        persisted = true;
        persistedResult = result;
        await recordAdmission(result.admission, result.message);
        notifyMessagePersisted(result.message);
      }
      return result;
    })();
    selfPersistencePromise = persistencePromise;
    try {
      const result = await persistencePromise;
      if (!result && options.retryIfUnpersisted && selfPersistencePromise === persistencePromise) {
        selfPersistencePromise = undefined;
      }
      return result;
    } catch (error) {
      // Approved custody retries only its idempotent write under the same live
      // owner. A cached rejection must not poison a later definitive fallback.
      if (pendingInput && selfPersistencePromise === persistencePromise) {
        selfPersistencePromise = undefined;
      }
      handlePersistenceError(error);
      throw error;
    }
  };
  const recorder: UserTurnTranscriptRecorder = {
    get message() {
      return message;
    },
    resolveMessage: resolveMessageForPersistence,
    assertOriginalInputCommit: params.assertOriginalInputCommit
      ? () => {
          if (!blocked && !persisted && !runtimePersisted && !pendingInput) {
            params.assertOriginalInputCommit!();
          }
        }
      : undefined,
    stageApproved: (options) => {
      staging ??= (async () => {
        const candidate = await resolveMessageForPersistence();
        const target = await resolveUserTurnTranscriptTarget(params.target);
        if (!candidate || !target || persisted || runtimePersisted) {
          return false;
        }
        const config = target.config as SessionTranscriptTurnPersistOptions["config"];
        const runtimeTarget = await resolveSessionTranscriptRuntimeTarget(target, config);
        pendingInput = await stageSessionPendingInput(
          { ...target, ...runtimeTarget },
          {
            ...options,
            requestFingerprint: params.pendingInputRequestFingerprint,
            trackCompletion: params.trackInputCompletion,
            replaySourceSessionKeys: params.pendingInputReplaySourceSessionKeys,
            message: candidate,
            config,
            prepareMessageAfterIdempotencyCheck: (next) =>
              preparePersistedUserTurnMessageForTranscriptWrite(next, {
                ...target,
                beforeMessageWrite: params.beforeMessageWrite ?? target.beforeMessageWrite,
              }),
          },
        );
        if (!pendingInput) {
          return false;
        }
        message = pendingInput.message;
        resolvedMessagePromise = Promise.resolve(message);
        return pendingInput.state !== "consumed";
      })();
      return staging;
    },
    getPendingInputMessage: () => pendingInput?.message,
    getProcessingCompletion: () =>
      processingCompletion?.ok ? processingCompletion.value : pendingInput?.completion,
    completeProcessing: (outcome) => {
      // Abort records its terminal outcome before releasing the controller.
      // Final publication reuses that committed result (or the original write
      // failure), without trying another write under revoked ownership.
      const result = completeProcessing(outcome, false);
      if (result instanceof Promise) {
        throw new Error("Worker-owned input completion requires its joined operation");
      }
      return result;
    },
    isPendingInputConsumed: () => pendingInput?.state === "consumed",
    withPendingInput: (run) => (pendingInput ? pendingInput.run(run) : run()),
    finishPendingInput: (disposition) => {
      if (pendingInput) {
        pendingInput.finish(disposition);
      } else {
        const failures: unknown[] = [];
        for (const source of params.pendingInputSources ?? []) {
          try {
            source.finishPendingInput?.(disposition);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Failed to finish collected input sources");
        }
      }
    },
    replaceTextBeforePersistence: (text) => {
      if (pendingInput || persisted || runtimePersisted || sentToProvider) {
        return;
      }
      replacementText = text;
      message = applyMessageOverrides(message);
      resolvedMessagePromise = undefined;
    },
    confirmSteerTargetRunIdForPersistence: async (targetRunId) => {
      const normalizedTargetRunId = normalizePersistedSteerTargetRunId(targetRunId);
      if (!normalizedTargetRunId || confirmedSteerTargetRunId === normalizedTargetRunId) {
        return;
      }
      confirmedSteerTargetRunId = normalizedTargetRunId;
      message = applyMessageOverrides(message);
      resolvedMessagePromise = undefined;

      const pendingSelfPersistence = selfPersistencePromise;
      await waitForRuntimePersistence();
      await pendingSelfPersistence?.catch(() => undefined);
      if (!admissionReceipt) {
        return;
      }
      try {
        const confirmed = await confirmPersistedSteerTargetRunId({
          admission: admissionReceipt,
          targetRunId: normalizedTargetRunId,
        });
        if (!confirmed) {
          return;
        }
        refreshAdmission(confirmed.admission, confirmed.message);
      } catch (error) {
        handlePersistenceError(error);
      }
    },
    getPersistedMessage: () =>
      admittedMessage ?? runtimePersistedMessage ?? persistedResult?.message,
    getAdmissionReceipt: () => admissionReceipt,
    setAdmissionHandler: (handler) => admissionWrite.setHandler(handler),
    markSentToProvider: () => {
      sentToProvider = true;
    },
    markRuntimePersistencePending: (pending) => {
      runtimePersistencePromise = pending;
    },
    markRuntimePersisted: (persistedMessage, receipt, persistence) => {
      runtimePersistedMessage = persistedMessage;
      runtimePersisted = true;
      if (persistedMessage && receipt) {
        if (persistence?.appended === true) {
          notifyOriginalInputCommitted({ message: persistedMessage, anchor: receipt });
        }
        void recordAdmission(receipt, persistedMessage, true); // settled by waitForRuntimePersistence
      }
      if (persistedMessage && persistedResult) {
        persistedResult = {
          ...persistedResult,
          message: persistedMessage,
        };
      }
      notifyMessagePersisted(persistedMessage);
    },
    markBlocked: () => {
      blocked = true;
    },
    hasPersisted: () => persisted || runtimePersisted,
    isBlocked: () => blocked,
    // An admission write from runtime persistence must also settle before provider dispatch.
    hasRuntimePersistencePending: () =>
      runtimePersistencePromise !== undefined || admissionWrite.pending !== undefined,
    waitForRuntimePersistence,
    persistApproved: async (options) =>
      await persistPrepared({
        waitForRuntime: false,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
        expectedSessionId: options?.expectedSessionId,
        expectedSessionState: options?.expectedSessionState,
        sessionLifecyclePatch: options?.sessionLifecyclePatch,
        retryIfUnpersisted: options?.retryIfUnpersisted,
      }),
    persistBlocked: async (blockedMessage, options) => {
      blocked = true;
      return await persistPrepared({
        waitForRuntime: false,
        skipWhenBlocked: false,
        message: blockedMessage,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
      });
    },
    persistFallback: async (options) =>
      await persistPrepared({
        waitForRuntime: true,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
        cwd: options?.cwd,
      }),
  };
  originalInputCommitNotifiers.set(recorder, (anchor) => {
    const sourceMessage = pendingInput?.message ?? resolvedSourceMessage ?? message;
    if (sourceMessage) {
      notifyOriginalInputCommitted({ message: sourceMessage, anchor });
    }
  });
  const freshInputWorkerAuthority = params.freshInputWorkerAuthority;
  registerUserTurnTranscriptAdmissionOwner(recorder, {
    freshInput: freshInputWorkerAuthority
      ? {
          assertCurrent: () => assertGatewayFreshInputWorkerAuthority(freshInputWorkerAuthority),
          isExempt: () => blocked || persisted || runtimePersisted || pendingInput !== undefined,
        }
      : undefined,
    pending: {
      read: () => pendingInput,
      bind: bindSessionPendingInputWorkerAuthority,
      join: joinSessionPendingInputReceipt,
      complete: (outcome) => completeProcessing(outcome, true),
      sources: () => params.pendingInputSources,
    },
    receipt: () => admissionReceipt,
    message: () => admittedMessage,
    blocked: () => blocked || confirmedSteerTargetRunId !== undefined,
    sentToProvider: () => sentToProvider,
    refresh: refreshAdmission,
  });
  return recorder;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.userTurnTranscriptTestApi")] = {
    persistUserTurnTranscript,
  };
}
