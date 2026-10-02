import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { SessionMutationFactsUnavailableError } from "./session-mutation-authorization-error.js";

function routeFacts(cfg: OpenClawConfig) {
  return {
    agents: listAgentIds(cfg),
    store: cfg.session?.store,
    mainKey: cfg.session?.mainKey,
    scope: cfg.session?.scope,
  };
}

export function captureSessionMutationRouting(cfg: OpenClawConfig) {
  const route = routeFacts(cfg);
  return (current: OpenClawConfig) => {
    if (!isDeepStrictEqual(routeFacts(current), route)) {
      throw new SessionMutationFactsUnavailableError();
    }
  };
}

export function assertSessionSharingSourcesCurrent(
  candidates: readonly { candidate: SessionStoreReadCandidate; identity: DatabasePathIdentity }[],
  reads: Iterable<{ source: { path: string }; databaseIdentity: string }>,
) {
  for (const { candidate, identity } of candidates) {
    if (
      captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
        candidate.physicalPath ||
      !isDeepStrictEqual(readDatabasePathIdentitySync(candidate.path), identity)
    ) {
      throw new SessionMutationFactsUnavailableError();
    }
  }
  for (const read of reads) {
    if (readDatabasePathIdentitySync(read.source.path).key !== read.databaseIdentity) {
      throw new SessionMutationFactsUnavailableError();
    }
  }
}
