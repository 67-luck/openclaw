import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginServiceV2,
  PluginServiceSchedulerV1,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixFullRuntime } from "../../../index.js";
import {
  getOptionalMatrixRuntime,
  setMatrixRuntime,
  setMatrixServiceScheduler,
} from "../../runtime.js";
import {
  acquireSharedMatrixClient,
  adoptSharedMatrixClientScheduler,
  stopSharedClientForAccount,
} from "./shared.js";
import { authFor, createMockClient } from "./shared.test-support.js";

const createMatrixClientMock = vi.hoisted(() => vi.fn());

vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
}));

type SharedLease = Awaited<ReturnType<typeof acquireSharedMatrixClient>>;
type Disposer = () => void | Promise<void>;
type RegisteredOwner = {
  runtime: PluginRuntime;
  startService: (scheduler: PluginServiceSchedulerV1) => Promise<void>;
  snapshotDisposers: () => Disposer[];
  dispose: () => Promise<void>;
};

const { clearRuntime: clearMatrixRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "matrix",
  errorMessage: "Matrix runtime not initialized",
});

const owners: RegisteredOwner[] = [];
const acquisitions: Promise<SharedLease>[] = [];
const leases: SharedLease[] = [];
const releaseBlockedIo: Array<() => void> = [];
let previousRuntime: PluginRuntime | null;

function registerOwner(onDisposeRegistered?: () => void): RegisteredOwner {
  const controller = new AbortController();
  const disposers = new Set<Disposer>();
  let timerService: OpenClawPluginServiceV2 | undefined;
  const api = createTestPluginApi({
    id: "matrix",
    name: "Matrix",
    registerService: (service) => {
      if (service.id === "matrix-clients" && service.apiVersion === 2) {
        timerService = service;
      }
    },
  });
  api.lifecycle = {
    ...api.lifecycle,
    signal: controller.signal,
    onDispose: (dispose) => {
      controller.signal.throwIfAborted();
      disposers.add(dispose);
      onDisposeRegistered?.();
      return () => void disposers.delete(dispose);
    },
  };
  registerMatrixFullRuntime(api);
  let disposal: Promise<void> | undefined;
  const owner = {
    runtime: api.runtime,
    startService: async (scheduler: PluginServiceSchedulerV1) => {
      if (!timerService) {
        throw new Error("Missing Matrix client service");
      }
      await timerService.start({ scheduler, config: {}, stateDir: ".", logger: api.logger });
    },
    snapshotDisposers: () => [...disposers],
    dispose: () => {
      disposal ??= (async () => {
        controller.abort();
        for (const dispose of [...disposers].toReversed()) {
          await dispose();
        }
      })();
      return disposal;
    },
  };
  owners.push(owner);
  return owner;
}

function acquire(
  runtime: PluginRuntime,
  params: Parameters<typeof acquireSharedMatrixClient>[0],
): Promise<SharedLease> {
  setMatrixRuntime(runtime);
  const acquisition = acquireSharedMatrixClient(params);
  acquisitions.push(acquisition);
  void acquisition.then(
    (lease) => leases.push(lease),
    () => undefined,
  );
  return acquisition;
}

beforeEach(() => {
  previousRuntime = getOptionalMatrixRuntime();
  createMatrixClientMock.mockReset();
});

afterEach(async () => {
  for (const release of releaseBlockedIo.splice(0)) {
    release();
  }
  const disposals = owners.splice(0).map((owner) => owner.dispose());
  await Promise.allSettled(acquisitions.splice(0));
  await Promise.allSettled(leases.splice(0).map((lease) => lease.release({ mode: "discard" })));
  await Promise.allSettled(disposals);
  if (previousRuntime) {
    setMatrixRuntime(previousRuntime);
  } else {
    clearMatrixRuntime();
  }
});

