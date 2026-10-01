import { completeSessionControllerSourceLifecycle } from "../../../sessions/session-controller.mailbox-source.js";
import { submitSessionControllerInput } from "../../../sessions/session-controller.mailbox.js";
import type { FollowupRun } from "./types.js";

function custody(run: FollowupRun) {
  if (run.controllerClaim) {
    return run.controllerClaim.custody;
  }
  return (
    run.controllerInput ??
    submitSessionControllerInput(run.run.sessionKey ?? run.run.sessionId, run, { mode: "followup" })
  ).custody;
}
export function startFollowupRunPreAdoptionHeartbeat(
  run: FollowupRun,
  abortSignal?: AbortSignal,
): (() => void) | undefined {
  const lifecycle = run.turnAdoptionLifecycle;
  const state = custody(run);
  const intervalMs = lifecycle?.deferredHeartbeatIntervalMs;
  const heartbeat = lifecycle?.onDeferredHeartbeat;
  if (
    !lifecycle ||
    !heartbeat ||
    !intervalMs ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    lifecycle.abortSignal?.aborted ||
    abortSignal?.aborted ||
    state.adopted ||
    state.completed
  ) {
    return undefined;
  }
  state.stopHeartbeat?.();
  const stop = () => {
    clearInterval(timer);
    lifecycle.abortSignal?.removeEventListener("abort", stop);
    abortSignal?.removeEventListener("abort", stop);
    if (state.stopHeartbeat === stop) {
      state.stopHeartbeat = undefined;
    }
  };
  const pulse = () => {
    try {
      heartbeat();
    } catch {
      stop();
    }
  };
  const timer = setInterval(pulse, intervalMs).unref();
  state.stopHeartbeat = stop;
  lifecycle.abortSignal?.addEventListener("abort", stop, { once: true });
  abortSignal?.addEventListener("abort", stop, { once: true });
  pulse();
  return stop;
}
export function markFollowupRunEnqueued(run: FollowupRun): boolean {
  const state = custody(run);
  const authority = run.operatorAuthority;
  authority?.signal?.throwIfAborted();
  authority?.assertCurrent();
  if (!state.enqueued) {
    if (run.turnAdoptionLifecycle?.onDeferred?.() === false) {
      return false;
    }
    try {
      state.releaseAuthority = authority?.retain?.();
    } catch (error) {
      completeFollowupRunLifecycle(run);
      throw error;
    }
    state.enqueued = true;
    startFollowupRunPreAdoptionHeartbeat(run);
  }
  return true;
}
export function retireFollowupRunCancellation(run: FollowupRun): void {
  const state = custody(run);
  if (state.cancellationRetired) {
    return;
  }
  state.cancellationRetired = true;
  run.turnAdoptionLifecycle?.onCancellationRetired?.();
}
export async function admitFollowupRunLifecycle(run: FollowupRun): Promise<void> {
  const state = custody(run);
  run.operatorAuthority?.assertCurrent();
  if (state.adopted) {
    return;
  }
  if (state.adopting) {
    return await state.adopting;
  }
  if (state.completed) {
    throw new Error("Input completed before source adoption");
  }
  const admission = Promise.resolve().then(async () => {
    await run.turnAdoptionLifecycle?.onAdopted();
    // A successful custody callback commits before the post-await authority check.
    state.adopted = true;
    state.failure = undefined;
    state.stopHeartbeat?.();
    run.operatorAuthority?.assertCurrent();
  });
  state.adopting = admission;
  try {
    await admission;
  } catch (error) {
    state.failure = error;
    throw error;
  } finally {
    state.adopting = undefined;
  }
}

/** Adapter registers source identity before the canonical custody owner settles it. */
export function completeFollowupRunLifecycle(run: FollowupRun, disposition?: "consumed"): void {
  completeSessionControllerSourceLifecycle(run, custody(run), disposition);
}
