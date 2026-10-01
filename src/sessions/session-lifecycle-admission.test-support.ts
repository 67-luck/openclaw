import { vi } from "vitest";
import * as sessionLifecycle from "./session-controller.lifecycle.js";

export function observeSessionWorkAdmissionDrain(
  afterDrain: (
    params: Parameters<typeof sessionLifecycle.startSessionControllerInterruption>[0],
    released: boolean,
  ) => Promise<void> | void,
): () => void {
  const startInterruption = sessionLifecycle.startSessionControllerInterruption;
  const waitForRelease = sessionLifecycle.waitForSessionControllerSettlement;
  const interruptions = new WeakMap<Promise<void>, Parameters<typeof startInterruption>[0]>();
  const start = vi
    .spyOn(sessionLifecycle, "startSessionControllerInterruption")
    .mockImplementation((params) => {
      const interruption = startInterruption(params);
      interruptions.set(interruption.released, params);
      return interruption;
    });
  const wait = vi
    .spyOn(sessionLifecycle, "waitForSessionControllerSettlement")
    .mockImplementation(async (pending, timeoutMs) => {
      const released = await waitForRelease(pending, timeoutMs);
      const params = interruptions.get(pending);
      if (params) {
        interruptions.delete(pending);
        // Fixture pauses follow the real drain, outside its production deadline.
        await afterDrain(params, released);
      }
      return released;
    });
  return () => {
    wait.mockRestore();
    start.mockRestore();
  };
}

type RunExclusiveSessionLifecycleParams<T> = {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
};

/** Holds real effect validation for boundary race fixtures; no production test API. */
export async function runExclusiveSessionLifecycle<T>(
  params: RunExclusiveSessionLifecycleParams<T>,
): Promise<T> {
  let result: { value: T } | undefined;
  const effect = await sessionLifecycle.beginSessionEffect({
    scope: params.scope,
    identities: params.identities,
    signal: params.signal,
    assertAllowed: async () => {
      result = { value: await params.run() };
    },
    revalidateAllowed: () => {},
  });
  effect.release();
  if (!result) {
    throw new Error("Effect validator did not execute");
  }
  return result.value;
}
