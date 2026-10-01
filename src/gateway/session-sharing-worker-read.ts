import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { ok } from "@openclaw/normalization-core/result";
import {
  projectSessionSharingEntry,
  readExactSessionEntryCandidatesInDatabase,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "../config/sessions/session-canonical-key.js";
import { readExactSessionEntriesWithLifecycle } from "../config/sessions/session-entry-read.worker.js";
import { listSessionMembersInDatabase } from "../config/sessions/session-sharing-store.kernel.js";
import {
  assertSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import {
  readSessionStoreTargetInventory,
  readSessionStoreTargetResult,
  type SessionStoreTargetInventoryRequest,
} from "../config/sessions/session-store-target-inventory.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { SessionMutationFactsUnavailableError } from "./session-mutation-authorization-error.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";

export type ExistingSessionMutationFacts = PreparedSessionMutationFacts & {
  /** Physical source retained by the same read custody as the sharing facts. */
  sourcePath?: string;
  target: NonNullable<PreparedSessionMutationFacts["target"]>;
};

export type SessionMutationWorkerRead = {
  expected: {
    agentId: string;
    canonicalKey: string;
    storeKey: string;
    storePath: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
} & (
  | {
      kind: "durable";
      inventory: SessionStoreTargetInventoryRequest;
      sessionKey: string;
      agentId: string;
      candidates: Array<{ candidate: SessionStoreReadCandidate; identity: DatabasePathIdentity }>;
      sources: Array<{ path: string; identity: string }>;
    }
  | {
      kind: "volatile";
      source: { agentId: string; path: string; incarnation: string };
    }
);

/** Called by the physical commit guard, after the final host grant has returned. */
export function readSessionMutationFactsInWorker(
  database: OpenClawAgentDatabase,
  input: SessionMutationWorkerRead,
): ExistingSessionMutationFacts {
  if (isMainThread) {
    throw new Error("Session mutation source validation requires its database worker");
  }
  if (input.kind === "volatile") {
    const expected = input.expected;
    if (
      database.agentId !== input.source.agentId ||
      database.path !== input.source.path ||
      database.path !== expected.storePath ||
      readOpenClawAgentDatabaseIdentity(database).incarnation !== input.source.incarnation
    ) {
      throw new SessionMutationFactsUnavailableError();
    }
    assertCanonicalSqliteSessionKeysCurrent(database);
    const selected = readExactSessionEntryCandidatesInDatabase(
      database,
      [[expected.storeKey]],
      "list",
    )[0];
    const entry = selected?.ok ? selected.value[0]?.entry : undefined;
    if (
      !entry ||
      entry.sessionId !== expected.sessionId ||
      entry.lifecycleRevision !== expected.lifecycleRevision
    ) {
      throw new SessionMutationFactsUnavailableError();
    }
    return {
      target: {
        ...expected,
        storeKeys: [expected.storeKey],
        entry: projectSessionSharingEntry(entry),
      },
      membership: new Set(
        listSessionMembersInDatabase(database, expected.storeKey).map(
          (member) => member.identityId,
        ),
      ),
    };
  }
  const assertSources = () => {
    for (const { candidate, identity } of input.candidates) {
      assertSessionStoreReadCandidate(candidate.path, [candidate]);
      if (!isDeepStrictEqual(readDatabasePathIdentitySync(candidate.path), identity)) {
        throw new SessionMutationFactsUnavailableError();
      }
    }
    for (const source of input.sources) {
      if (readDatabasePathIdentitySync(source.path).key !== source.identity) {
        throw new SessionMutationFactsUnavailableError();
      }
    }
  };
  assertSources();
  const inventory = readSessionStoreTargetInventory(input.inventory);
  if (inventory.kind !== "session-target-inventory") {
    throw new SessionMutationFactsUnavailableError();
  }
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  for (const source of inventory.agents) {
    if (!source.result.available && source.result.reason !== "database-missing") {
      throw new SessionMutationFactsUnavailableError();
    }
    const paths = input.inventory.paths.get(source.agentId);
    if (!paths) {
      throw new SessionMutationFactsUnavailableError();
    }
    targetDiscoveryCache.set(source.agentId, {
      existing: source.result.available ? source.result.targets : [],
      fallback: { agentId: source.agentId, storePath: paths.configured },
    });
  }
  const selected = resolveGatewaySessionStoreTargetWithStore(
    {
      cfg: input.inventory.config,
      key: input.sessionKey,
      agentId: input.agentId,
      env: input.inventory.env,
      targetDiscoveryCache,
      exactRead: true,
      readOnly: true,
      projection: "list",
    },
    (reads) => {
      for (const read of reads) {
        const result = readSessionStoreTargetResult({
          agentId: read.agentId ?? input.agentId,
          storePath: read.storePath,
          env: input.inventory.env,
          candidates: input.inventory.candidates,
          registeredDatabases: input.inventory.registeredDatabases,
        });
        if (!result.ok) {
          throw result.error;
        }
        const target = result.value;
        const keys = read.options.exactKeys;
        if (target.kind !== "session-store-target" || !keys) {
          throw new SessionMutationFactsUnavailableError();
        }
        let entries;
        if (
          target.database.path === database.path &&
          target.database.agentId === database.agentId
        ) {
          assertCanonicalSqliteSessionKeysCurrent(database);
          const rowResult = readExactSessionEntryCandidatesInDatabase(database, [keys], "list")[0];
          if (!rowResult) {
            throw new SessionMutationFactsUnavailableError();
          }
          if (!rowResult.ok) {
            throw rowResult.error;
          }
          entries = rowResult.value;
        } else {
          // Independent stores must be read again, even when their inode and the
          // host's tracked facts are unchanged. Unreported duplicates still refuse.
          entries = readExactSessionEntriesWithLifecycle({
            kind: "session-exact-entries",
            database: target.database,
            sessionKeys: keys,
            projection: "sharing",
            env: input.inventory.env,
          }).entries;
        }
        read.readSource = target.database;
        read.result = ok(
          Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
        );
      }
    },
  );
  const match = findCanonicalStoreMatch(selected.store, selected.storeKeys);
  const expected = input.expected;
  if (
    !match ||
    selected.agentId !== expected.agentId ||
    selected.canonicalKey !== expected.canonicalKey ||
    selected.storePath !== expected.storePath ||
    selected.readSource?.path !== database.path ||
    match.key !== expected.storeKey ||
    match.entry.sessionId !== expected.sessionId ||
    match.entry.lifecycleRevision !== expected.lifecycleRevision
  ) {
    throw new SessionMutationFactsUnavailableError();
  }
  assertSources();
  return {
    target: {
      agentId: selected.agentId,
      canonicalKey: selected.canonicalKey,
      storePath: selected.storePath,
      storeKeys: selected.storeKeys,
      storeKey: match.key,
      entry: projectSessionSharingEntry(match.entry),
    },
    membership: new Set(
      listSessionMembersInDatabase(database, match.key).map((member) => member.identityId),
    ),
  };
}
