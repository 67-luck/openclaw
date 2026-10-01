// Session active-run cancellation and agent-scope resolution.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-manager-api.js";
import {
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunOwnerByRunId,
  type ActiveEmbeddedRunOwner,
} from "../../agents/embedded-agent-runner/runs.js";
import { captureYieldedMainSessionContinuation } from "../../agents/main-session-recovery/main-session-restart-recovery-target.js";
import {
  isConfiguredSessionStoreAgentId,
  resolveExistingAgentSessionStoreTargetsSync,
} from "../../config/sessions.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceSignal,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { findSessionControllerEntries } from "../../sessions/session-controller.state.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { waitForChatAbortTerminalPersistence } from "../chat-abort-lifecycle-internal.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "../session-store-key.js";
import { loadSessionEntry } from "../session-utils.js";
import { resolveWorkerInferenceTarget } from "../worker-environments/inference-control-internal.js";
import { resolveChatAbortRequester } from "./chat-abort-authorization.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import {
  abortControlledSubagents,
  abortQueuedCollectorSession,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import { abortedPartialPersistenceError } from "./chat-aborted-partial.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import {
  captureAbortChannelSources,
  resolveAbortSessionKey,
  resolveScopedAbortKey,
  resolveSessionKeyAgentId,
  sessionKeyBelongsToAgent,
} from "./sessions-abort-target.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export { resolveAbortSessionKey } from "./sessions-abort-target.js";

