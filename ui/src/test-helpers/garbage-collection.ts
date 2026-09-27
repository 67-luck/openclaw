import { setImmediate } from "node:timers/promises";

export async function collectGarbageForTest(collectInNode?: () => void): Promise<void> {
  // WeakRef targets stay alive for the current job, even without a strong owner.
  await setImmediate();
  if (collectInNode && !process.versions.bun) {
    collectInNode();
  } else {
    // Inspector collection runs after the JS entry unwinds, releasing native stack roots.
    const { Session } = await import("node:inspector");
    const session = new Session();
    session.connect();
    try {
      await new Promise<void>((resolve, reject) => {
        session.post("HeapProfiler.collectGarbage", (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    } finally {
      // Disconnect after the GC callback releases V8's internal callback lock.
      await setImmediate();
      session.disconnect();
    }
  }
}
