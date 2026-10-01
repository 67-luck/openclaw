import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { createLegacyPluginServiceScheduler } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  registerSessionBindingAdapter,
  resolveThreadBindingFarewellText,
  resolveThreadBindingLifecycle,
  type SessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { getMatrixRuntime } from "../runtime.js";
import { claimCurrentTokenStorageState, resolveMatrixStoragePaths } from "./client/storage.js";
import type { MatrixAuth } from "./client/types.js";
import type { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";
import { resolveMatrixSqliteStateEnv, resolveMatrixSqliteStateKey } from "./sqlite-state.js";
import {
  deleteMatrixThreadBindingManagerEntry,
  getMatrixThreadBindingManager,
  getMatrixThreadBindingManagerEntry,
  listBindingsForAccount,
  removeBindingRecord,
  resolveBindingKey,
  setBindingRecord,
  setMatrixThreadBindingManagerEntry,
  toMatrixBindingTargetKind,
  toSessionBindingRecord,
  type MatrixThreadBindingManager,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";
import {
  buildThreadBindingStoreKey,
  openMatrixThreadBindingStoreOptions,
} from "./thread-bindings-store.js";

const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const TOUCH_PERSIST_DELAY_MS = 30_000;

function createThreadBindingStore(params: { env?: NodeJS.ProcessEnv; stateDir?: string }) {
  return getMatrixRuntime().state.openKeyedStore<MatrixThreadBindingRecord>(
    openMatrixThreadBindingStoreOptions(resolveMatrixSqliteStateEnv(params)),
  );
}

async function loadBindingsFromPluginState(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<MatrixThreadBindingRecord[]> {
  const store = createThreadBindingStore(params);
  return (await store.entries())
    .map((entry) => entry.value)
    .filter((record) => record.accountId === params.accountId);
}

function toPluginJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

async function persistBindingsSnapshot(params: {
  accountId: string;
  bindings: MatrixThreadBindingRecord[];
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<void> {
  const store = createThreadBindingStore(params);
  const liveKeys = new Set(params.bindings.map((record) => buildThreadBindingStoreKey(record)));
  for (const entry of await store.entries()) {
    if (entry.value.accountId === params.accountId && !liveKeys.has(entry.key)) {
      await store.delete(entry.key);
    }
  }
  for (const record of params.bindings) {
    await store.register(buildThreadBindingStoreKey(record), toPluginJsonValue(record));
  }
}

function buildMatrixBindingIntroText(params: {
  metadata?: Record<string, unknown>;
  targetSessionKey: string;
}): string {
  const introText = normalizeOptionalString(params.metadata?.introText);
  if (introText) {
    return introText;
  }
  const label = normalizeOptionalString(params.metadata?.label);
  const agentId =
    normalizeOptionalString(params.metadata?.agentId) ||
    resolveAgentIdFromSessionKey(params.targetSessionKey);
  const base = label || agentId || "session";
  return `⚙️ ${base} session active. Messages here go directly to this session.`;
}

async function sendBindingMessage(params: {
  cfg: OpenClawConfig;
  client: MatrixClient;
  accountId: string;
  roomId: string;
  threadId?: string;
  text: string;
}): Promise<string | null> {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return null;
  }
  const result = await sendMessageMatrix(`room:${params.roomId}`, trimmed, {
    cfg: params.cfg,
    client: params.client,
    accountId: params.accountId,
    ...(params.threadId ? { threadId: params.threadId } : {}),
  });
  return result.messageId || null;
}

async function sendFarewellMessage(params: {
  cfg: OpenClawConfig;
  client: MatrixClient;
  accountId: string;
  record: MatrixThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
  reason?: string;
}): Promise<void> {
  const roomId = params.record.parentConversationId ?? params.record.conversationId;
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? params.record.idleTimeoutMs
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number" ? params.record.maxAgeMs : params.defaultMaxAgeMs;
  const farewellText = resolveThreadBindingFarewellText({
    reason: params.reason,
    idleTimeoutMs,
    maxAgeMs,
  });
  await sendBindingMessage({
    cfg: params.cfg,
    client: params.client,
    accountId: params.accountId,
    roomId,
    threadId:
      params.record.parentConversationId &&
      params.record.parentConversationId !== params.record.conversationId
        ? params.record.conversationId
        : undefined,
    text: farewellText,
  }).catch(() => {});
}

export type MatrixThreadBindingManagerParams = {
  scheduler?: PluginServiceSchedulerV1;
  cfg: OpenClawConfig;
  accountId: string;
  auth: MatrixAuth;
  client: MatrixClient;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enableSweeper?: boolean;
  logVerboseMessage?: (message: string) => void;
};

export type MatrixThreadBindingManagerParamsV2 = MatrixThreadBindingManagerParams & {
  scheduler: PluginServiceSchedulerV1;
};

export async function createMatrixThreadBindingManager(
  params: MatrixThreadBindingManagerParams,
): Promise<MatrixThreadBindingManager> {
  if (params.auth.accountId !== params.accountId) {
    throw new Error(
      `Matrix thread binding account mismatch: requested ${params.accountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  const { rootDir: sqliteStateDir } = await resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    deviceId: params.auth.deviceId,
    accountId: params.accountId,
    env: params.env,
    stateDir: params.stateDir,
  });
  const storageKey = resolveMatrixSqliteStateKey({ env: params.env, stateDir: sqliteStateDir });
  const existingEntry = getMatrixThreadBindingManagerEntry(params.accountId);
  if (existingEntry) {
    if (existingEntry.storageKey === storageKey && !existingEntry.isRetiring()) {
      return existingEntry.manager;
    }
    await existingEntry.manager.stop();
  }
  const loaded = await loadBindingsFromPluginState({
    accountId: params.accountId,
    env: params.env,
    stateDir: sqliteStateDir,
  });
  for (const record of loaded) {
    setBindingRecord(record);
  }

  let persistPending = false;
  let finalBindings: MatrixThreadBindingRecord[] | undefined;
  let stopPromise: Promise<void> | undefined;
  const listLiveBindings = () =>
    finalBindings === undefined ? listBindingsForAccount(params.accountId) : [];
  let persistQueue: Promise<void> = Promise.resolve();
  const enqueuePersist = (bindings?: MatrixThreadBindingRecord[]) => {
    const snapshot = bindings ?? listBindingsForAccount(params.accountId);
    const next = persistQueue
      .catch(() => {})
      .then(async () => {
        await persistBindingsSnapshot({
          accountId: params.accountId,
          bindings: snapshot,
          env: params.env,
          stateDir: sqliteStateDir,
        });
        await claimCurrentTokenStorageState({ rootDir: sqliteStateDir });
      })
      .catch((error: unknown) => {
        persistPending = true;
        throw error;
      });
    persistQueue = next;
    return next;
  };
  const persist = async () => {
    if (finalBindings !== undefined) {
      throw new Error("Matrix thread binding manager has retired");
    }
    await enqueuePersist();
  };
  const persistSafely = (reason: string, bindings?: MatrixThreadBindingRecord[]) => {
    return enqueuePersist(bindings).catch((err: unknown) => {
      params.logVerboseMessage?.(
        `matrix: failed persisting thread bindings account=${params.accountId} action=${reason}: ${String(err)}`,
      );
    });
  };
  const defaults = {
    idleTimeoutMs: params.idleTimeoutMs,
    maxAgeMs: params.maxAgeMs,
  };
  const scheduler = params.scheduler?.scope() ?? createLegacyPluginServiceScheduler();
  const schedulePersist = (delayMs: number) => {
    persistPending = true;
    if (scheduler.signal.aborted) {
      return;
    }
    scheduler.schedule({
      id: "thread-binding-persist",
      delayMs,
      mode: "earliest",
      run: () => {
        persistPending = false;
        return persistSafely("delayed-touch");
      },
    });
  };
  const updateBindingsBySessionKey = (input: {
    targetSessionKey: string;
    update: (entry: MatrixThreadBindingRecord, now: number) => MatrixThreadBindingRecord;
    persistReason: string;
  }): MatrixThreadBindingRecord[] => {
    const targetSessionKey = input.targetSessionKey.trim();
    if (!targetSessionKey) {
      return [];
    }
    const now = Date.now();
    const nextBindings = listLiveBindings()
      .filter((entry) => entry.targetSessionKey === targetSessionKey)
      .map((entry) => input.update(entry, now));
    if (nextBindings.length === 0) {
      return [];
    }
    for (const entry of nextBindings) {
      setBindingRecord(entry);
    }
    void persistSafely(input.persistReason);
    return nextBindings;
  };

  const manager: MatrixThreadBindingManager = {
    accountId: params.accountId,
    getIdleTimeoutMs: () => defaults.idleTimeoutMs,
    getMaxAgeMs: () => defaults.maxAgeMs,
    persist,
    getByConversation: ({ conversationId, parentConversationId }) =>
      listLiveBindings().find((entry) => {
        if (entry.conversationId !== conversationId.trim()) {
          return false;
        }
        if (!parentConversationId) {
          return true;
        }
        return (entry.parentConversationId ?? "") === parentConversationId.trim();
      }),
    listBySessionKey: (targetSessionKey) =>
      listLiveBindings().filter((entry) => entry.targetSessionKey === targetSessionKey.trim()),
    listBindings: listLiveBindings,
    touchBinding: (bindingId, at) => {
      const record = listLiveBindings().find(
        (entry) => resolveBindingKey(entry) === bindingId.trim(),
      );
      if (!record) {
        return null;
      }
      const nextRecord = {
        ...record,
        lastActivityAt:
          typeof at === "number" && Number.isFinite(at)
            ? Math.max(record.lastActivityAt, Math.floor(at))
            : Date.now(),
      };
      setBindingRecord(nextRecord);
      schedulePersist(TOUCH_PERSIST_DELAY_MS);
      return nextRecord;
    },
    setIdleTimeoutBySessionKey: ({ targetSessionKey, idleTimeoutMs }) => {
      return updateBindingsBySessionKey({
        targetSessionKey,
        persistReason: "idle-timeout-update",
        update: (entry, now) => ({
          ...entry,
          idleTimeoutMs: Math.max(0, Math.floor(idleTimeoutMs)),
          lastActivityAt: now,
        }),
      });
    },
    setMaxAgeBySessionKey: ({ targetSessionKey, maxAgeMs }) => {
      return updateBindingsBySessionKey({
        targetSessionKey,
        persistReason: "max-age-update",
        update: (entry, now) => ({
          ...entry,
          maxAgeMs: Math.max(0, Math.floor(maxAgeMs)),
          lastActivityAt: now,
        }),
      });
    },
    stop: () => {
      if (!stopPromise) {
        scheduler.beginClose();
        stopPromise = (async () => {
          await scheduler.stop();
          let pending: Promise<void>;
          do {
            pending = persistQueue;
            await pending.catch(() => {});
          } while (pending !== persistQueue);
          if (finalBindings === undefined) {
            finalBindings = listBindingsForAccount(params.accountId);
            unregisterSessionBindingAdapter({
              channel: "matrix",
              accountId: params.accountId,
              adapter: sessionBindingAdapter,
            });
            for (const record of finalBindings) {
              removeBindingRecord(record);
            }
          }
          // Keep the final snapshot and cache custody until persistence succeeds;
          // replacement must join this retirement rather than load stale rows.
          if (persistPending) {
            await enqueuePersist(finalBindings);
            persistPending = false;
          }
          finalBindings = [];
          if (getMatrixThreadBindingManagerEntry(params.accountId)?.manager === manager) {
            deleteMatrixThreadBindingManagerEntry(params.accountId);
          }
        })().catch((error: unknown) => {
          stopPromise = undefined;
          throw error;
        });
      }
      return stopPromise;
    },
  };

  const removeRecords = (records: MatrixThreadBindingRecord[]) => {
    return records
      .map((record) => removeBindingRecord(record))
      .filter((record): record is MatrixThreadBindingRecord => Boolean(record));
  };
  const sendFarewellMessages = async (
    removed: MatrixThreadBindingRecord[],
    reason: string | ((record: MatrixThreadBindingRecord) => string | undefined),
  ) => {
    await Promise.all(
      removed.map(async (record) => {
        await sendFarewellMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          record,
          defaultIdleTimeoutMs: defaults.idleTimeoutMs,
          defaultMaxAgeMs: defaults.maxAgeMs,
          reason: typeof reason === "function" ? reason(record) : reason,
        });
      }),
    );
  };
  const unbindRecords = async (records: MatrixThreadBindingRecord[], reason: string) => {
    const removed = removeRecords(records);
    if (removed.length === 0) {
      return [];
    }
    await persist();
    await sendFarewellMessages(removed, reason);
    return removed.map((record) => toSessionBindingRecord(record, defaults));
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "matrix",
    accountId: params.accountId,
    capabilities: { placements: ["current", "child"], bindSupported: true, unbindSupported: true },
    bind: async (input) => {
      if (finalBindings !== undefined) {
        throw new Error("Matrix thread binding manager has retired");
      }
      const conversationId = input.conversation.conversationId.trim();
      const parentConversationId = normalizeOptionalString(input.conversation.parentConversationId);
      const targetSessionKey = input.targetSessionKey.trim();
      if (!conversationId || !targetSessionKey) {
        return null;
      }

      let boundConversationId = conversationId;
      let boundParentConversationId = parentConversationId;
      const introText = buildMatrixBindingIntroText({
        metadata: input.metadata,
        targetSessionKey,
      });

      if (input.placement === "child") {
        const roomId = parentConversationId || conversationId;
        const rootEventId = await sendBindingMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          roomId,
          text: introText,
        });
        if (!rootEventId) {
          return null;
        }
        boundConversationId = rootEventId;
        boundParentConversationId = roomId;
      }

      if (finalBindings !== undefined) {
        throw new Error("Matrix thread binding manager has retired");
      }
      const now = Date.now();
      const record: MatrixThreadBindingRecord = {
        accountId: params.accountId,
        conversationId: boundConversationId,
        ...(boundParentConversationId ? { parentConversationId: boundParentConversationId } : {}),
        targetKind: toMatrixBindingTargetKind(input.targetKind),
        targetSessionKey,
        agentId:
          normalizeOptionalString(input.metadata?.agentId) ??
          resolveSessionAgentIdStrict({ config: params.cfg, sessionKey: targetSessionKey }),
        label: normalizeOptionalString(input.metadata?.label) || undefined,
        boundBy: normalizeOptionalString(input.metadata?.boundBy) || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs: defaults.idleTimeoutMs,
        maxAgeMs: defaults.maxAgeMs,
      };
      setBindingRecord(record);
      await persist();

      if (input.placement === "current" && introText) {
        const roomId = boundParentConversationId || boundConversationId;
        const threadId =
          boundParentConversationId && boundParentConversationId !== boundConversationId
            ? boundConversationId
            : undefined;
        await sendBindingMessage({
          cfg: params.cfg,
          client: params.client,
          accountId: params.accountId,
          roomId,
          threadId,
          text: introText,
        }).catch(() => {});
      }

      return toSessionBindingRecord(record, defaults);
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((record) => toSessionBindingRecord(record, defaults)),
    resolveByConversation: (ref) => {
      const record = manager.getByConversation({
        conversationId: ref.conversationId,
        parentConversationId: ref.parentConversationId,
      });
      return record ? toSessionBindingRecord(record, defaults) : null;
    },
    touch: (bindingId, at) => {
      manager.touchBinding(bindingId, at);
    },
    unbind: async (input) => {
      const removed = await unbindRecords(
        listLiveBindings().filter((record) => {
          if (input.bindingId?.trim()) {
            return resolveBindingKey(record) === input.bindingId.trim();
          }
          if (input.targetSessionKey?.trim()) {
            return record.targetSessionKey === input.targetSessionKey.trim();
          }
          return false;
        }),
        input.reason,
      );
      return removed;
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  if (params.enableSweeper !== false) {
    scheduler.schedule({
      id: "thread-binding-sweep",
      delayMs: THREAD_BINDINGS_SWEEP_INTERVAL_MS,
      everyMs: THREAD_BINDINGS_SWEEP_INTERVAL_MS,
      run: () => {
        const now = Date.now();
        const expired = listBindingsForAccount(params.accountId)
          .map((record) => ({
            record,
            lifecycle: resolveThreadBindingLifecycle({
              record,
              defaultIdleTimeoutMs: defaults.idleTimeoutMs,
              defaultMaxAgeMs: defaults.maxAgeMs,
            }),
          }))
          .filter(
            (
              entry,
            ): entry is {
              record: MatrixThreadBindingRecord;
              lifecycle: { expiresAt: number; reason: "idle-expired" | "max-age-expired" };
            } =>
              typeof entry.lifecycle.expiresAt === "number" &&
              entry.lifecycle.expiresAt <= now &&
              Boolean(entry.lifecycle.reason),
          );
        if (expired.length === 0) {
          return;
        }
        const reasonByBindingKey = new Map(
          expired.map(({ record, lifecycle }) => [resolveBindingKey(record), lifecycle.reason]),
        );
        return (async () => {
          const removed = removeRecords(expired.map(({ record }) => record));
          if (removed.length === 0) {
            return;
          }
          for (const record of removed) {
            const reason = reasonByBindingKey.get(resolveBindingKey(record));
            params.logVerboseMessage?.(
              `matrix: auto-unbinding ${record.conversationId} due to ${reason}`,
            );
          }
          await persist();
          await sendFarewellMessages(removed, (record) =>
            reasonByBindingKey.get(resolveBindingKey(record)),
          );
        })().catch((err: unknown) => {
          params.logVerboseMessage?.(
            `matrix: failed auto-unbinding expired bindings account=${params.accountId}: ${String(err)}`,
          );
        });
      },
    });
  }

  setMatrixThreadBindingManagerEntry(params.accountId, {
    storageKey,
    manager,
    isRetiring: () => stopPromise !== undefined || finalBindings !== undefined,
  });
  return manager;
}
export { getMatrixThreadBindingManager };
