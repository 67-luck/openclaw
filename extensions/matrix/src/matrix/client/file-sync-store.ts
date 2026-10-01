// Matrix plugin module implements the live SDK's SQLite sync store.
import {
  MemoryStore,
  SyncAccumulator,
  type ISyncData,
  type ISyncResponse,
  type IStoredClientOpts,
} from "matrix-js-sdk/lib/matrix.js";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import { LogService } from "../sdk/logger.js";
import { claimCurrentTokenStorageState } from "./storage.js";
import {
  MATRIX_SYNC_CACHE_VERSION,
  deleteMatrixSyncCacheStateFromStore,
  openMatrixSyncCacheStoreOptions,
  readPersistedStoreFromStore,
  writeMatrixSyncCacheStateToStore,
  type MatrixSyncCacheRecord,
  type PersistedMatrixSyncStore,
} from "./sync-cache-state.js";

const PERSIST_DEBOUNCE_MS = 250;

function syncDataToSyncResponse(syncData: ISyncData): ISyncResponse {
  return {
    next_batch: syncData.nextBatch,
    rooms: syncData.roomsData,
    account_data: {
      events: syncData.accountData,
    },
  };
}

export class SqliteBackedMatrixSyncStore extends MemoryStore {
  private readonly persistLock = createAsyncLock();
  private readonly accumulator = new SyncAccumulator();
  private savedSync: ISyncData | null = null;
  private savedClientOptions: IStoredClientOpts | undefined;
  private readonly hadSavedSyncOnLoad: boolean;
  private readonly hadCleanShutdownOnLoad: boolean;
  private cleanShutdown = false;
  private dirty = false;
  private frozen = false;
  private scheduler: PluginServiceSchedulerV1 | undefined;
  private schedulerOwner: PluginServiceSchedulerV1 | undefined;
  private persistJob: ReturnType<PluginServiceSchedulerV1["schedule"]> | undefined;
  private persistPromise: Promise<void> | null = null;

  static async create(
    storageRootDir: string,
    scheduler?: PluginServiceSchedulerV1,
  ): Promise<SqliteBackedMatrixSyncStore> {
    let store: PluginStateKeyedStore<MatrixSyncCacheRecord> | undefined;
    let persisted: PersistedMatrixSyncStore | null = null;
    let unavailableError: unknown;
    try {
      store = getMatrixRuntime().state.openKeyedStore<MatrixSyncCacheRecord>(
        openMatrixSyncCacheStoreOptions(storageRootDir),
      );
      persisted = await readPersistedStoreFromStore({ storageRootDir, store });
    } catch (error) {
      unavailableError = error;
      LogService.warn("MatrixSyncCacheStore", "Failed to load Matrix sync cache:", error);
    }
    return new SqliteBackedMatrixSyncStore(
      storageRootDir,
      store,
      persisted,
      unavailableError,
      scheduler,
    );
  }

  private constructor(
    private readonly storageRootDir: string,
    private readonly store: PluginStateKeyedStore<MatrixSyncCacheRecord> | undefined,
    persisted: PersistedMatrixSyncStore | null,
    private readonly storeUnavailableError: unknown,
    scheduler?: PluginServiceSchedulerV1,
  ) {
    super();
    this.schedulerOwner = scheduler;
    this.scheduler = scheduler?.scope();
    const restoredSavedSync = persisted?.savedSync ?? null;
    const restoredClientOptions = persisted?.clientOptions;
    const restoredCleanShutdown = persisted?.cleanShutdown === true;

    this.savedSync = restoredSavedSync;
    this.savedClientOptions = restoredClientOptions;
    this.hadSavedSyncOnLoad = restoredSavedSync !== null;
    this.hadCleanShutdownOnLoad = this.hadSavedSyncOnLoad && restoredCleanShutdown;
    this.cleanShutdown = this.hadCleanShutdownOnLoad;

    if (this.savedSync) {
      this.accumulator.accumulate(syncDataToSyncResponse(this.savedSync), true);
      super.setSyncToken(this.savedSync.nextBatch);
    }
    if (this.savedClientOptions) {
      void super.storeClientOptions(this.savedClientOptions);
    }
  }

  hasSavedSync(): boolean {
    return this.hadSavedSyncOnLoad;
  }

  async setServiceScheduler(scheduler: PluginServiceSchedulerV1): Promise<void> {
    if (this.frozen || this.schedulerOwner === scheduler) {
      return;
    }
    await this.scheduler?.stop();
    if (this.frozen) {
      return;
    }
    this.clearPersistTimer();
    this.scheduler = scheduler.scope();
    this.schedulerOwner = scheduler;
    if (this.dirty) {
      this.schedulePersist();
    }
  }

  hasSavedSyncFromCleanShutdown(): boolean {
    return this.hadCleanShutdownOnLoad;
  }

