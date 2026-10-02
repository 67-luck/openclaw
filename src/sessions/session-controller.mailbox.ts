/** Physical mailbox lifetime, exclusive claims, and the single successor selector. */
import { randomUUID } from "node:crypto";
import { resolveFollowupDeliveryContextKey } from "../auto-reply/reply/queue/delivery-context.js";
import { requiresIndividualCollectDrain } from "../auto-reply/reply/queue/envelope.js";
import type { FollowupRun, QueueSettings } from "../auto-reply/reply/queue/types.js";
import { isFollowupRunAborted } from "../auto-reply/reply/queue/types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { toErrorObject } from "../infra/errors.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { evaluateTurnAdmission } from "./session-controller.admission-rule.js";
import { captureSessionTarget, type SessionTarget } from "./session-controller.lifecycle.js";
import { releaseSessionControllerClaim } from "./session-controller.mailbox-claim.js";
import {
  inputCancellation,
  bindSessionControllerSource,
  abortSessionControllerInput,
  retireSessionControllerInput,
} from "./session-controller.mailbox-source.js";
import type {
  SessionControllerInput,
  SessionControllerMailboxClaim,
  SessionControllerMailbox,
  SessionControllerSourceAdapter,
} from "./session-controller.mailbox.types.js";
import {
  getSessionControllerEntry,
  findSessionControllerEntry,
  sessionControllers,
  pruneSessionControllerEntry,
} from "./session-controller.state.js";

export {
  bindSessionControllerInputOperation,
  attachSessionControllerInputOperation,
  releaseSessionControllerClaim,
} from "./session-controller.mailbox-claim.js";
export type {
  SessionControllerInput,
  SessionControllerMailboxClaim,
  SessionControllerMailbox,
  SessionControllerSourceAdapter,
} from "./session-controller.mailbox.types.js";
export {
  bindSessionControllerSource,
  isSessionControllerSourceQueued,
  beginSessionControllerSourceInjection,
  retireSessionControllerSourceCancellation,
  updateSessionControllerSourcePolicy,
  trackSessionControllerSourceWork,
  retireSessionControllerInput,
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
  holdSessionControllerSourceWithdrawal,
} from "./session-controller.mailbox-source.js";

export function getSessionControllerMailbox(
  key: string,
  target?: SessionTarget,
): SessionControllerMailbox {
  const owner = getSessionControllerEntry(key, target);
  if (owner.mailbox) {
    return owner.mailbox;
  }
  const mailbox: SessionControllerMailbox = {
    key: owner.key,
    owner,
    nextSequence: 0,
    entries: [],
    wake: () => pumpSessionControllerMailbox(mailbox),
    abortController: new AbortController(),
    get items() {
      return mailbox.entries.flatMap((input) =>
        input.payload === "ready" &&
        input.phase !== "consumed" &&
        !input.retirementRequested &&
        input.source
          ? [input.source]
          : [],
      );
    },
    get draining() {
      return Boolean(mailbox.claim);
    },
    get drainOwner() {
      return mailbox.claim;
    },
    get inFlight() {
      return new Set(mailbox.claim?.sources ?? []);
    },
    lastEnqueuedAt: 0,
    mode: "followup",
    debounceMs: 500,
    cap: 20,
    dropPolicy: "summarize",
    droppedCount: 0,
    summaryLines: [],
    summarySources: [],
    activeSummarySources: new Set(),
    summaryElisions: [],
    evictedSummaryCount: 0,
    recentSources: new Map(),
  };
  owner.mailbox = mailbox;
  return mailbox;
}

export function getExistingSessionControllerMailbox(key: string, target?: SessionTarget) {
  return findSessionControllerEntry(key.trim(), target)?.mailbox;
}

export function* sessionControllerMailboxes() {
  for (const owner of sessionControllers.values()) {
    if (owner.mailbox) {
      yield owner.mailbox;
    }
  }
}

