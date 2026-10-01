import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isEmbeddedRunHandleCompacting } from "../agents/embedded-agent-runner/runs.probes.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "../auto-reply/reply/reply-dispatcher.types.js";
import { diagnosticLogger as diag } from "../logging/diagnostic-runtime.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { evaluateTurnAdmission } from "./session-controller.admission-rule.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  type ReplyBackendHandle,
  type ReplyOperation,
  type ReplyOperationPhase,
} from "./session-controller.contracts.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "./session-controller.identity.js";
import type { SessionControllerMailboxClaim } from "./session-controller.mailbox.js";
import { waitForReplyBarrierSettlement } from "./session-controller.settlement.js";
import type {
  ReplyRunAdmissionSource,
  ReplyRunAdmissionBarrier,
  SessionControllerEntry,
  ReplyRunCompletionObservation,
  ReplyOperationAfterClear,
  ReplyOperationSuccessorBarrierGroup,
} from "./session-controller.state.types.js";
import * as controllerStorage from "./session-controller.storage.js";
import type { SessionTarget } from "./session-controller.target.js";

export {
  sessionControllers,
  controllerEntryByOperation,
  lifecycleAdmissionByOperation,
  evictReplyOperationByOperation,
  operationsByUpstreamAbortSignal,
  producerCompletionByOperation,
} from "./session-controller.storage.js";
export type {
  ReplyRunWaiter,
  ReplyRunAdmissionSource,
  ReplyRunAdmissionBarrier,
  SessionControllerEntry,
} from "./session-controller.state.types.js";
export { waitForReplyBarrierSettlement } from "./session-controller.settlement.js";

/** Physical scope participates in selection, not just later writer validation. */
export function findSessionControllerEntries(
  key: string,
  target?: SessionTarget,
): SessionControllerEntry[] {
  const aliases = target?.aliases ?? [key.trim()];
  const matches = [...controllerStorage.sessionControllers.values()].filter(
    (entry) =>
      (!target || !entry.target || entry.target.storeScope === target.storeScope) &&
      aliases.some((alias) => entry.aliases.has(alias)),
  );
  if (matches.length > 1) {
    diag.warn(
      `ambiguous session controller identity: sessionKey=${key.trim()} entryIds=${matches
        .map((entry) => entry.id)
        .toSorted()
        .join(",")}`,
    );
  }
  return matches;
}
export function findSessionControllerEntry(
  key: string,
  target?: SessionTarget,
): SessionControllerEntry | undefined {
  const exact = controllerStorage.sessionControllers.get(key);
  // Registry IDs are private and never substituted for operation.key.
  if (exact && exact.id !== exact.key && !target) {
    return exact;
  }
  // Key-only lookup can overlap across stores while logical aliases and rekeys remain live.
  const matches = findSessionControllerEntries(key, target);
  return matches.length === 1 ? matches[0] : undefined;
}
export function bindSessionControllerEntryTarget(
  entry: SessionControllerEntry,
  target: SessionTarget,
): void {
  if (entry.target && entry.target.storeScope !== target.storeScope) {
    throw new Error("Cannot move a controller between physical stores");
  }
  const competing = findSessionControllerEntries(target.sessionKey, target).filter(
    (candidate) => candidate !== entry,
  );
  if (competing.length) {
    throw new Error("Physical session already has a different controller owner");
  }
  for (const alias of target.aliases) {
    if (
      alias !== target.incarnation &&
      ![...(entry.lifecycle?.operations ?? [])].some((operation) =>
        operation.hasOwnedSessionId(alias),
      )
    ) {
      entry.logicalAliases.add(alias);
    }
  }
  entry.target = target;
  refreshSessionControllerEntryAliases(entry);
}
export function refreshSessionControllerEntryAliases(entry: SessionControllerEntry): void {
  entry.aliases = new Set(entry.logicalAliases);
  if (entry.target?.incarnation) {
    entry.aliases.add(entry.target.incarnation);
  }
  for (const target of entry.lifecycle?.targets.keys() ?? []) {
    for (const alias of target.aliases) {
      entry.aliases.add(alias);
    }
  }
  for (const operation of entry.lifecycle?.operations ?? []) {
    for (const id of operation.captureOwnedSessionIds()) {
      entry.aliases.add(id);
    }
  }
  if (entry.active) {
    for (const id of entry.active.captureOwnedSessionIds()) {
      entry.aliases.add(id);
    }
  }
}
export function getSessionControllerEntry(
  key: string,
  target?: SessionTarget,
): SessionControllerEntry {
  const canonicalKey = normalizeOptionalString(key);
  if (!canonicalKey) {
    throw new Error("Session controller requires a canonical session key");
  }
  const registered = controllerStorage.sessionControllers.get(canonicalKey);
  if (registered && !target) {
    return registered;
  }
  const matches = findSessionControllerEntries(canonicalKey, target);
  if (matches.length > 1) {
    if (matches.some((entry) => entry.active)) {
      throw new ReplyRunAlreadyActiveError(canonicalKey);
    }
    throw new Error("Session controller identity requires a physical store scope");
  }
  let entry = matches[0];
  if (!entry) {
    entry = {
      id: randomUUID(),
      key: canonicalKey,
      aliases: new Set([canonicalKey]),
      logicalAliases: new Set([canonicalKey]),
      waiters: new Set(),
      observations: new Set(),
    };
    controllerStorage.sessionControllers.set(entry.id, entry);
  }
  if (target) {
    bindSessionControllerEntryTarget(entry, target);
  }
  return entry;
}
export {
  getSessionControllerEntryForOperation,
  hasSessionControllerIdentity,
  isCurrentSessionControllerOperation,
} from "./session-controller.identity.js";
/** Empty lifecycle entries do not retain historical session keys. Mailbox/mutation
 * owners release their entry field after their final effect; absence means no custody. */