  override getSavedSync(): Promise<ISyncData | null> {
    return Promise.resolve(this.savedSync ? structuredClone(this.savedSync) : null);
  }

  override getSavedSyncToken(): Promise<string | null> {
    return Promise.resolve(this.savedSync?.nextBatch ?? null);
  }

  override setSyncData(syncData: ISyncResponse): Promise<void> {
    if (this.frozen) {
      return Promise.resolve();
    }
    this.accumulator.accumulate(syncData);
    this.savedSync = this.accumulator.getJSON();
    this.markDirtyAndSchedulePersist();
    return Promise.resolve();
  }

  override getClientOptions() {
    return Promise.resolve(
      this.savedClientOptions ? structuredClone(this.savedClientOptions) : undefined,
    );
  }

  override storeClientOptions(options: IStoredClientOpts) {
    if (this.frozen) {
      return Promise.resolve();
    }
    this.savedClientOptions = structuredClone(options);
    void super.storeClientOptions(options);
    this.markDirtyAndSchedulePersist();
    return Promise.resolve();
  }

  override save(force = false) {
    if (force) {
      return this.flush();
    }
    return Promise.resolve();
  }

  override wantsSave(): boolean {
    // We persist directly from setSyncData/storeClientOptions so the SDK's
    // periodic save hook stays disabled. Shutdown uses flush() for a final sync.
    return false;
  }

  override async deleteAllData(): Promise<void> {
    const store = this.requireStore();
    this.clearPersistTimer();
    this.dirty = false;
    await this.enqueuePersistence(async () => {
      await super.deleteAllData();
      this.savedSync = null;
      this.savedClientOptions = undefined;
      this.cleanShutdown = false;
      this.dirty = false;
      await deleteMatrixSyncCacheStateFromStore({
        storageRootDir: this.storageRootDir,
        store,
      });
    });
  }

  markCleanShutdown(): void {
    this.cleanShutdown = true;
    this.dirty = true;
  }

  async freezeSyncCursorPersistence(): Promise<void> {
    this.frozen = true;
    this.scheduler?.beginClose();
    this.clearPersistTimer();
    try {
      while (this.persistPromise) {
        await this.persistPromise;
      }
    } finally {
      await this.scheduler?.stop();
    }
  }

  discardPendingSyncCursorPersistence(): void {
    this.frozen = true;
    this.scheduler?.beginClose();
    this.clearPersistTimer();
    this.cleanShutdown = false;
    this.dirty = false;
  }

  async flush(): Promise<void> {
    this.clearPersistTimer();
    while (this.dirty || this.persistPromise) {
      if (this.dirty && !this.persistPromise) {
        void this.enqueuePersistence(() => this.persist());
      }
      await this.persistPromise;
    }
  }

  private clearPersistTimer(): void {
    this.persistJob?.cancel();
    this.persistJob = undefined;
  }

  private markDirtyAndSchedulePersist(): void {
    if (this.frozen) {
      return;
    }
    this.cleanShutdown = false;
    this.dirty = true;
    this.schedulePersist();
  }

  private schedulePersist(): void {
    // One-off clients and retiring services persist accepted state in their final flush.
    if (!this.scheduler || this.scheduler.signal.aborted || this.persistJob) {
      return;
    }
    this.persistJob = this.scheduler.schedule({
      id: "sync-store-persist",
      delayMs: PERSIST_DEBOUNCE_MS,
      run: () => {
        this.persistJob = undefined;
        return this.flush().catch((err: unknown) => {
          LogService.warn("MatrixSyncCacheStore", "Failed to persist Matrix sync store:", err);
        });
      },
    });
  }

  private async persist(): Promise<void> {
    const store = this.requireStore();
    this.dirty = false;
    const payload: PersistedMatrixSyncStore = {
      version: MATRIX_SYNC_CACHE_VERSION,
      savedSync: this.savedSync ? structuredClone(this.savedSync) : null,
      cleanShutdown: this.cleanShutdown,
      ...(this.savedClientOptions
        ? { clientOptions: structuredClone(this.savedClientOptions) }
        : {}),
    };
    try {
      await writeMatrixSyncCacheStateToStore({
        storageRootDir: this.storageRootDir,
        payload,
        store,
      });
      await claimCurrentTokenStorageState({ rootDir: this.storageRootDir });
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const pending = this.persistLock(operation).finally(() => {
      if (this.persistPromise === pending) {
        this.persistPromise = null;
      }
    });
    this.persistPromise = pending;
    return pending;
  }

  private requireStore(): PluginStateKeyedStore<MatrixSyncCacheRecord> {
    if (this.store && this.storeUnavailableError == null) {
      return this.store;
    }
    throw new Error("Matrix sync cache SQLite store is unavailable; cannot persist sync state", {
      cause: this.storeUnavailableError,
    });
  }
}