describe("shared Matrix plugin lifecycle", () => {
  it("adopts a scheduler installed between client construction and publication", async () => {
    const owner = registerOwner();
    const scheduler = createTestPluginServiceScheduler();
    const client = createMockClient("publishing-client");
    const creationStarted = createDeferred<void>();
    const construction = createDeferred<typeof client>();
    releaseBlockedIo.push(() => construction.resolve(client));
    createMatrixClientMock.mockImplementationOnce(() => {
      creationStarted.resolve();
      return construction.promise;
    });
    const acquiring = acquire(owner.runtime, {
      auth: authFor("publishing-client"),
      startClient: false,
    });
    try {
      await creationStarted.promise;
      construction.resolve(client);
      const adopting = Promise.resolve().then(() => {
        const lifecycle = setMatrixServiceScheduler(owner.runtime, scheduler);
        return adoptSharedMatrixClientScheduler(lifecycle, scheduler);
      });
      await Promise.all([acquiring, adopting]);
      expect(client.setServiceScheduler).toHaveBeenCalledWith(scheduler);
    } finally {
      construction.resolve(client);
      await scheduler.stop();
    }
  });

  it("keeps lifecycle disposal pending after a public retirement deadline until physical cleanup", async () => {
    vi.useFakeTimers();
    const owner = registerOwner();
    const auth = authFor("late-startup-owner");
    const client = createMockClient("late-startup-owner");
    const startupEntered = createDeferred<void>();
    const releaseStartup = createDeferred<void>();
    const cleanupEntered = createDeferred<void>();
    const releaseCleanup = createDeferred<void>();
    releaseBlockedIo.push(() => {
      releaseStartup.resolve();
      releaseCleanup.resolve();
    });
    client.start.mockImplementationOnce(async () => {
      startupEntered.resolve();
      await releaseStartup.promise;
    });
    client.stopWithoutPersist.mockImplementationOnce(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });
    createMatrixClientMock.mockResolvedValueOnce(client);
    const lease = await acquire(owner.runtime, { auth, startClient: false, role: "monitor" });
    const startup = lease.start().catch(() => undefined);
    await startupEntered.promise;
    const publicResult = stopSharedClientForAccount(auth).then(
      () => undefined,
      (error: unknown) => error,
    );
    const disposal = owner.dispose();
    let disposed = false;
    void disposal.then(
      () => {
        disposed = true;
      },
      () => {
        disposed = true;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(publicResult).resolves.toMatchObject({
        message: "Matrix client startup did not settle within 5000ms during retirement",
      });
      expect(disposed).toBe(false);
      releaseStartup.resolve();
      await cleanupEntered.promise;
      expect(disposed).toBe(false);
      releaseCleanup.resolve();
      await expect(disposal).rejects.toThrow("startup did not settle");
    } finally {
      releaseStartup.resolve();
      releaseCleanup.resolve();
      await Promise.allSettled([startup, disposal]);
      vi.useRealTimers();
    }
  });

  it.each(["created", "creating"] as const)(
    "adopts the service lifetime for a client %s before service startup",
    async (phase) => {
      const owner = registerOwner();
      const scheduler = createTestPluginServiceScheduler();
      const creationStarted = createDeferred<void>();
      const releaseCreation = createDeferred<void>();
      releaseBlockedIo.push(() => releaseCreation.resolve());
      const client = createMockClient("early-client");
      createMatrixClientMock.mockImplementationOnce(async () => {
        creationStarted.resolve();
        await releaseCreation.promise;
        return client;
      });
      const acquiring = acquire(owner.runtime, {
        auth: authFor("early-client"),
        startClient: false,
        role: "monitor",
      });
      try {
        await creationStarted.promise;
        if (phase === "created") {
          releaseCreation.resolve();
          await acquiring;
        }
        await owner.startService(scheduler);
        releaseCreation.resolve();
        await acquiring;
        expect(client.setServiceScheduler).toHaveBeenCalledWith(scheduler);
        expect(client.stopAndPersist).not.toHaveBeenCalled();
      } finally {
        releaseCreation.resolve();
        await scheduler.stop();
      }
    },
  );

  it("retires the disposed owner's shared client while another runtime stays live", async () => {
    const firstOwner = registerOwner();
    const otherOwner = registerOwner();
    const firstClient = createMockClient("first");
    const otherClient = createMockClient("other");
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(otherClient);
    const auth = authFor("lifecycle-first");
    const first = await acquire(firstOwner.runtime, { auth, startClient: false });
    const shared = await acquire(firstOwner.runtime, { auth, startClient: false });
    const other = await acquire(otherOwner.runtime, {
      auth: authFor("lifecycle-other"),
      startClient: false,
    });

    expect(shared.client).toBe(first.client);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    await firstOwner.dispose();

    expect(first.abortSignal.aborted).toBe(true);
    expect(shared.abortSignal.aborted).toBe(true);
    expect(firstClient.stopAndPersist).toHaveBeenCalledOnce();
    expect(firstClient.stopWithoutPersist).not.toHaveBeenCalled();
    expect(other.abortSignal.aborted).toBe(false);
    expect(otherClient.quiesceSync).not.toHaveBeenCalled();
    await expect(first.start()).rejects.toThrow("released");
    await other.start();
    expect(otherClient.start).toHaveBeenCalledOnce();
  });

  it("waits for the previous owner's physical shutdown before reusing the same auth", async () => {
    const firstOwner = registerOwner();
    const nextOwner = registerOwner();
    const firstClient = createMockClient("first");
    const nextClient = createMockClient("next");
    const finishStop = createDeferred<void>();
    releaseBlockedIo.push(() => finishStop.resolve());
    let physicallyStopped = false;
    firstClient.stopAndPersist.mockImplementation(async () => {
      await finishStop.promise;
      physicallyStopped = true;
    });
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockImplementationOnce(async () => {
      expect(physicallyStopped).toBe(true);
      return nextClient;
    });
    const auth = authFor("lifecycle-transfer");
    await acquire(firstOwner.runtime, { auth, startClient: false });
    const next = acquire(nextOwner.runtime, { auth, startClient: false });
    const settled = vi.fn();
    void next.then(settled, settled);
    await setImmediate();

    expect(settled).not.toHaveBeenCalled();
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    const retirement = firstOwner.dispose();
    await setImmediate();
    expect(firstClient.stopAndPersist).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    expect(createMatrixClientMock).toHaveBeenCalledOnce();

    finishStop.resolve();
    await retirement;
    const replacement = await next;
    expect(replacement.client).toBe(nextClient);
    expect(replacement.abortSignal.aborted).toBe(false);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a successor alive when the previous owner's captured cleanup runs late", async () => {
    const firstOwner = registerOwner();
    const nextOwner = registerOwner();
    const firstClient = createMockClient("first");
    const nextClient = createMockClient("next");
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(nextClient);
    const auth = authFor("lifecycle-late-cleanup");
    const first = await acquire(firstOwner.runtime, { auth, startClient: false });
    const capturedDisposers = firstOwner.snapshotDisposers();
    await first.release({ mode: "persist" });
    expect(firstOwner.snapshotDisposers()).toEqual([]);
    const replacement = await acquire(nextOwner.runtime, { auth, startClient: false });

    await firstOwner.dispose();
    for (const dispose of capturedDisposers) {
      await dispose();
    }
    setMatrixRuntime(firstOwner.runtime);
    await stopSharedClientForAccount(auth);

    expect(firstClient.stopAndPersist).toHaveBeenCalledOnce();
    expect(nextClient.quiesceSync).not.toHaveBeenCalled();
    expect(replacement.abortSignal.aborted).toBe(false);
    const sharedReplacement = await acquire(nextOwner.runtime, { auth, startClient: false });
    expect(sharedReplacement.client).toBe(nextClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
  });

  it("wakes an existing successor waiter when creation is cancelled before its first lease", async () => {
    const nextOwner = registerOwner();
    const caller = new AbortController();
    const auth = authFor("lifecycle-cancelled-creation");
    let next: Promise<SharedLease> | undefined;
    const firstOwner = registerOwner(() => {
      // Registration exposes the created client before its first lease is admitted.
      // Let the successor wait for that custody before cancelling the first caller.
      next = acquire(nextOwner.runtime, { auth, startClient: false });
      queueMicrotask(() => caller.abort());
    });
    const firstClient = createMockClient("unclaimed");
    const nextClient = createMockClient("next");
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(nextClient);

    await expect(
      acquire(firstOwner.runtime, { auth, startClient: false, abortSignal: caller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(firstClient.start).not.toHaveBeenCalled();
    expect(firstClient.stopWithoutPersist).toHaveBeenCalledOnce();
    if (!next) {
      throw new Error("Expected successor acquisition during client lifecycle registration");
    }
    const replacement = await next;
    expect(replacement.client).toBe(nextClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
  });

  it("preserves shared clients for registration APIs without instance lifecycle hooks", async () => {
    const api = createTestPluginApi({ id: "matrix", name: "Matrix" });
    registerMatrixFullRuntime(api);
    const client = createMockClient("legacy");
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("lifecycle-legacy");
    const first = await acquire(api.runtime, { auth, startClient: false });
    const second = await acquire(api.runtime, { auth, startClient: false });

    expect(second.client).toBe(first.client);
    await first.release();
    expect(client.stopAndPersist).not.toHaveBeenCalled();
    await second.release();
    expect(client.stopAndPersist).toHaveBeenCalledOnce();
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
  });
});