export function pruneSessionControllerEntry(entry: SessionControllerEntry): void {
  if (
    !entry.active &&
    !entry.attachment &&
    !entry.sourceTurnId &&
    !entry.waiters.size &&
    !entry.followupBarrier &&
    !entry.successorBarrier &&
    !entry.observations.size &&
    !entry.mailbox &&
    !entry.lifecycle &&
    controllerStorage.sessionControllers.get(entry.id) === entry
  ) {
    controllerStorage.sessionControllers.delete(entry.id);
  }
}

export function getSessionControllerOperation(
  key: string,
  target?: SessionTarget,
): ReplyOperation | undefined {
  const normalizedKey = normalizeOptionalString(key);
  if (!normalizedKey) {
    return undefined;
  }
  const exact = !target ? controllerStorage.sessionControllers.get(normalizedKey) : undefined;
  if (exact && exact.id !== exact.key) {
    return exact.active;
  }
  const operations = findSessionControllerEntries(normalizedKey, target).flatMap((entry) =>
    entry.active ? [entry.active] : [],
  );
  if (operations.length > 1) {
    throw new ReplyRunAlreadyActiveError(key);
  }
  return operations[0];
}
export function* activeSessionOperations(): IterableIterator<ReplyOperation> {
  for (const entry of controllerStorage.sessionControllers.values()) {
    if (entry.active) {
      yield entry.active;
    }
  }
}

export { assertSessionControllerOperation } from "./session-controller.identity.js";

export {
  resolveControllerNativeAttempt,
  attachControllerNativeAttempt,
  detachControllerNativeAttempt,
} from "./session-controller.native-attempt.js";

/** Observe owner departures only for the lifetime of one awaited admission attempt. */
export function observeReplyRunCompletions(sessionKey: string) {
  const entry = getSessionControllerEntry(sessionKey);
  const observations = entry.observations;
  const observation: ReplyRunCompletionObservation = { changed: false, sources: new Map() };
  const pending = observations;
  pending.add(observation);
  return {
    read: () => (observation.changed ? [...observation.sources.values()] : undefined),
    dispose: () => {
      pending.delete(observation);
      observation.sources.clear();
      pruneSessionControllerEntry(entry);
    },
  };
}

export function resolveReplyOperationAgentId(sessionKey: string, agentId?: string) {
  const owner = normalizeOptionalString(agentId) ?? parseAgentSessionKey(sessionKey)?.agentId;
  return owner ? normalizeAgentId(owner) : undefined;
}

