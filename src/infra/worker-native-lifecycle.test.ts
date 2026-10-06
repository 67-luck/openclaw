import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDefaultRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

const NATIVE_WORKER_LIFETIMES = Symbol.for("openclaw.nativeWorkerLifetimes");
const globalStore = globalThis as Record<PropertyKey, unknown>;

afterEach(() => {
  delete globalStore[NATIVE_WORKER_LIFETIMES];
});

describe("October beta native worker compatibility", () => {
  it("joins an existing default source", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    globalStore[NATIVE_WORKER_LIFETIMES] = {
      nextId: 1,
      sources: new WeakMap(),
      defaultSource: { close },
    };

    await closeDefaultRetainedNativeWorkerSource();

    expect(close).toHaveBeenCalledOnce();
  });

  it("does not initialize a missing owner", async () => {
    await closeDefaultRetainedNativeWorkerSource();

    expect(Object.hasOwn(globalStore, NATIVE_WORKER_LIFETIMES)).toBe(false);
  });
});
