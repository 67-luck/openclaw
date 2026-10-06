import { err, ok } from "@openclaw/normalization-core/result";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import {
  resolveSessionStoreIdentity,
  selectStoredSessionLineage,
} from "../../gateway/session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "../../gateway/session-utils-store-candidates.js";
import { createGatewaySessionLineageReader } from "../../gateway/session-utils-store-lineage.js";
import { prepareGatewaySessionStoreTargetLookup } from "../../gateway/session-utils-store-lookup.js";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../../sessions/session-row-facts.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "./session-store-target-runtime.js";
import type { SessionEntry } from "./types.js";

type LineageReader = ReturnType<typeof createGatewaySessionLineageReader>;
type Row = {
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
};

/** Native SDK writes can bypass the worker FIFO; retain their witness before reading. */
export function retainSessionLineageReadSource(
  database: { agentId: string; path: string },
  keys?: readonly string[],
  assertSourceCurrent: () => void = () => {},
) {
  const native = getOpenClawAgentDatabaseIfOpen(database);
  const revision = native && readSqliteNativeMutationRevision(native.db);
  const publication = prepareSessionRowPublicationScope([database.path]);
  let changed = false;
  let active = true;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    changed ||= sessionChangeAffectsStoredRow(change, {
      ...publication,
      agentId: database.agentId,
      sessionKeys: keys ?? ("all" in change ? [] : [change.sessionKey]),
    });
  });
  return {
    release() {
      active = false;
      unsubscribe();
    },
    assertCurrent() {
      assertSourceCurrent();
      if (
        !active ||
        changed ||
        getOpenClawAgentDatabaseIfOpen(database) !== native ||
        (native &&
          (native.db.isTransaction || readSqliteNativeMutationRevision(native.db) !== revision))
      ) {
        throw new Error("Session lineage changed while preparing the listing");
      }
    },
  };
}