export function prepareReplyRunKeyUpdate(
  operation: ReplyOperation,
  nextSessionKey: string,
  agentId: string | undefined,
  stateCleared: boolean,
  mailboxClaim?: SessionControllerMailboxClaim,
): { sessionKey: string; agentId?: string } | undefined {
  const nextKey = normalizeOptionalString(nextSessionKey);
  if (!nextKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  const nextAgentId = resolveReplyOperationAgentId(nextKey, agentId) ?? operation.agentId;
  if (nextKey === operation.key && nextAgentId === operation.agentId) {
    return undefined;
  }
  // Running and settled operations have already published their abort/steer/wait identity.
  if (operation.result || stateCleared || operation.phase !== "queued") {
    throw new Error(`Cannot rekey reply operation ${operation.key} in phase ${operation.phase}`);
  }
  const entry = getSessionControllerEntryForOperation(operation);
  const target = entry.target
    ? { ...entry.target, sessionKey: nextKey, aliases: [nextKey] }
    : undefined;
  const targetOwner = getSessionControllerOperation(nextKey, target);
  if (targetOwner !== operation) {
    const owner = mailboxClaim?.mailbox.owner ?? findSessionControllerEntry(nextKey, target);
    if (owner) {
      const admission = evaluateTurnAdmission(owner, {
        kind: operation.turnKind,
        sessionKey: nextKey,
        registeredEntry: controllerStorage.sessionControllers.get(owner.id),
        claim: mailboxClaim,
      });
      if (!admission.admitted) {
        if (admission.reason === "followup-barrier") {
          throw new ReplyRunFollowupAdmissionBlockedError(nextKey);
        }
        if (admission.reason === "successor-barrier") {
          throw new ReplyRunSuccessorAdmissionBlockedError(nextKey);
        }
        throw new ReplyRunAlreadyActiveError(nextKey);
      }
    }
  }
  return { sessionKey: nextKey, agentId: nextAgentId };
}

export function notifyReplyRunEnded(owner: string | SessionControllerEntry): void {
  const entry = typeof owner === "string" ? findSessionControllerEntry(owner) : owner;
  if (!entry) {
    return;
  }
  for (const observation of entry.observations) {
    observation.changed = true;
  }
  if (!entry.active) {
    const waiters = entry.waiters;
    entry.waiters = new Set();
    for (const waiter of waiters) {
      waiter.finish(true);
    }
  }
  entry.mailbox?.wake();
  pruneSessionControllerEntry(entry);
}

export { resolveReplyRunForCurrentSessionId } from "./session-controller.identity.js";

export function isReplyRunCompacting(operation: ReplyOperation): boolean {
  if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") {
    return true;
  }
  const backend = operation.phase === "running" ? getAttachedBackend(operation) : undefined;
  return backend ? isEmbeddedRunHandleCompacting(operation.sessionId, backend) === true : false;
}

export function isReplyOperationPreBackendPhase(phase: ReplyOperationPhase): boolean {
  return (
    phase === "queued" ||
    phase === "waiting_for_deferred_maintenance" ||
    phase === "waiting_for_global_lane"
  );
}

export function markReplyOperationExecutionStarted(operation: ReplyOperation): void {
  controllerStorage.executionStartedOperations.add(operation);
}
export function hasReplyOperationExecutionStarted(operation: ReplyOperation): boolean {
  return controllerStorage.executionStartedOperations.has(operation);
}
// Alias-keyed fences registered for one lane rotate together. Rekeyed command
// operations retain prior-lane identities so source successors do not adopt
// the target session.

export function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  const entry = controllerStorage.controllerEntryByOperation.get(operation);
  return entry?.active === operation && entry.attachment?.operation === operation
    ? entry.attachment.backend
    : undefined;
}

// Committed output belongs to the bounded finalization owner. Stale recovery
// must not cancel delivery after the backend has already produced its answer.
export function hasCommittedReplyOperationOutcome(operation: ReplyOperation): boolean {
  return !operation.result && operation.abortFrozen;
}

export function isReplyOperationAbortable(operation: ReplyOperation): boolean {
  if (operation.result || operation.abortFrozen) {
    return false;
  }
  const backend = getAttachedBackend(operation);
  if (!backend?.isAbortable) {
    return true;
  }
  try {
    return backend.isAbortable();
  } catch {
    return false;
  }
}

