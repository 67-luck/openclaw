import { readGlobalSingleton } from "../shared/global-singleton.js";

type NativeWorkerLifetime = {
  defaultSource?: { close(): Promise<void> };
};

const NATIVE_WORKER_LIFETIMES = Symbol.for("openclaw.nativeWorkerLifetimes");

/** Join an October-beta native owner when downgrading into this stable release. */
export async function closeDefaultRetainedNativeWorkerSource(): Promise<void> {
  // SAFETY: The October beta owns this symbol and records a close-capable default source.
  const lifetime = readGlobalSingleton(NATIVE_WORKER_LIFETIMES) as NativeWorkerLifetime | undefined;
  await lifetime?.defaultSource?.close();
}
