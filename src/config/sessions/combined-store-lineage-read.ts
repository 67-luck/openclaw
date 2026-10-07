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
import { captureSessionStoreCandidateIdentities } from "./session-store-read-candidates.js";
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
  target = { agentId: database.agentId, storePath: database.path },
) {
  const native = getOpenClawAgentDatabaseIfOpen(database);
  const revision = native && readSqliteNativeMutationRevision(native.db);
  const publication = prepareSessionRowPublicationScope([database.path, target.storePath]);
  let changed = false;
  let active = true;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    changed ||= sessionChangeAffectsStoredRow(change, {
      ...publication,
      agentId: target.agentId,
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
  // Captured private rows do not prove that their owner's durable inventory is complete.
  const complete = new Set([
    ...preparedAgentIds,
    ...rows.filter((row) => !isIncognitoSessionKey(row.sessionKey)).map((row) => row.agentId),
  ]);
  const keyFor = (agentId: string, key: string) => `${normalizeAgentId(agentId)}\0${key}`;
  const stored = new Map<string, SessionEntry | undefined>(
    rows.map((row) => [keyFor(row.agentId, row.sessionKey), row.entry]),
  );
  const aliases = new Map<string, SessionEntry | undefined>();
  const discovery: GatewaySessionStoreDiscoveryCache = new Map();
  const preparedSources = new Map<
    string,
    NonNullable<Parameters<typeof withSessionStoreReaderInWorker>[0]["preparedSource"]>
  >();
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
      const parsed = key ? parseAgentSessionKey(key) : undefined;
      if (
        key &&
        parsed &&
        (!isIncognitoSessionKey(key) || stored.has(keyFor(parsed.agentId, key)))
      ) {
        queue.push({ agentId, key });
      }
    }
  };
  for (const row of rows) {
    if (!requestedAgentId || normalizeAgentId(row.agentId) === requestedAgentId) {
      enqueue(row.agentId, row.sessionKey, row.entry);
    }
  }
  const assertCurrent = () => assertions.forEach((assert) => assert());
  const native = createGatewaySessionLineageReader(cfg);
  const reader: LineageReader = {
    readStored(agentId, key) {
      if (!isIncognitoSessionKey(key)) {
        return stored.get(keyFor(agentId, key));
      }
      const identity = keyFor(parseAgentSessionKey(key)?.agentId ?? agentId, key);
      return stored.has(identity) ? stored.get(identity) : native.readStored(agentId, key);
    },
    readAlias(key, agentId) {
      if (!isIncognitoSessionKey(key)) {
        return aliases.get(keyFor(agentId, key));
      }
      const identity = keyFor(parseAgentSessionKey(key)?.agentId ?? agentId, key);
      return stored.has(identity) ? stored.get(identity) : native.readAlias(key, agentId);
    },
  };
  const visit = async (): Promise<T> => {
    for (;;) {
      const next = queue[nextIndex];
      if (!next) {
        assertCurrent();
        return consume(reader);
      }
      const owner = normalizeAgentId(parseAgentSessionKey(next.key)!.agentId);
      const identity = keyFor(next.agentId, next.key);
      if (visited.has(identity) || readAgentDatabaseAdmissionRefusal(owner, { env })) {
        nextIndex++;
        continue;
      }
      const selected = complete.has(owner)
        ? selectStoredSessionLineage({
            cfg,
            agentId: owner,
            sessionKey: next.key,
            read: (agentId, key) => stored.get(keyFor(agentId, key)),
          })
        : { key: next.key, value: stored.get(keyFor(owner, next.key)) };
      if (selected.value || complete.has(owner)) {
        visited.add(identity);
        nextIndex++;
        if (selected.value) {
          enqueue(next.agentId, selected.key, selected.value);
        }
        continue;
      }
      const preserveQualifiedAddress = !stored.has(keyFor(owner, next.key));
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
      if (missingOwners.length) {
        const inventory = prepareSessionStoreTargetInventory(cfg, missingOwners, env);
        const identities = captureSessionStoreCandidateIdentities(inventory.candidates);
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
              for (const { target, database } of source.reads) {
                const captured = identities.get(database.path);
                if (captured?.key.startsWith("file:")) {
                  preparedSources.set(keyFor(source.agentId, target.storePath), {
                    ...database,
                    databaseIdentity: captured.key.slice(5),
                    databaseBirthtime: captured.birthtime,
                    assertCurrent: assert,
                  });
                }
              }
            }
            assertions.push(assert);
            try {
              return await visit();
            } finally {
              assertions.pop();
            }
          },
        );
      }
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
              return visit();
            }
          } else {
            aliases.set(identity, entry);
          }
          visited.add(identity);
          nextIndex++;
          if (entry) {
            stored.set(keyFor(target.agentId, target.canonicalKey), entry);
            enqueue(next.agentId, target.canonicalKey, entry);
          }
          return visit();
        }
        const publication = prepareSessionRowPublicationScope([pending.storePath]);
        let entered = false;
        return withSessionStoreReaderInWorker(
          {
            agentId: pending.agentId ?? owner,
            storePath: pending.storePath,
            env,
            preparedSource: preparedSources.get(
              keyFor(pending.agentId ?? owner, pending.storePath),
            ),
          },
          async (source) => {
            entered = true;
            const witness = retainSessionLineageReadSource(
              source.database,
              pending.options.exactKeys ?? [],
              source.assertCurrent,
            );
            assertions.push(() => witness.assertCurrent());
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
              assertions.pop();
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
    }
  };
  return visit();
}