/** Only the operation's own unforgeable signal can borrow its turn for preflight. */
export function resolveSessionControllerOperationForSignal(
  signal: AbortSignal | undefined,
): ReplyOperation | undefined {
  const operation = signal && controllerStorage.operationsByUpstreamAbortSignal.get(signal);
  return operation &&
    signal === operation.abortSignal &&
    isCurrentSessionControllerOperation(operation) &&
    !operation.result &&
    !signal.aborted
    ? operation
    : undefined;
}

export function isReplyRunAbortableForSignal(signal: AbortSignal): boolean {
  const operation = controllerStorage.operationsByUpstreamAbortSignal.get(signal);
  return operation ? isReplyOperationAbortable(operation) : true;
}

/** Resolve only the live operation admitted with this exact upstream signal. */
export function resolveActiveReplyRunOwnerForSignal(signal: AbortSignal):
  | {
      sessionId: string;
      sessionKey: string;
      abort: () => boolean;
      handoff: (settle: (producerCompleted: Promise<void>) => Promise<void>) => boolean;
    }
  | undefined {
  const operation = controllerStorage.operationsByUpstreamAbortSignal.get(signal);
  if (!operation) {
    return undefined;
  }
  const { key: sessionKey, sessionId } = operation;
  const isCurrent = () =>
    !signal.aborted &&
    !operation.result &&
    operation.key === sessionKey &&
    operation.sessionId === sessionId &&
    isCurrentSessionControllerOperation(operation);
  if (!isCurrent()) {
    return undefined;
  }
  return {
    sessionId,
    sessionKey,
    // A retained selector must never cancel the operation that replaced this owner.
    abort: () => isCurrent() && operation.abortByUser(),
    handoff: (settle) => {
      const producerCompleted = controllerStorage.producerCompletionByOperation.get(operation);
      if (!isCurrent() || !producerCompleted) {
        return false;
      }
      const settlement = settle(producerCompleted);
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId,
        sessionKeys: [sessionKey],
        start: () => settlement,
      });
      return true;
    },
  };
}

export function runAfterReplyOperationClear(
  operation: ReplyOperation,
  afterClear: (sessionId: string) => void,
): void {
  const afterClearState = controllerStorage.afterClearByOperation.get(operation);
  if (!afterClearState?.barrier && !isCurrentSessionControllerOperation(operation)) {
    const barrier = getSessionControllerEntryForOperation(operation).followupBarrier;
    const source = barrier?.sources.get(
      controllerStorage.lifecycleAdmissionByOperation.get(operation)?.databaseIdentity,
    );
    if (barrier && source) {
      void barrier.settled.then(() => afterClear(source.sessionId));
      return;
    }
    afterClear(operation.sessionId);
    return;
  }
  const state = afterClearState ?? { callbacks: new Set<(sessionId: string) => void>() };
  state.callbacks.add(afterClear);
  controllerStorage.afterClearByOperation.set(operation, state);
}

export function isReplyOperationAbortedForRestart(operation: ReplyOperation): boolean {
  return operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart";
}

export function mergeReplyRunAdmissionSource<T extends ReplyRunAdmissionSource>(
  source: T,
  previous?: ReplyRunAdmissionSource,
): T {
  // Only a connected UUID lineage in the same physical store can carry old work.
  // Restart invalidation cannot disappear when the next owner replaces the source.
  // Keep valid pending source references stable for retained clear callbacks.
  if (
    previous &&
    !isReplyOperationAbortedForRestart(previous.operation) &&
    previous.databaseIdentity === source.databaseIdentity &&
    source.sessionIds.has(previous.sessionId)
  ) {
    for (const id of source.sessionIds) {
      previous.sessionIds.add(id);
    }
    return Object.assign(previous, source, { sessionIds: previous.sessionIds });
  }
  return source;
}

function resolveReplyRunAdmissionSource(
  operation: ReplyOperation,
  sessionId: string,
  previous?: ReplyRunAdmissionSource,
): ReplyRunAdmissionSource {
  return mergeReplyRunAdmissionSource(
    {
      sessionId,
      sessionIds: operation.captureOwnedSessionIds(),
      operation,
      databaseIdentity:
        controllerStorage.lifecycleAdmissionByOperation.get(operation)?.databaseIdentity,
    },
    previous,
  );
}