export const sessionAbortHandlers: GatewayRequestHandlers = {
  "sessions.abort": async (options) => {
    const { params, respond, context, client, sessionMutationAuthorization } = options;
    const authority = readGatewayRequestMutationAuthority(options);
    const requester = resolveChatAbortRequester(client, sessionMutationAuthorization);
    const narrow =
      authority.sessionScope === "operator.sessions.write" ||
      requester.sessionAuthority !== undefined;
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const requestedRunId = typeof p.runId === "string" ? p.runId : undefined;
    const requestedKey = normalizeOptionalString(p.key);
    const requestedParamAgentId = normalizeOptionalString(p.agentId);
    const workerRunTarget = requestedRunId
      ? resolveWorkerInferenceTarget(context.workerEnvironmentService, requestedRunId)
      : undefined;
    const embeddedCandidate = requestedRunId
      ? resolveActiveEmbeddedRunOwnerByRunId(requestedRunId)
      : undefined;
    const embeddedRun = embeddedCandidate?.runId === requestedRunId ? embeddedCandidate : undefined;
    const embeddedRunSessionKey = embeddedRun?.sessionKey;
    const scopedRequestedKey = resolveScopedAbortKey({
      cfg,
      key: requestedKey,
      agentId: requestedParamAgentId,
    });
    if (requestedKey && requestedParamAgentId && !scopedRequestedKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      );
      return;
    }
    const requestedKeyAgentId = scopedRequestedKey
      ? resolveSessionKeyAgentId(scopedRequestedKey, cfg)
      : undefined;
    const activeRun = requestedRunId ? context.rpcSources.get(requestedRunId) : undefined;
    const activeRunSessionKey = activeRun?.adapter.sessionKey;
    const activeRunAgentId = normalizeOptionalString(activeRun?.adapter.agentId);
    let inferredRunAgentId =
      requestedParamAgentId ??
      activeRunAgentId ??
      requestedKeyAgentId ??
      workerRunTarget?.agentId ??
      resolveSessionKeyAgentId(activeRunSessionKey, cfg) ??
      resolveSessionKeyAgentId(embeddedRunSessionKey, cfg);
    if (requestedRunId && !inferredRunAgentId) {
      const runOwner = resolveRequestedGlobalAgentId(
        cfg,
        scopedRequestedKey ?? activeRunSessionKey ?? workerRunTarget?.sessionKey ?? "main",
      );
      if (!runOwner.ok) {
        respond(false, undefined, runOwner.error);
        return;
      }
      inferredRunAgentId = runOwner.agentId;
    }
    const requestedRunAgentId = requestedRunId
      ? inferredRunAgentId
        ? normalizeAgentId(inferredRunAgentId)
        : undefined
      : undefined;
    const scopedActiveRunSessionKey = activeRunSessionKey
      ? requestedRunAgentId
        ? sessionKeyBelongsToAgent(activeRunSessionKey, requestedRunAgentId, cfg)
          ? activeRunSessionKey
          : undefined
        : activeRunSessionKey
      : undefined;
    const keyCandidate =
      scopedRequestedKey ??
      scopedActiveRunSessionKey ??
      (requestedRunId
        ? resolveSessionKeyForRun(requestedRunId, {
            agentId: requestedRunAgentId,
            projection: getSessionRowProjection(context),
          })
        : undefined) ??
      workerRunTarget?.sessionKey ??
      embeddedRunSessionKey;
    if (!keyCandidate && requestedRunId) {
      respond(true, { ok: true, abortedRunId: null, status: "no-active-run" });
      return;
    }
    const key = requireSessionKey(keyCandidate, respond);
    if (!key) {
      return;
    }
    const requestedGlobalAgent = resolveRequestedGlobalAgentId(
      cfg,
      key,
      // An inferred canonical-key owner is not an explicit configured-agent request.
      // The exact live/persisted target check below also admits retired owners.
      requestedParamAgentId ?? (parseAgentSessionKey(key) ? undefined : requestedRunAgentId),
    );
    if (!requestedGlobalAgent.ok) {
      respond(false, undefined, requestedGlobalAgent.error);
      return;
    }
    const requestedGlobalAgentId = requestedGlobalAgent.agentId;
    const targetAgentId =
      requestedGlobalAgentId ??
      resolveSessionStoreAgentId(cfg, resolveSessionStoreKey({ cfg, sessionKey: key }));
    const configuredTarget = isConfiguredSessionStoreAgentId(cfg, targetAgentId);
    const existingTargets = configuredTarget
      ? []
      : resolveExistingAgentSessionStoreTargetsSync(cfg, targetAgentId);
    const stableTargetOwner = tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
    const hasExactActiveRun = requestedRunId
      ? (scopedActiveRunSessionKey === key &&
          resolveChatRunOwnerAgentId({
            agentId: activeRunAgentId,
            sessionKey: activeRunSessionKey,
            defaultAgentId: stableTargetOwner,
          }) === normalizeAgentId(targetAgentId)) ||
        (embeddedRun !== undefined &&
          resolveSessionKeyAgentId(embeddedRunSessionKey, cfg) === normalizeAgentId(targetAgentId))
      : [...context.rpcSources.values()].some(
          (entry) =>
            entry.adapter.controlUiVisible !== false &&
            entry.adapter.sessionKey === key &&
            resolveChatRunOwnerAgentId({
              agentId: entry.adapter.agentId,
              sessionKey: entry.adapter.sessionKey,
              defaultAgentId: stableTargetOwner,
            }) === normalizeAgentId(targetAgentId),
        );
    if (!configuredTarget && existingTargets.length === 0 && !hasExactActiveRun) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${targetAgentId}" not found`),
      );
      return;
    }
    // An exact live controller is already authoritative. Avoid opening the fallback store when
    // neither config nor persistence owns it; that edge is the only one that could create state.
    const loadedSession =
      configuredTarget || existingTargets.length > 0
        ? loadSessionEntry(key, { agentId: requestedGlobalAgentId })
        : undefined;
    const canonicalKey =
      loadedSession?.canonicalKey ??
      resolveSessionStoreKey({
        cfg,
        sessionKey: key,
        ...(requestedGlobalAgentId ? { storeAgentId: requestedGlobalAgentId } : {}),
      });
    const sessionEntry = loadedSession?.entry;
    const admittedTarget = sessionMutationAuthorization?.admittedTarget;
    if (
      narrow &&
      (!admittedTarget?.sessionId.trim() ||
        admittedTarget.sessionKey !== canonicalKey ||
        admittedTarget.agentId !== normalizeAgentId(targetAgentId) ||
        sessionEntry?.sessionId !== admittedTarget.sessionId)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session target is unavailable"),
      );
      return;
    }
    const requiredSessionId = narrow ? admittedTarget?.sessionId : undefined;
    const embeddedRunMatchesSession = Boolean(
      embeddedRun &&
      resolveSessionKeyAgentId(embeddedRun.sessionKey, cfg) === normalizeAgentId(targetAgentId) &&
      (narrow
        ? embeddedRun.sessionId === requiredSessionId &&
          (embeddedRun.sessionKey === key || embeddedRun.sessionKey === canonicalKey)
        : embeddedRun.sessionKey === key ||
          embeddedRun.sessionKey === canonicalKey ||
          sessionEntry?.sessionId === embeddedRun.sessionId),
    );
    if (embeddedRun && !embeddedRunMatchesSession) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match session"),
      );
      return;
    }
    const requestedKeyAliases =
      requestedKey &&
      requestedKey !== key &&
      (!requestedParamAgentId || sessionKeyBelongsToAgent(requestedKey, requestedParamAgentId, cfg))
        ? [requestedKey]
        : undefined;
    const resolvedAbortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      activeRunSessionKey: narrow ? undefined : scopedActiveRunSessionKey,
      aliasKeys: requestedKeyAliases,
      agentId: requestedGlobalAgentId,
      defaultAgentId: stableTargetOwner,
    });
    const abortSessionKey =
      canonicalKey === "global" && requestedGlobalAgentId ? "global" : resolvedAbortSessionKey;
    const abortAgentId = requestedGlobalAgentId ?? activeRunAgentId;
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const lifecycleRevision = sessionEntry?.lifecycleRevision;
    const assertAbortCurrent = () => {
      authority.assertCurrent();
      sessionMutationAuthorization?.assertCurrent();
      requester.sessionAuthority?.assertCurrent();
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    };
    const physicalTarget = loadedSession
      ? captureSessionTarget({
          storeScope: loadedSession.storePath,
          sessionKey: canonicalKey,
          aliases: [key, ...(requestedKeyAliases ?? [])],
          agentId: targetAgentId,
          incarnation: sessionEntry?.sessionId,
        })
      : undefined;
    const controllerOwners = physicalTarget
      ? findSessionControllerEntries(canonicalKey, physicalTarget)
      : [];
    const persistSessionAbort = (
      owner: Pick<ActiveEmbeddedRunOwner, "runId" | "sessionId" | "startedAtMs">,
    ) =>
      persistGatewaySessionLifecycleEvent({
        sessionKey: canonicalKey,
        agentId: targetAgentId,
        // Exact cancellation already committed; requester revocation cannot abandon its terminal write.
        assertCommitAllowed: () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
        expectedWriter: {
          runId: owner.runId,
          sessionId: owner.sessionId,
          lifecycleRevision,
        },
        event: {
          runId: owner.runId,
          sessionId: owner.sessionId,
          lifecycleGeneration,
          ts: Date.now(),
          data: {
            phase: "end",
            status: "cancelled",
            aborted: true,
            stopReason: "rpc",
            startedAt: owner.startedAtMs ?? sessionEntry?.startedAt,
            endedAt: Date.now(),
          },
        },
      });
    // Controller-backed runs must keep the requester checks and lifecycle cleanup below.
    if (embeddedRun && !activeRun) {
      let aborted = false;
      let parentStatus: ReturnType<ActiveEmbeddedRunOwner["stop"]> = "unchanged";
      let descendants: Awaited<ReturnType<typeof abortControlledSubagents>> | undefined;
      const stopped = stopSession({
        source: "client-run",
        capture: captureSessionControllerStop({}),
        assertCurrent: assertAbortCurrent,
        reason: "rpc",
        hookContext: {
          sessionKey: canonicalKey,
          sessionEntry,
          sessionId: sessionEntry?.sessionId,
          commandSource: "gateway:sessions.abort",
          senderId: requester.deviceId ?? requester.connId,
        },
        externalParents: [
          {
            phase: "active",
            stop: () => {
              assertAbortCurrent();
              parentStatus = embeddedRun.stop();
              aborted = parentStatus === "aborted";
              return parentStatus;
            },
            settled: embeddedRun.waitForSettlement(),
          },
        ],
        stopChildren: async (applyParentStop) => {
          descendants = await abortControlledSubagents({
            cfg,
            sessionKey: embeddedRun.sessionKey ?? canonicalKey,
            agentId: targetAgentId,
            requesterTurnRunId: embeddedRun.runId,
            assertCurrent: assertAbortCurrent,
            beforeKill: applyParentStop,
          });
          return {
            stopped: descendants?.killed ?? 0,
            failed: descendants?.status === "error" ? descendants.failed : 0,
          };
        },
        continueChildStop: () => parentStatus !== "unchanged",
      });
      const outcome = await stopped.completed;
      aborted = outcome.aborted;
      if (aborted) {
        await Promise.all([persistSessionAbort(embeddedRun), embeddedRun.waitForSettlement()]);
      }
      const error = descendantAbortError(descendants, "Parent run");
      if (error) {
        respond(false, undefined, error);
      } else {
        respond(true, {
          ok: true,
          abortedRunId: aborted ? embeddedRun.runId : null,
          status: aborted ? "aborted" : "no-active-run",
        });
      }
      if (aborted) {
        emitSessionsChanged(context, {
          sessionKey: canonicalKey,
          ...(abortAgentId ? { agentId: abortAgentId } : {}),
          reason: "abort",
        });
      }
      return;
    }
    // Snapshot before abort can remove controllers. Agent run IDs are idempotency
    // keys, so preserve their dedupe namespace instead of colliding with chat.send.
    const preAbortRuns = new Map(context.rpcSources);
    const preAbortDedupe = new Map(context.dedupe);
    const representedInputs = new Set([...preAbortRuns.values()].map((entry) => entry.input));
    const representedOperations = new Set(
      [...preAbortRuns.values()].map((entry) => entry.input.claim?.operation),
    );
    const persistedSessionId = sessionEntry?.sessionId;
    const channelSources = captureAbortChannelSources({
      controllerOwners,
      representedInputs,
      requiredSessionId: narrow ? persistedSessionId : undefined,
    });
    const channelSettlements: Promise<void>[] = [];
    const channelStop = captureSessionControllerStop({
      inputs: !requestedRunId && canonicalKey !== "global" ? channelSources.keys() : [],
      operations:
        !requestedRunId && canonicalKey !== "global"
          ? controllerOwners
              .map((owner) => owner.active)
              .filter(
                (operation) =>
                  Boolean(operation) &&
                  !representedOperations.has(operation) &&
                  (requiredSessionId === undefined ||
                    operation?.hasOwnedSessionId(requiredSessionId)),
              )
          : [],
    });
    let channelStopCommitted = false;

    const preAbortSessions = new Map(
      [...preAbortRuns].map(([runId, entry]) => [runId, captureAgentJobSession(entry.adapter)]),
    );
    let abortedRunIds: string[] = [];
    let abortedRunId: string | null = null;
    let aborted = false;
    let chatAbortSucceeded = false;
    let failedResponse: Parameters<typeof respond> | undefined;
    let descendantsCancelled = false;
    let responseMeta: Record<string, unknown> | undefined;
    let abortWarning: string | undefined;
    const capturedSessionEmbeddedRun = persistedSessionId
      ? resolveActiveEmbeddedRunOwner(persistedSessionId)
      : undefined;
    const sessionEmbeddedRun =
      !narrow ||
      (capturedSessionEmbeddedRun &&
        capturedSessionEmbeddedRun.sessionId === requiredSessionId &&
        (capturedSessionEmbeddedRun.sessionKey === key ||
          capturedSessionEmbeddedRun.sessionKey === canonicalKey))
        ? capturedSessionEmbeddedRun
        : undefined;
    const embeddedController = sessionEmbeddedRun
      ? preAbortRuns.get(sessionEmbeddedRun.runId)
      : undefined;
    const yieldedRunId =
      typeof sessionEntry?.lifecycleRunId === "string" ? sessionEntry.lifecycleRunId : undefined;
    const yieldedParent =
      !requestedRunId &&
      !sessionEmbeddedRun &&
      yieldedRunId &&
      !preAbortRuns.has(yieldedRunId) &&
      loadedSession &&
      sessionEntry &&
      captureYieldedMainSessionContinuation({
        cfg,
        agentId: targetAgentId,
        sessionKey: canonicalKey,
        storePath: loadedSession.storePath,
        entry: sessionEntry,
      })
        ? {
            runId: yieldedRunId,
            sessionId: sessionEntry.sessionId,
            startedAtMs: sessionEntry.startedAt,
          }
        : undefined;
    let embeddedAbortPersistence: Promise<void> | undefined;
    let mcpRetirement: Promise<boolean> | undefined;
    let pendingMcpController: RpcSourceRef | undefined;
    const settleAbortPersistence = async (runIds: readonly string[]) => {
      try {
        await embeddedAbortPersistence;
        if (channelStopCommitted) {
          await Promise.all(channelSettlements);
        }
        await Promise.all(
          runIds.flatMap((runId) => {
            const entry = preAbortRuns.get(runId);
            return entry ? [waitForChatAbortTerminalPersistence(entry)] : [];
          }),
        );
        if (
          persistedSessionId &&
          pendingMcpController &&
          getRpcSourceSignal(pendingMcpController).aborted
        ) {
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          mcpRetirement ??= retireSessionMcpRuntime({
            sessionId: persistedSessionId,
            reason: "session-stop",
          });
        }
        await mcpRetirement;
        if (descendantsCancelled && yieldedParent) {
          // Child cancellation consumes the wake; join its parent's terminal write too.
          await persistSessionAbort(yieldedParent);
        }
      } catch (error) {
        throw abortedPartialPersistenceError(error, abortWarning);
      }
    };
    let queuedCleared = false;
    let embeddedAborted = false;
    const additionalStop = !requestedRunId
      ? {
          capture: channelStop,
          cancelInput: (input: (typeof channelStop.inputs)[number], cancel: () => boolean) => {
            const captured = channelSources.get(input);
            if (
              !captured ||
              input.mailbox !== captured.mailbox ||
              input.source !== captured.source ||
              input.target !== captured.target ||
              input.retirementRequested ||
              (input.source && input.source.run.sessionId !== captured.sessionId)
            ) {
              return false;
            }
            return cancel();
          },
          cancelOperation: (
            _operation: (typeof channelStop.operations)[number],
            cancel: () => boolean,
          ) => cancel(),
          onCancelled: (
            target: (typeof channelStop.inputs)[number] | (typeof channelStop.operations)[number],
          ) => {
            channelStopCommitted = true;
            if ("mailbox" in target) {
              channelSettlements.push(target.settlement.promise);
              if (channelStop.queuedInputs.includes(target)) {
                queuedCleared = true;
              } else {
                embeddedAborted = true;
              }
            } else {
              channelSettlements.push(target.ownerSettlement);
              embeddedAborted = true;
            }
          },
          afterParent: () => {
            const wasActive =
              channelStop.activeInputs.length > 0 || channelStop.operations.length > 0;
            if (embeddedAborted && sessionEmbeddedRun) {
              embeddedAbortPersistence = persistSessionAbort(sessionEmbeddedRun);
              void embeddedAbortPersistence.catch(() => {});
            }
            if ((queuedCleared || embeddedAborted) && embeddedController) {
              pendingMcpController = embeddedController;
            }
            if (
              (queuedCleared || embeddedAborted || canonicalKey === "global") &&
              persistedSessionId &&
              (canonicalKey === "global" || !wasActive || embeddedAborted)
            ) {
              assertAbortCurrent();
              mcpRetirement ??= retireSessionMcpRuntime({
                sessionId: persistedSessionId,
                reason: "session-stop",
              });
            }
          },
        }
      : undefined;
    const stopHookContext = {
      sessionKey: canonicalKey,
      sessionEntry,
      sessionId: persistedSessionId,
      commandSource: "gateway:sessions.abort",
      senderId: requester.deviceId ?? requester.connId,
    };
    const queuedAbort = abortQueuedCollectorSession({
      context,
      sessionKey: canonicalKey,
      sessionKeyAliases: [key, ...(requestedKeyAliases ?? [])],
      agentId: targetAgentId,
      sessionId: persistedSessionId,
      requiredSessionId,
      session: loadedSession ? { ok: true, value: loadedSession } : undefined,
      defaultAgentId: stableTargetOwner,
      runId: requestedRunId,
      abortOrigin: "rpc",
      stopReason: "rpc",
      requester,
      stopSource: requestedRunId ? "client-run" : "client-session",
      hookContext: stopHookContext,
      assertCurrent: assertAbortCurrent,
      additionalStop,
    });
    if (queuedAbort) {
      const result = await queuedAbort;
      if (result.ok) {
        abortWarning = result.value.warning;
      }
      await settleAbortPersistence(result.ok ? result.value.runIds : []);
      if (!result.ok) {
        respond(false, undefined, result.error);
      } else {
        respond(
          true,
          {
            ok: true,
            abortedRunId: result.value.runIds[0] ?? null,
            status: result.value.aborted ? "aborted" : "no-active-run",
            ...(abortWarning ? { warning: abortWarning } : {}),
          },
          undefined,
          undefined,
        );
      }
      return;
    }
    await handleChatAbortRequestWithLifecycle(
      bindGatewayRequestHandlerMutationAuthority(
        options,
        {
          ...options,
          params: {
            sessionKey: abortSessionKey,
            runId: requestedRunId,
            ...(abortAgentId ? { agentId: abortAgentId } : {}),
          },
          respond: (ok, payload, error, meta) => {
            if (!ok) {
              failedResponse = [ok, payload, error, meta];
              return;
            }
            chatAbortSucceeded = true;
            responseMeta = meta;
            abortWarning =
              payload && typeof payload === "object" && "warning" in payload
                ? normalizeOptionalString(payload.warning)
                : undefined;
            const runIds =
              payload &&
              typeof payload === "object" &&
              Array.isArray((payload as { runIds?: unknown[] }).runIds)
                ? (payload as { runIds: unknown[] }).runIds.filter((value): value is string =>
                    Boolean(normalizeOptionalString(value)),
                  )
                : [];
            const firstAbortedRunId = runIds[0] ?? null;
            abortedRunIds = runIds;
            abortedRunId = firstAbortedRunId;
            aborted =
              firstAbortedRunId !== null ||
              (payload !== null &&
                typeof payload === "object" &&
                (payload as { aborted?: unknown }).aborted === true);
            const workerOnly = Boolean(workerRunTarget && !activeRun);
            if (firstAbortedRunId && !workerOnly) {
              const endedAt = Date.now();
              const runKind = preAbortRuns.get(firstAbortedRunId)?.adapter.kind;
              const dedupePrefix = runKind === "agent" ? "agent" : "chat";
              const dedupeKey = `${dedupePrefix}:${firstAbortedRunId}`;
              // Nested cancellation can yield after the old controller ends. A new
              // receipt owns its outcome; this supplemental timeout must not replace it.
              if (context.dedupe.get(dedupeKey) !== preAbortDedupe.get(dedupeKey)) {
                return;
              }
              setGatewayDedupeEntry({
                dedupe: context.dedupe,
                key: dedupeKey,
                session: preAbortSessions.get(firstAbortedRunId),
                entry: {
                  ts: endedAt,
                  ok: true,
                  payload: {
                    status: "timeout",
                    runId: firstAbortedRunId,
                    ...(abortAgentId ? { agentId: abortAgentId } : {}),
                    stopReason: "rpc",
                    endedAt,
                  },
                },
              });
            }
          },
        },
        undefined,
      ),
      {
        ...(!requestedRunId ? { cascadeDescendants: true as const } : {}),
        hookContext: stopHookContext,
        additionalStop,
        onDescendantsCancelled: () => {
          descendantsCancelled = true;
        },
      },
    );
    await settleAbortPersistence(abortedRunIds);
    if (!chatAbortSucceeded) {
      if (failedResponse) {
        respond(...failedResponse);
      }
      return;
    }
    respond(
      true,
      {
        ok: true,
        abortedRunId,
        status: aborted ? "aborted" : "no-active-run",
        ...(abortWarning ? { warning: abortWarning } : {}),
      },
      undefined,
      responseMeta,
    );
    if (aborted) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        ...(abortAgentId ? { agentId: abortAgentId } : {}),
        reason: "abort",
      });
    }
  },
};