/** Acquire only selected foreign ancestors; every reader stays held through the final merge. */
export async function withCombinedSessionLineage<T>(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  rows: readonly Row[],
  preparedAgentIds: ReadonlySet<string> | undefined,
  requestedAgentId: string | undefined,
  consume: (reader?: LineageReader) => T,
): Promise<T> {
  if (!preparedAgentIds) {
    return consume();
  }
  const complete = new Set([...preparedAgentIds, ...rows.map((row) => row.agentId)]);
  const keyFor = (agentId: string, key: string) => `${normalizeAgentId(agentId)}\0${key}`;
  const stored = new Map<string, SessionEntry | undefined>(
    rows.map((row) => [keyFor(row.agentId, row.sessionKey), row.entry]),
  );
  const aliases = new Map<string, SessionEntry | undefined>();
  const discovery: GatewaySessionStoreDiscoveryCache = new Map();
  const sources: Array<ReturnType<typeof retainSessionLineageReadSource>> = [];
  const assertions: Array<() => void> = [];
  const queue: Array<{ agentId: string; key: string }> = [];
  const visited = new Set<string>();
  let nextIndex = 0;
  const enqueue = (agentId: string, sessionKey: string, entry: SessionEntry) => {
    for (const key of [
      entry.parentSessionKey,
      entry.spawnedBy,
      resolveSessionParentSessionKey(sessionKey),
    ]) {
      if (key && parseAgentSessionKey(key) && !isIncognitoSessionKey(key)) {
        queue.push({ agentId, key });
      }
    }
  };
  for (const row of rows) {
    if (!requestedAgentId || normalizeAgentId(row.agentId) === requestedAgentId) {
      enqueue(row.agentId, row.sessionKey, row.entry);
    }
  }
  const assertCurrent = () => {
    assertions.forEach((assert) => assert());
    sources.forEach((source) => source.assertCurrent());
  };
  const native = createGatewaySessionLineageReader(cfg);
  const reader: LineageReader = {
    readStored: (agentId, key) =>
      isIncognitoSessionKey(key)
        ? native.readStored(agentId, key)
        : stored.get(keyFor(agentId, key)),
    readAlias: (key, agentId) =>
      isIncognitoSessionKey(key)
        ? native.readAlias(key, agentId)
        : aliases.get(keyFor(agentId, key)),
  };
  const visit = async (): Promise<T> => {
    for (;;) {
      const next = queue[nextIndex++];
      if (!next) {
        assertCurrent();
        return consume(reader);
      }
      const owner = normalizeAgentId(parseAgentSessionKey(next.key)!.agentId);
      const identity = keyFor(next.agentId, next.key);
      if (visited.has(identity) || readAgentDatabaseAdmissionRefusal(owner, { env })) {
        continue;
      }
      visited.add(identity);
      const available = stored.get(keyFor(owner, next.key));
      if (available) {
        enqueue(next.agentId, next.key, available);
        continue;
      }
      if (complete.has(owner)) {
        const selected = selectStoredSessionLineage({
          cfg,
          agentId: owner,
          sessionKey: next.key,
          read: (agentId, key) => stored.get(keyFor(agentId, key)),
        });
        if (selected.value) {
          enqueue(next.agentId, selected.key, selected.value);
        }
        continue;
      }
      const select = async (preserveQualifiedAddress: boolean): Promise<T> => {
        let aliasOwner: string | undefined;
        if (!preserveQualifiedAddress) {
          try {
            aliasOwner = resolveSessionStoreIdentity({ cfg, sessionKey: next.key }).agentId;
          } catch {
            // The original selector orders a retained deleted-main match before this error.
          }
        }
        const missingOwners = [owner, ...(aliasOwner ? [aliasOwner] : [])].filter(
          (agentId) => !discovery.has(agentId),
        );
        const withDiscovery = async (): Promise<T> => {
          const plan = prepareGatewaySessionStoreTargetLookup({
            cfg,
            key: next.key,
            env,
            readOnly: true,
            exactRead: true,
            projection: "list",
            preserveQualifiedAddress,
            targetDiscoveryCache: discovery,
          });
          const read = async (index: number): Promise<T> => {
            const pending = plan.reads[index];
            if (!pending) {
              assertCurrent();
              const target = plan.resolve();
              const entry = target.store[target.canonicalKey];
              if (preserveQualifiedAddress) {
                stored.set(keyFor(owner, next.key), entry);
                if (!entry) {
                  return select(false);
                }
              } else {
                aliases.set(identity, entry);
              }
              if (entry) {
                stored.set(keyFor(target.agentId, target.canonicalKey), entry);
                enqueue(next.agentId, target.canonicalKey, entry);
              }
              return visit();
            }
            const publication = prepareSessionRowPublicationScope([pending.storePath]);
            let entered = false;
            return withSessionStoreReaderInWorker(
              { agentId: pending.agentId ?? owner, storePath: pending.storePath, env },
              async (source) => {
                entered = true;
                const witness = retainSessionLineageReadSource(
                  source.database,
                  pending.options.exactKeys ?? [],
                  source.assertCurrent,
                );
                sources.push(witness);
                try {
                  try {
                    const result = await source.reader.readExactEntries({
                      sessionKeys: pending.options.exactKeys ?? [],
                      projection: "exact",
                      snapshotFields: [],
                      env: source.database.env,
                    });
                    pending.result = ok(
                      Object.fromEntries(
                        result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
                      ),
                    );
                    pending.readSource = source.database;
                    pending.capturedReadSource = result.source;
                  } catch (error) {
                    pending.result = err(error);
                  }
                  assertCurrent();
                  return await read(index + 1);
                } finally {
                  sources.pop();
                  witness.release();
                }
              },
              { prepareSource: publication.prepareSource },
            ).catch((error: unknown) => {
              if (entered) {
                throw error;
              }
              pending.result = err(error);
              return read(index + 1);
            });
          };
          return read(0);
        };
        if (!missingOwners.length) {
          return withDiscovery();
        }
        const inventory = prepareSessionStoreTargetInventory(cfg, missingOwners, env);
        return prepareSessionStoreTargetInventoryRead(inventory).withRead(
          async (result, assert) => {
            for (const source of result.agents) {
              if (!source.result.available && source.result.reason !== "database-missing") {
                throw new Error(`Session parent stores for ${source.agentId} are unavailable`);
              }
              discovery.set(source.agentId, {
                existing: source.result.available ? source.result.targets : [],
                fallback: {
                  agentId: source.agentId,
                  storePath: inventory.paths.get(source.agentId)!.configured,
                },
              });
            }
            assertions.push(assert);
            try {
              return await withDiscovery();
            } finally {
              assertions.pop();
            }
          },
        );
      };
      return select(!stored.has(keyFor(owner, next.key)));
    }
  };
  return visit();
}