function registerReplyRunAdmissionBarrier(
  barrierKind: "followupBarrier" | "successorBarrier",
  sessionKey: string,
  initialSource: ReplyRunAdmissionSource,
  barrier: Promise<void>,
): ReplyRunAdmissionBarrier {
  const sourceOwner = getSessionControllerEntryForOperation(initialSource.operation);
  const owner = sourceOwner.aliases.has(sessionKey)
    ? sourceOwner
    : getSessionControllerEntry(
        sessionKey,
        sourceOwner.target
          ? { ...sourceOwner.target, sessionKey, aliases: [sessionKey] }
          : undefined,
      );
  const previous = owner[barrierKind];
  const source = mergeReplyRunAdmissionSource(
    initialSource,
    previous?.sources.get(initialSource.databaseIdentity),
  );
  // Retain only the latest source per physical store in this pending chain.
  // A foreign global barrier must not hide a same-store compaction successor.
  const sources = new Map(previous?.sources);
  sources.set(source.databaseIdentity, source);
  const settled = previous
    ? Promise.all([previous.settled, barrier]).then(() => undefined)
    : barrier;
  const entry = { settled, source, sources };
  owner[barrierKind] = entry;
  void settled.then(() => {
    if (owner[barrierKind] === entry) {
      owner[barrierKind] = undefined;
      owner.mailbox?.wake();
      pruneSessionControllerEntry(owner);
    }
  });
  return entry;
}

/** Fence successor admission until owner handoff started at slot clear settles. */
export function registerReplyOperationSuccessorBarrier(params: {
  operation: ReplyOperation;
  sessionId: string;
  sessionKeys: readonly string[];
  start: () => PromiseLike<unknown>;
  /** Resource release fences start at clear; moving an active owner does not release it. */
  deferUntilClear?: boolean;
}): void {
  const settlement = createDeferredCore();
  const sources = new Map<string, ReplyRunAdmissionSource>();
  for (const sessionKey of new Set(params.sessionKeys.map(normalizeOptionalString))) {
    if (sessionKey) {
      sources.set(sessionKey, resolveReplyRunAdmissionSource(params.operation, params.sessionId));
    }
  }
  const publish = () => {
    for (const [sessionKey, source] of sources) {
      sources.set(
        sessionKey,
        registerReplyRunAdmissionBarrier("successorBarrier", sessionKey, source, settlement.promise)
          .source,
      );
    }
  };
  if (!params.deferUntilClear) {
    publish();
  }
  let started = false;
  const start = () => {
    if (started) {
      return;
    }
    started = true;
    try {
      if (params.deferUntilClear) {
        publish();
      }
      void Promise.resolve(params.start()).then(
        () => settlement.resolve(undefined),
        () => {},
      );
    } catch {
      // A failed handoff leaves the fence closed. Visible callers stay
      // abortably blocked; bounded queued callers cannot observe a partial release.
    }
  };
  if (!isCurrentSessionControllerOperation(params.operation)) {
    start();
    return;
  }
  const groups =
    controllerStorage.successorBarrierGroupsByOperation.get(params.operation) ??
    new Set<ReplyOperationSuccessorBarrierGroup>();
  groups.add({ registrationKey: params.operation.key, sources });
  controllerStorage.successorBarrierGroupsByOperation.set(params.operation, groups);
  const starts =
    controllerStorage.successorBarrierStartsByOperation.get(params.operation) ??
    new Set<() => void>();
  starts.add(start);
  controllerStorage.successorBarrierStartsByOperation.set(params.operation, starts);
}

export function startReplyOperationSuccessorBarriers(operation: ReplyOperation): void {
  const starts = controllerStorage.successorBarrierStartsByOperation.get(operation);
  // These maps are operation-owned lifecycle metadata, not identity indexes.
  // Clear drops both before handoff starts so adoption cannot retain stale groups.
  controllerStorage.successorBarrierStartsByOperation.delete(operation);
  controllerStorage.successorBarrierGroupsByOperation.delete(operation);
  if (!starts) {
    return;
  }
  for (const start of starts) {
    start();
  }
}