export function claimSessionControllerInput(
  source: FollowupRun,
): Promise<SessionControllerMailboxClaim> {
  const input =
    source.controllerInput ??
    submitSessionControllerInput(source.run.sessionKey ?? source.run.sessionId, source, {
      mode: "followup",
    });
  if (input.claim && !input.claim.released) {
    return Promise.resolve(input.claim);
  }
  if (input.injection) {
    return Promise.reject(new Error("Source injection outcome pending"));
  }
  if (input.phase === "consumed" || input.retirementRequested) {
    return Promise.reject(new Error("Input already consumed"));
  }
  const pending = createDeferredCore<SessionControllerMailboxClaim>();
  const signals = [
    input.abortSignal,
    source.abortSignal,
    source.queueAbortSignal,
    source.operatorAuthority?.signal,
    input.sourceAdapter?.signal,
    input.sourceAdapter?.authority?.signal,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const abort = () => retireSessionControllerInput(input);
  input.ready = (claim) => {
    signal?.removeEventListener("abort", abort);
    pending.resolve(claim);
  };
  input.reject = (error) => {
    signal?.removeEventListener("abort", abort);
    pending.reject(error);
  };
  if (signal?.aborted) {
    abort();
    return pending.promise;
  }
  signal?.addEventListener("abort", abort, { once: true });
  input.phase = "waiting";
  input.mailbox.wake();
  return pending.promise;
}

/** Captures and detaches only this generation before invoking reentrant cancellation effects. */
export function clearSessionControllerMailbox(
  mailbox: SessionControllerMailbox,
  settleSource: (source: FollowupRun) => void,
  capturedInputs?: readonly SessionControllerInput[],
): number {
  const inputs = capturedInputs
    ? capturedInputs.filter(
        (input) =>
          input.mailbox === mailbox &&
          mailbox.entries.includes(input) &&
          !input.retirementRequested &&
          input.phase !== "consumed",
      )
    : [...mailbox.entries];
  const selected = new Set(inputs);
  const sources = [
    ...new Set([
      ...inputs.flatMap((input) => (input.source ? [input.source] : [])),
      ...summaryCandidates(mailbox).filter(
        (source) =>
          !capturedInputs || (source.controllerInput && selected.has(source.controllerInput)),
      ),
    ]),
  ];
  const cleared = capturedInputs ? inputs.length : mailbox.items.length + mailbox.droppedCount;
  const abort = capturedInputs ? undefined : mailbox.abortController;
  if (!capturedInputs) {
    mailbox.abortController = new AbortController();
  }
  const wasClearing = mailbox.clearing;
  mailbox.clearing = true;
  for (const input of inputs) {
    input.retirementRequested = true;
  }
  if (capturedInputs) {
    const selectedSource = (source: FollowupRun) =>
      Boolean(source.controllerInput && selected.has(source.controllerInput));
    let removed = 0;
    for (let index = mailbox.summarySources.length - 1; index >= 0; index--) {
      if (selectedSource(mailbox.summarySources[index]!)) {
        mailbox.summarySources.splice(index, 1);
        mailbox.summaryLines.splice(index, 1);
        removed++;
      }
    }
    for (const entry of mailbox.summaryElisions) {
      for (let index = entry.sources.length - 1; index >= 0; index--) {
        if (selectedSource(entry.sources[index]!)) {
          entry.sources.splice(index, 1);
          entry.summaryLines.splice(index, 1);
          removed++;
        }
      }
      for (const [original, compact] of entry.sourceRefs) {
        if (selectedSource(compact)) {
          entry.sourceRefs.delete(original);
        }
      }
      entry.count = entry.sources.length;
    }
    mailbox.summaryElisions = mailbox.summaryElisions.filter((entry) => entry.count > 0);
    mailbox.droppedCount = Math.max(0, mailbox.droppedCount - removed);
  } else {
    mailbox.summaryLines = [];
    mailbox.summarySources = [];
    mailbox.summaryElisions = [];
    mailbox.droppedCount = 0;
    mailbox.evictedSummaryCount = 0;
    mailbox.dispatch = undefined;
    mailbox.dispatchEnabled = false;
    mailbox.lastRun = undefined;
    mailbox.lastEnqueuedAt = 0;
  }
  for (const [key, record] of mailbox.recentSources) {
    if (
      selected.has(record.input) &&
      !record.input.custody.adopted &&
      record.input.phase !== "consumed"
    ) {
      mailbox.recentSources.delete(key);
    }
  }
  if (mailbox.priority && inputs.includes(mailbox.priority)) {
    mailbox.priority = undefined;
  }
  if (!capturedInputs && mailbox.timer) {
    clearTimeout(mailbox.timer);
    mailbox.timer = undefined;
  }
  try {
    abort?.abort();
    if (capturedInputs) {
      for (const input of inputs) {
        if (!input.withdrawalHolds) {
          abortSessionControllerInput(input, new Error("Session mailbox cleared"));
        }
      }
    }
    for (const source of sources) {
      const input = source.controllerInput;
      if ((input?.claim && !input.claim.released) || input?.phase === "injecting") {
        continue;
      }
      try {
        settleSource(source);
      } catch (error) {
        defaultRuntime.error?.("mailbox clear custody failed: " + String(error));
      }
    }
    for (const input of inputs) {
      // A durable discard owns its exact source until commit/release. Do not
      // consume that capability from a concurrent clear/publication callback.
      if (!input.withdrawalHolds) {
        input[inputCancellation].abort(new Error("Session mailbox cleared"));
      }
      retireSessionControllerInput(input);
    }
  } finally {
    mailbox.clearing = wasClearing;
    mailbox.wake();
  }
  return cleared;
}

export function detachSessionControllerSources(sources: readonly FollowupRun[]): void {
  for (const source of sources) {
    if (source.controllerInput) {
      source.controllerInput.payload = "unbound";
    }
  }
}

function summaryCandidates(mailbox: SessionControllerMailbox): FollowupRun[] {
  return [...mailbox.summaryElisions.flatMap((part) => part.sources), ...mailbox.summarySources];
}

/** The only successor selector. It claims synchronously; async work cannot select again. */
function pumpSessionControllerMailbox(mailbox: SessionControllerMailbox): void {
  const { owner, priority } = mailbox;
  const summaries = summaryCandidates(mailbox);
  const eligible = mailbox.entries.filter((input) => input.phase !== "consumed");
  const first = priority ?? eligible[0];
  const admission = evaluateTurnAdmission(owner, {
    kind:
      first?.taskTurnKind ??
      (first ? (first.custody.enqueued ? "queued_followup" : "visible") : "direct"),
    sessionKey: owner.key,
    registeredEntry: sessionControllers.get(owner.id),
    selectedInput: first ?? null,
  });
  if (!admission.admitted) {
    return;
  }
  if (!first) {
    disposeSessionControllerMailbox(mailbox);
    return;
  }
  if (
    first.retirementRequested ||
    first.phase !== "waiting" ||
    first.injection ||
    first.withdrawalHolds > 0 ||
    eligible.some((input) => input.injection)
  ) {
    return;
  }
  if (
    !first.ready &&
    !first.task &&
    (!mailbox.dispatchEnabled || !mailbox.dispatch || !first.source)
  ) {
    return;
  }
  const delay =
    first.ready || first.task || priority
      ? 0
      : Math.max(0, mailbox.lastEnqueuedAt + mailbox.debounceMs - Date.now());
  if (delay > 0) {
    if (mailbox.timer) {
      clearTimeout(mailbox.timer);
    }
    mailbox.timer = setTimeout(() => {
      mailbox.timer = undefined;
      mailbox.wake();
    }, delay);
    mailbox.timer.unref?.();
    return;
  }
  let sources = first.source ? [first.source] : [];
  const isSummary = !priority && first.source !== undefined && summaries.includes(first.source);
  if (
    !priority &&
    first.source &&
    !first.ready &&
    !first.task &&
    !requiresIndividualCollectDrain(first.source) &&
    (isSummary || first.policy.mode === "collect")
  ) {
    const context = resolveFollowupDeliveryContextKey(first.source);
    const candidates = isSummary ? summaries : mailbox.items;
    const start = candidates.indexOf(first.source);
    let previousInput = first;
    for (const candidate of candidates.slice(start + 1)) {
      const input = candidate.controllerInput;
      if (
        !input ||
        mailbox.entries.indexOf(input) !== mailbox.entries.indexOf(previousInput) + 1 ||
        input.retirementRequested ||
        input.phase !== "waiting" ||
        input.injection ||
        input.ready ||
        input.policy.mode !== first.policy.mode ||
        input.withdrawalHolds ||
        requiresIndividualCollectDrain(candidate) ||
        resolveFollowupDeliveryContextKey(candidate) !== context
      ) {
        break;
      }
      sources.push(candidate);
      previousInput = input;
    }
  }
  sources = sources.filter((source) => !isFollowupRunAborted(source));
  if (first.source && sources.length === 0) {
    first.payload = "unbound";
    retireSessionControllerInput(first);
    return;
  }
  const inputs = sources.length ? sources.map((source) => source.controllerInput!) : [first];
  const claim: SessionControllerMailboxClaim = {
    mailbox,
    inputs,
    sources,
    summary: isSummary,
    custody: {},
    released: false,
    settlement: createDeferredCore(),
    abortController: new AbortController(),
  };
  // Selection can be woken by another Gateway's retiring stack. Attribution
  // follows the captured source, never that incidental async context.
  bindGatewayContextResolver(claim, getGatewayContextResolver(first));
  mailbox.claim = claim;
  if (mailbox.priority === first) {
    mailbox.priority = undefined;
  }
  for (const input of inputs) {
    input.phase = "claimed";
    input.claim = claim;
  }
  if (first.ready) {
    first.ready(claim);
  } else if (first.task) {
    first.task(claim);
  } else {
    void mailbox.dispatch!(claim);
  }
}

/** Native producer admission enters the same sequence, not a parallel runnable list. */
export function submitSessionControllerTask(
  key: string,
  params: {
    signal?: AbortSignal;
    target?: SessionTarget;
    start(claim: SessionControllerMailboxClaim): void;
  },
): Promise<SessionControllerMailboxClaim> {
  const input = reserveSessionControllerSource(key, {
    policy: { mode: "followup" },
    target: params.target,
    adapter: { signal: params.signal },
  });
  return claimSessionControllerTask(input, (claim) => params.start(claim));
}

/** A prepared producer consumes its existing source, never submits another runnable input. */
export function claimSessionControllerTask(
  input: SessionControllerInput,
  start: (claim: SessionControllerMailboxClaim) => void,
  kind: NonNullable<SessionControllerInput["taskTurnKind"]> = "direct",
): Promise<SessionControllerMailboxClaim> {
  if (input.phase === "consumed" || input.retirementRequested || input.abortSignal.aborted) {
    return Promise.reject(toErrorObject(input.abortSignal.reason, "Source no longer available"));
  }
  if (input.injection) {
    return Promise.reject(new Error("Source injection outcome pending"));
  }
  if (input.claim && !input.claim.released) {
    try {
      start(input.claim);
      return Promise.resolve(input.claim);
    } catch (error) {
      return Promise.reject(toErrorObject(error, "Source claim failed"));
    }
  }
  if (input.task || input.ready) {
    return Promise.reject(new Error("Source already has a claim request"));
  }
  const pending = createDeferredCore<SessionControllerMailboxClaim>();
  input.reject = pending.reject;
  input.taskTurnKind = kind;
  input.task = (claim) => {
    try {
      input.abortSignal.throwIfAborted();
      start(claim);
      pending.resolve(claim);
    } catch (error) {
      releaseSessionControllerClaim(claim);
      pending.reject(error);
    }
  };
  input.phase = "waiting";
  input.mailbox.wake();
  return pending.promise;
}

/** Pre-dispatch may prepare a queued source, but cannot bypass the turn selector. */
export function tryClaimSessionControllerTask(
  input: SessionControllerInput,
  kind: NonNullable<SessionControllerInput["taskTurnKind"]> = "direct",
): SessionControllerMailboxClaim | undefined {
  if (input.claim && !input.claim.released) {
    return input.claim;
  }
  if (
    input.phase === "consumed" ||
    input.retirementRequested ||
    input.abortSignal.aborted ||
    input.injection ||
    input.withdrawalHolds
  ) {
    return undefined;
  }
  if (input.task || input.ready) {
    throw new Error("Source already has a claim request");
  }
  const phase = input.phase;
  let selected: SessionControllerMailboxClaim | undefined;
  input.taskTurnKind = kind;
  input.task = (claim) => {
    selected = claim;
  };
  input.phase = "waiting";
  try {
    input.mailbox.wake();
    return selected;
  } finally {
    input.task = undefined;
    if (!selected && !input.retirementRequested) {
      input.taskTurnKind = undefined;
      input.phase = phase;
    }
  }
}

function disposeSessionControllerMailbox(mailbox: SessionControllerMailbox): void {
  const now = Date.now();
  for (const [key, value] of mailbox.recentSources) {
    if (value.expires <= now) {
      mailbox.recentSources.delete(key);
    }
  }
  if (mailbox.entries.length || mailbox.claim || mailbox.priority || mailbox.droppedCount) {
    return;
  }
  mailbox.dispatch = undefined;
  mailbox.dispatchEnabled = false;
  mailbox.lastRun = undefined;
  if (mailbox.recentSources.size) {
    if (mailbox.timer) {
      clearTimeout(mailbox.timer);
    }
    const expires = Math.min(...[...mailbox.recentSources.values()].map((value) => value.expires));
    mailbox.timer = setTimeout(
      () => {
        mailbox.timer = undefined;
        disposeSessionControllerMailbox(mailbox);
      },
      Math.max(1, expires - now),
    );
    mailbox.timer.unref?.();
    return;
  }
  if (mailbox.timer) {
    clearTimeout(mailbox.timer);
  }
  mailbox.dispatch = undefined;
  mailbox.lastRun = undefined;
  const owner = mailbox.owner;
  if (owner?.mailbox === mailbox) {
    owner.mailbox = undefined;
  }
  if (owner) {
    pruneSessionControllerEntry(owner);
  }
}

/** Reserves identity/custody before attachment or prompt preparation, without owning a turn. */
export function reserveSessionControllerSource(
  key: string,
  params: {
    sourceTurnId?: string;
    protocolRunId?: string;
    sourceSessionId?: string;
    policy: QueueSettings;
    adapter?: SessionControllerSourceAdapter;
    target?: SessionTarget;
  },
): SessionControllerInput {
  const mailbox = getSessionControllerMailbox(
    key,
    params.target ??
      (params.adapter?.scope
        ? captureSessionTarget({ storeScope: params.adapter.scope, sessionKey: key })
        : undefined),
  );
  const cancellation = new AbortController();
  const signals = [
    cancellation.signal,
    params.adapter?.signal,
    params.adapter?.authority?.signal,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const input: SessionControllerInput = {
    [inputCancellation]: cancellation,
    abortSignal: signals.length > 1 ? AbortSignal.any(signals) : cancellation.signal,
    instance: Object.freeze({ id: randomUUID() }),
    sequence: ++mailbox.nextSequence,
    sourceTurnId: params.sourceTurnId,
    protocolRunId: params.protocolRunId,
    sourceSessionId: params.sourceSessionId,
    policy: Object.freeze({ ...params.policy }),
    mailbox,
    sourceAdapter: params.adapter,
    target: params.target ?? mailbox.owner.target,
    custody: {},
    settlement: createDeferredCore(),
    phase: "preparing",
    withdrawalHolds: 0,
    payload: "unbound",
  };
  bindGatewayContextResolver(input, getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext);
  mailbox.entries.push(input);
  if (params.policy.mode === "interrupt") {
    mailbox.priority = input;
  }
  const signal = input.abortSignal;
  const abort = () => {
    if (input.custody.cancellationRetired) {
      return;
    }
    if (input.claim && !input.claim.released) {
      input.claim.abortController.abort(signal.reason);
    }
    retireSessionControllerInput(input);
  };
  input.custody.disposeSource = () => signal.removeEventListener("abort", abort);
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  return input;
}

function resolveSourceTarget(key: string, source: FollowupRun): SessionTarget {
  return captureSessionTarget({
    storeScope: resolveSessionStorePathCore(source.run.config.session?.store, {
      agentId: source.run.agentId,
    }),
    sessionKey: key,
    incarnation: source.run.sessionId,
  });
}

/** Read source-scoped history without creating a mailbox for a rejected redelivery. */
export function findSessionControllerSourceMailbox(key: string, source: FollowupRun) {
  return (
    source.controllerInput?.mailbox ??
    getExistingSessionControllerMailbox(key, resolveSourceTarget(key, source))
  );
}

/** Capture source identity synchronously, before configuration reads or custody callbacks. */
export function submitSessionControllerInput(
  key: string,
  source: FollowupRun,
  policy: QueueSettings,
  protocolRunId?: string,
): SessionControllerInput {
  if (source.controllerInput) {
    if (!source.controllerInput.mailbox.owner.aliases.has(key.trim())) {
      throw new Error("Source belongs to a different controller");
    }
    if (source.controllerInput.injection) {
      throw new Error("Source injection outcome pending");
    }
    return source.controllerInput;
  }
  const input = reserveSessionControllerSource(key, {
    sourceTurnId: source.sourceTurnId,
    protocolRunId,
    policy,
    target: resolveSourceTarget(key, source),
  });
  bindSessionControllerSource(input, source);
  return input;
}

/** A native command may resolve its execution target after out-of-band handling.
 * Move its still-unbound source, not its identity/custody or a second reservation. */
export function retargetSessionControllerSource(
  input: SessionControllerInput,
  target: SessionTarget,
): void {
  const assertUnbound = () => {
    if (
      input.phase !== "preparing" ||
      input.claim ||
      input.source ||
      input.injection ||
      input.task ||
      input.ready ||
      input.retirementRequested ||
      input.withdrawalHolds ||
      input.custody.enqueued
    ) {
      throw new Error("Only unbound preparing sources may change execution target");
    }
    input.abortSignal.throwIfAborted();
  };
  assertUnbound();
  input.sourceAdapter?.authority?.assertCurrent();
  assertUnbound();
  const previous = input.mailbox;
  if (
    (input.sourceAdapter?.scope && input.sourceAdapter.scope !== target.storeScope) ||
    (previous.owner.target && previous.owner.target.storeScope !== target.storeScope)
  ) {
    throw new Error("Source cannot leave its admitted physical store");
  }
  const next = getSessionControllerMailbox(target.sessionKey, target);
  input.target = target;
  if (previous === next) {
    return;
  }
  const index = previous.entries.indexOf(input);
  if (index < 0) {
    throw new Error("Source no longer belongs to its captured mailbox");
  }
  previous.entries.splice(index, 1);
  if (previous.priority === input) {
    previous.priority = undefined;
  }
  input.mailbox = next;
  input.sequence = ++next.nextSequence;
  next.entries.push(input);
  if (input.policy.mode === "interrupt") {
    next.priority = input;
  }
  previous.wake();
}
