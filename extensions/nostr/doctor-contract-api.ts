import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  defineLegacyJsonStateMigration,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asFiniteNumber, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeNostrStateAccountId } from "./src/state-account-id.js";

const MAX_STATE_ENTRIES = 256;

function parseBusState(value: unknown) {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    throw new Error("Expected Nostr bus state version 1 or 2");
  }
  return {
    version: 2,
    lastProcessedAt: asFiniteNumber(value.lastProcessedAt) ?? null,
    gatewayStartedAt: asFiniteNumber(value.gatewayStartedAt) ?? null,
    recentEventIds:
      value.version === 2 && Array.isArray(value.recentEventIds)
        ? value.recentEventIds.filter((entry): entry is string => typeof entry === "string")
        : [],
  };
}

function parseProfileState(value: unknown) {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Expected Nostr profile state version 1");
  }
  const results = isRecord(value.lastPublishResults)
    ? Object.fromEntries(
        Object.entries(value.lastPublishResults).filter(
          ([, result]) => result === "ok" || result === "failed" || result === "timeout",
        ),
      )
    : {};
  return {
    version: 1,
    lastPublishedAt: asFiniteNumber(value.lastPublishedAt) ?? null,
    lastPublishedEventId:
      typeof value.lastPublishedEventId === "string" ? value.lastPublishedEventId : null,
    lastPublishResults: Object.keys(results).length > 0 ? results : null,
  };
}

async function listSources(stateDir: string, namespace: string): Promise<string[]> {
  const root = path.join(stateDir, "nostr");
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith(`${namespace}-`) && entry.name.endsWith(".json"),
      )
      .map((entry) => path.join(root, entry.name))
      .toSorted();
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function stateDatabaseResource(stateDir: string) {
  return { path: path.join(stateDir, "state", "openclaw.sqlite"), kind: "sqlite" as const };
}

function jsonStateMigration<T>(namespace: string, label: string, parse: (value: unknown) => T) {
  const migration: PluginDoctorStateMigration = {
    id: `nostr-${namespace}-json-to-plugin-state`,
    label,
    async collectBackupResources({ stateDir }) {
      return [
        ...(await listSources(stateDir, namespace)).map((source) => ({
          path: source,
          kind: "file" as const,
        })),
        stateDatabaseResource(stateDir),
      ];
    },
    async detectLegacyState({ stateDir }) {
      const sources = await listSources(stateDir, namespace);
      return sources.length > 0
        ? { preview: sources.map((source) => `${label} JSON can migrate to SQLite: ${source}`) }
        : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const filePath of await listSources(params.stateDir, namespace)) {
        const accountId = normalizeNostrStateAccountId(
          path.basename(filePath).slice(namespace.length + 1, -".json".length),
        );
        try {
          const result = await defineLegacyJsonStateMigration({
            id: migration.id,
            label,
            namespace,
            maxEntries: MAX_STATE_ENTRIES,
            overflowPolicy: "reject-new",
            resolvePath: () => filePath,
            parse,
            toRows: (value) => [{ key: accountId, value }],
            describeEntries: () => ({
              preview: [`${label}: ${accountId}`],
              change: ({ imported }) =>
                imported > 0 ? `Migrated ${label} for ${accountId} to SQLite` : null,
            }),
          }).migrateLegacyState(params);
          changes.push(...result.changes);
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(
            `Failed migrating ${label} ${filePath}: ${String(error)}; left source in place. Run openclaw doctor --fix after resolving the failure.`,
          );
        }
      }
      return { changes, warnings };
    },
  };
  return migration;
}

function hasRecentEventIds(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.hasOwn(value, "recentEventIds") &&
    (!Array.isArray(value.recentEventIds) || value.recentEventIds.length > 0)
  );
}

const replaySeedMigration: PluginDoctorStateMigration = {
  id: "nostr-recent-event-ids-to-ingress",
  label: "Nostr replay event IDs",
  async collectBackupResources({ stateDir }) {
    return [stateDatabaseResource(stateDir)];
  },
  async detectLegacyState({ context, env, stateDir }) {
    const store = context.openPluginStateKeyedStore<unknown>({
      namespace: "bus-state",
      maxEntries: MAX_STATE_ENTRIES,
      env,
    });
    const accounts = (await store.entries()).filter((entry) => hasRecentEventIds(entry.value));
    const sources = await listSources(stateDir, "bus-state");
    return accounts.length > 0 || sources.length > 0
      ? { preview: ["Nostr replay event IDs can migrate to durable ingress"] }
      : null;
  },
  async migrateLegacyState({ context, env }) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const store = context.openPluginStateKeyedStore<unknown>({
      namespace: "bus-state",
      maxEntries: MAX_STATE_ENTRIES,
      env,
    });
    const access = context.channelIngressQueues?.find((entry) => entry.channelId === "nostr");
    for (const entry of await store.entries()) {
      if (!hasRecentEventIds(entry.value)) {
        continue;
      }
      try {
        if (!store.observe || !store.compareAndApply) {
          throw new Error("Nostr replay migration requires guarded plugin-state writes");
        }
        const observed = await store.observe(entry.key);
        const state = observed.value;
        if (!hasRecentEventIds(state)) {
          continue;
        }
        if (
          !Array.isArray(state.recentEventIds) ||
          state.recentEventIds.some((id) => typeof id !== "string")
        ) {
          throw new Error("Expected an array of Nostr replay event IDs");
        }
        if (!access?.openChannelIngressQueue) {
          throw new Error("Nostr ingress migration requires Doctor maintenance ownership");
        }
        const queue = access.openChannelIngressQueue<{
          version: 1;
          receivedAt: number;
          rawEvent: string;
        }>({
          accountId: entry.key,
        });
        const migratedAt = Date.now();
        const ids = new Set(
          state.recentEventIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          ),
        );
        for (const eventId of ids) {
          const result = await queue.enqueue(
            eventId,
            { version: 1, receivedAt: migratedAt, rawEvent: "" },
            { receivedAt: migratedAt, laneKey: `legacy:${eventId}` },
          );
          if (
            result.kind === "accepted" ||
            (result.kind === "pending" &&
              result.record.laneKey === `legacy:${eventId}` &&
              result.record.payload.version === 1 &&
              result.record.payload.rawEvent === "")
          ) {
            if (!(await queue.complete(eventId, { completedAt: migratedAt }))) {
              throw new Error(`Failed completing Nostr replay event ${eventId}`);
            }
          }
        }
        const cleared = await store.compareAndApply(entry.key, observed.comparison, {
          operation: "update",
          action: "set",
          value: { ...state, recentEventIds: [] },
        });
        if (cleared.status === "conflict") {
          throw new Error("Nostr bus state changed during migration; retained its replay seed");
        }
        changes.push(
          `Migrated ${ids.size} Nostr replay event IDs for ${entry.key} to durable ingress`,
        );
      } catch (error) {
        warnings.push(
          `Failed migrating Nostr replay event IDs for ${entry.key}: ${String(error)}. Run openclaw doctor --fix after resolving the failure.`,
        );
      }
    }
    return { changes, warnings };
  },
};

export const stateMigrations: PluginDoctorStateMigration[] = [
  jsonStateMigration("bus-state", "Nostr bus state", parseBusState),
  jsonStateMigration("profile-state", "Nostr profile state", parseProfileState),
  replaySeedMigration,
];