export function updateSuccessorAdmissionSessionId(
  operation: ReplyOperation,
  sessionId: string,
): void {
  for (const group of controllerStorage.successorBarrierGroupsByOperation.get(operation) ?? []) {
    if (group.registrationKey !== operation.key) {
      continue;
    }
    for (const source of group.sources.values()) {
      resolveReplyRunAdmissionSource(operation, sessionId, source);
    }
  }
}

export function isReplyRunSuccessorAdmissionBlocked(sessionKey: string): boolean {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return Boolean(
    normalizedSessionKey &&
    !getSessionControllerOperation(normalizedSessionKey) &&
    findSessionControllerEntry(normalizedSessionKey)?.successorBarrier,
  );
}

export function flushReplyOperationAfterClear(operation: ReplyOperation, sessionId: string): void {
  const state = controllerStorage.afterClearByOperation.get(operation);
  if (!state) {
    return;
  }
  controllerStorage.afterClearByOperation.delete(operation);
  for (const callback of state.callbacks) {
    callback(sessionId);
  }
}

export function registerFollowupAdmissionBarrier(
  operation: ReplyOperation,
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): ReplyRunAdmissionBarrier {
  const entry = registerReplyRunAdmissionBarrier(
    "followupBarrier",
    operation.key,
    resolveReplyRunAdmissionSource(operation, operation.sessionId),
    waitForReplyBarrierSettlement(barrier, timeout),
  );
  // A later global barrier may belong to another store. Late callbacks still
  // wait for this operation's own delivery before releasing admission.
  const afterClear: ReplyOperationAfterClear = controllerStorage.afterClearByOperation.get(
    operation,
  ) ?? {
    callbacks: new Set<(sessionId: string) => void>(),
  };
  afterClear.barrier = entry;
  controllerStorage.afterClearByOperation.set(operation, afterClear);
  return entry;
}

export function updateFollowupAdmissionSessionId(operation: ReplyOperation): void {
  const sources = getSessionControllerEntryForOperation(operation).followupBarrier?.sources;
  const databaseIdentity =
    controllerStorage.lifecycleAdmissionByOperation.get(operation)?.databaseIdentity;
  const source = sources?.get(databaseIdentity);
  if (sources && source) {
    sources.set(
      databaseIdentity,
      resolveReplyRunAdmissionSource(operation, operation.sessionId, source),
    );
  }
}

export function clearReplyRunState(params: {
  sessionKey: string;
  sessionId: string;
  operation: ReplyOperation;
}): void {
  const entry = getSessionControllerEntryForOperation(params.operation);
  if (!isCurrentSessionControllerOperation(params.operation)) {
    return;
  }
  for (const observation of entry.observations) {
    if (
      !params.operation.result ||
      params.operation.key !== params.sessionKey ||
      isReplyOperationAbortedForRestart(params.operation)
    ) {
      observation.sources.clear();
      continue;
    }
    const source = resolveReplyRunAdmissionSource(params.operation, params.sessionId);
    observation.sources.set(
      source.databaseIdentity,
      mergeReplyRunAdmissionSource(source, observation.sources.get(source.databaseIdentity)),
    );
  }
  entry.active = undefined;
  if (entry.attachment?.operation === params.operation) {
    entry.attachment = undefined;
  }
  entry.sourceTurnId = undefined;
  notifyReplyRunEnded(entry);
}

/** Incoming sources consult the same owner policy as the autonomous timer. */
export function isReplyRunEvidenceStale(operation: ReplyOperation): boolean {
  const action = operation.watchdog.decide().action;
  return action === "stop" || action === "expire_cleanup" || action === "blocked";
}

export function expireVisibleStaleOperation(operation: ReplyOperation | undefined): boolean {
  if (!operation) {
    return false;
  }
  void operation.watchdog.tick();
  return !isCurrentSessionControllerOperation(operation);
}

export function resolveVisibleActiveWaitMs(operation: ReplyOperation | undefined): number {
  const deadline = operation?.watchdog.decide().deadlineAtMs;
  return deadline === undefined
    ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS
    : Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
}
