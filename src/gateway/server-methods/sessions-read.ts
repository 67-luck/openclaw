import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsListParams,
  validateSessionsPreviewParams,
  validateSessionsResolveParams,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import type { SessionEntrySummary } from "../../config/sessions/session-accessor.types.js";
import { SessionTranscriptColdError } from "../../config/sessions/session-cold-storage-state.js";
import { withSessionStoreReaderInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { prepareSessionStoreTargetInventory } from "../../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../../config/sessions/session-store-target-runtime.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
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
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { errorShapeFromError } from "../error-shape.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withReadySessionRows, type SessionRowReadView } from "../session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import type { MaterializedRow } from "../session-row-projection-record.js";
import {
  canAccessIncognitoSession,
  createSessionListEntryFilter,
  isGatewayAdmin,
} from "../session-sharing.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "../session-transcript-preview.js";
import {
  listProjectedSessions,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { withPreparedSessionResolve } from "../sessions-resolve.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { createPreparedReadHandler } from "./prepared-read.js";
import { startSessionListDiagnostics } from "./sessions-list-diagnostics.js";
import { sessionMaintenanceHandlers } from "./sessions-maintenance.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import { searchProjectedSessionTranscripts } from "./sessions-search-projected.js";
import { resolveSessionSearchScope } from "./sessions-search-scope.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type SearchStoreSource = Parameters<Parameters<typeof withSessionStoreReaderInWorker>[1]>[0];
type SearchStore = {
  target: { agentId: string; storePath: string };
  source: SearchStoreSource;
  identity: string;
};
type PreparedSearchRequest = {
  agentId: string;
  storePath: string;
  query: string;
  limit?: number;
  sessionKeys?: string[];
  database: { agentId: string; path: string };
  identity: string;
};

/** Keep selected physical readers alive through synchronous response publication. */
async function withSessionSearchStores<T>(
  cfg: OpenClawConfig,
  agentId: string,
  configured: boolean,
  consume: (stores: SearchStore[]) => Promise<T>,
): Promise<T> {
  const stores: SearchStore[] = [];
  const read = (
    targets: Array<{ agentId: string; storePath: string }>,
    assertDiscoveryCurrent: () => void,
  ): Promise<T> => {
    const enter = (index: number): Promise<T> => {
      const target = targets[index];
      if (!target) {
        assertDiscoveryCurrent();
        return consume(stores);
      }
      return withSessionStoreReaderInWorker(target, async (source) => {
        const identity = JSON.stringify(readDatabasePathIdentitySync(source.database.path));
        const native = getOpenClawAgentDatabaseIfOpen(source.database);
        const revision = native && readSqliteNativeMutationRevision(native.db);
        const publication = prepareSessionRowPublicationScope([
          target.storePath,
          source.database.path,
        ]);
        let changed = false;
        const stop = sessionChanges.subscribeFacts((change) => {
          changed ||= sessionChangeAffectsStoredRow(change, {
            ...publication,
            agentId,
            sessionKeys: "all" in change ? [] : [change.sessionKey],
          });
        });
        const assertCurrent = () => {
          assertDiscoveryCurrent();
          source.assertCurrent();
          if (
            changed ||
            JSON.stringify(readDatabasePathIdentitySync(source.database.path)) !== identity ||
            getOpenClawAgentDatabaseIfOpen(source.database) !== native ||
            (native &&
              (native.db.isTransaction || readSqliteNativeMutationRevision(native.db) !== revision))
          ) {
            throw new Error(
              "Session search metadata changed while preparing visibility; retry the request",
            );
          }
        };
        stores.push({ target, source: { ...source, assertCurrent }, identity });
        try {
          return await enter(index + 1);
        } finally {
          stop();
          stores.pop();
        }
      });
    };
    return enter(0);
  };
  if (configured) {
    return read(
      [{ agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) }],
      () => {},
    );
  }
  const inventory = prepareSessionStoreTargetInventory(cfg, [agentId]);
  return prepareSessionStoreTargetInventoryRead(inventory).withRead(
    async (result, assertCurrent) => {
      const source = result.agents[0];
      if (source && !source.result.available && source.result.reason !== "database-missing") {
        throw new Error(`Session stores for agent ${agentId} are unavailable`);
      }
      return read(source?.result.available ? source.result.targets : [], assertCurrent);
    },
  );
}

export const sessionReadHandlers: GatewayRequestHandlers = {
  "sessions.search": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
      return;
    }
    if (params.scope !== undefined) {
      try {
        await searchProjectedSessionTranscripts({
          query,
          limit: params.limit,
          scope: params.scope,
          context,
          client: client ?? null,
          onResult: (result) => {
            sessionMutationAuthorization?.assertCurrent();
            respond(true, result);
          },
        });
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        respond(
          false,
          undefined,
          errorShapeFromError(ErrorCodes.UNAVAILABLE, error, {
            message: formatErrorMessage(error),
          }),
        );
      }
      return;
    }
    const prepareSearch = async <T>(consume: (requests: PreparedSearchRequest[]) => T) => {
      sessionMutationAuthorization?.assertCurrent();
      const cfg = context.getRuntimeConfig();
      const policyConfig = context.getCommittedRuntimeConfig?.() ?? cfg;
      const scope = resolveSessionSearchScope(cfg, params);
      if (!scope.ok) {
        respond(false, undefined, scope.error);
        return undefined;
      }
      const { agentId, configured, requestedAgentId, sessionKeys } = scope;
      const selectedStore = cfg.session?.store;
      const selectedScope = JSON.stringify(scope);
      const restrictIncognito =
        Boolean(gatewayClientSessionCreator(client)) && !isGatewayAdmin(client);
      const roleVisibilityFilter = hasOperatorBoundary(client, policyConfig)
        ? createSessionListEntryFilter({ client, cfg: policyConfig })
        : undefined;
      const restrictVisibility = restrictIncognito || Boolean(roleVisibilityFilter);
      if (requestedAgentId && !params.sessionKeys && configured) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
        );
        return undefined;
      }
      const scopedSessionKeys = configured
        ? sessionKeys
        : sessionKeys?.filter((sessionKey) => {
            const sessionAgentId =
              requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
                ? requestedAgentId
                : resolveSessionStoreAgentId(cfg, sessionKey);
            return sessionAgentId === agentId;
          });
      return withSessionSearchStores(cfg, agentId, configured, async (stores) => {
        const requests: PreparedSearchRequest[] = [];
        const entries = new Map<string, SessionEntrySummary["entry"]>();
        const snapshots: SessionEntrySummary[][] = [];
        for (const { source } of stores) {
          const rows = !restrictVisibility
            ? []
            : scopedSessionKeys
              ? (
                  await source.reader.readExactEntries({
                    sessionKeys: scopedSessionKeys,
                    projection: "sharing",
                    env: source.database.env,
                    continuation: source.continuation,
                  })
                ).entries
              : await source.reader.readEntries(
                  {
                    agentId: source.logicalAgentId,
                    storePath: source.database.path,
                    env: source.database.env,
                    projection: "list",
                    clone: false,
                  },
                  source.continuation,
                );
          snapshots.push(rows);
          for (const { sessionKey, entry } of rows) {
            const parsed = parseAgentSessionKey(sessionKey);
            if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
              continue;
            }
            if (roleVisibilityFilter && entries.has(sessionKey)) {
              throw new Error(`Session lookup found duplicate rows for "${sessionKey}"`);
            }
            entries.set(sessionKey, entry);
          }
        }
        sessionMutationAuthorization?.assertCurrent();
        if (
          context.getRuntimeConfig() !== cfg ||
          (context.getCommittedRuntimeConfig?.() ?? cfg) !== policyConfig ||
          cfg.session?.store !== selectedStore ||
          JSON.stringify(resolveSessionSearchScope(cfg, params)) !== selectedScope
        ) {
          throw new Error(
            "Session search configuration changed while preparing visibility; retry the request",
          );
        }
        const currentFilter = hasOperatorBoundary(client, policyConfig)
          ? createSessionListEntryFilter({ client, cfg: policyConfig })
          : undefined;
        if (
          (!roleVisibilityFilter && currentFilter) ||
          (!restrictVisibility &&
            Boolean(gatewayClientSessionCreator(client)) &&
            !isGatewayAdmin(client))
        ) {
          throw new Error(
            "Session search visibility changed while preparing metadata; retry the request",
          );
        }
        const canSearch = (sessionKey: string) => {
          if (
            isIncognitoSessionKey(sessionKey) &&
            !canAccessIncognitoSession({ cfg, client: client ?? null, sessionKey, agentId })
          ) {
            return false;
          }
          const entry = entries.get(sessionKey);
          return !currentFilter || Boolean(entry && currentFilter(sessionKey, entry));
        };
        for (const [index, { target, source, identity }] of stores.entries()) {
          source.assertCurrent();
          const targetSessionKeys = (
            scopedSessionKeys ??
            (restrictVisibility
              ? snapshots[index]!.map(({ sessionKey }) => sessionKey).filter((sessionKey) => {
                  const parsed = parseAgentSessionKey(sessionKey);
                  return !parsed || normalizeAgentId(parsed.agentId) === agentId;
                })
              : undefined)
          )?.filter(canSearch);
          if (targetSessionKeys?.length === 0) {
            continue;
          }
          requests.push({
            ...target,
            query,
            limit: configured ? params.limit : 25,
            ...(targetSessionKeys ? { sessionKeys: targetSessionKeys } : {}),
            database: { agentId: source.database.agentId, path: source.database.path },
            identity,
          });
        }
        return consume(requests);
      });
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const requests = await prepareSearch((requests) => requests);
        if (!requests) {
          return;
        }
        const targetResults = await Promise.all(
          requests.map(({ database, identity: _identity, ...request }) =>
            searchSessionTranscripts(request, database),
          ),
        );
        // Current configuration, identity, and sharing must authorize the whole result page.
        const completed = await prepareSearch((current) => {
          if (JSON.stringify(current) !== JSON.stringify(requests)) {
            return false;
          }
          const archivedTranscriptsExcluded = targetResults.reduce(
            (count, result) => count + (result.archivedTranscriptsExcluded ?? 0),
            0,
          );
          const limit = params.limit ?? 10;
          const sortedHits = targetResults
            .flatMap((result) => result.hits)
            .toSorted(
              (left, right) =>
                right.score - left.score ||
                right.timestamp - left.timestamp ||
                left.messageId.localeCompare(right.messageId),
            );
          const seenHits = new Set<string>();
          const hits = sortedHits.filter((hit) => {
            const identity = `${hit.sessionKey}\u0000${hit.sessionId}\u0000${hit.messageId}`;
            if (seenHits.has(identity)) {
              return false;
            }
            seenHits.add(identity);
            return true;
          });
          respond(true, {
            results: hits.slice(0, limit),
            ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
            ...(targetResults.some((result) => result.indexing) ? { indexing: true } : {}),
            ...(targetResults.some((result) => result.truncated) || hits.length > limit
              ? { truncated: true }
              : {}),
          });
          return true;
        });
        if (completed !== false) {
          return;
        }
      }
      throw new Error("Session search scope changed while reading; retry the request");
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShapeFromError(ErrorCodes.UNAVAILABLE, error, { message: formatErrorMessage(error) }),
      );
    }
  },
  "sessions.list": createPreparedReadHandler((args) => {
    const { params, client, context } = args;
    const diagnostics = startSessionListDiagnostics(
      args.respond,
      args.req.method === "sessions.subscribe" ? "sessions.subscribe" : "sessions.list",
      params,
    );
    const respondToCaller = diagnostics?.respond ?? args.respond;
    try {
      if (
        !assertValidParams(params, validateSessionsListParams, "sessions.list", respondToCaller)
      ) {
        diagnostics?.finish("returned");
        return undefined;
      }
      const projection = requireSessionRowProjection(context);
      const assertCurrent = () => args.sessionMutationAuthorization?.assertCurrent();
      return {
        respond: respondToCaller,
        assertCurrent,
        beforeRespond: () => {
          // An event delivered before roster admission may not have established its ancestor rows.
          if (client?.connId) {
            context.forgetConnectionAncestors(client.connId);
          }
        },
        release: (outcome) => diagnostics?.finish(outcome),
        run: async (respond) => {
          await listProjectedSessions({
            projection,
            opts: params,
            context,
            client,
            acceptsSerializedJson: args.acceptsSerializedJson,
            diagnostics,
            onResult: (result) => {
              assertCurrent();
              respond(true, result);
            },
          });
        },
      };
    } catch (error) {
      diagnostics?.finish("threw");
      throw error;
    }
  }),
  "sessions.preview": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const keys = params.keys
      .map((key) => normalizeOptionalString(key))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit = params.limit ?? 12;
    const maxChars = params.maxChars ?? 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const projection = requireSessionRowProjection(context);
    const withPreviewRows = <T>(
      requestedKeys: readonly string[],
      consume: (read: SessionRowReadView) => T,
    ): Promise<T> =>
      withReadySessionRows(
        projection,
        (cfg) =>
          requestedKeys.flatMap((key) => {
            const agent = resolveRequestedGlobalAgentId(cfg, key);
            return agent.ok ? [{ key, agentId: agent.agentId }] : [];
          }),
        consume,
      );
    const previews: SessionsPreviewEntry[] = [];
    const buffered: Array<{
      preview: SessionsPreviewEntry;
      record: MaterializedRow;
      generation: MaterializedRow["generation"];
      sessionId: string;
      lifecycleRevision?: string;
    }> = [];

    for (const key of keys) {
      if (previews.length > 0) {
        await yieldToEventLoop();
      }
      const requestedAgent = resolveRequestedGlobalAgentId(context.getRuntimeConfig(), key);
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      const preview: SessionsPreviewEntry = { key, status: "missing", items: [] };
      previews.push(preview);
      try {
        const record = await withPreviewRows([key], (read) => {
          sessionMutationAuthorization?.assertCurrent();
          const { cfg, policyConfig } = read.state;
          const currentAgent = resolveRequestedGlobalAgentId(cfg, key);
          if (!currentAgent.ok) {
            return undefined;
          }
          const current = read.describe({ key, agentId: currentAgent.agentId });
          const visibilityFilter = hasOperatorBoundary(client, policyConfig)
            ? createSessionListEntryFilter({ client, cfg: policyConfig })
            : undefined;
          return current?.entry.sessionId &&
            visibilityFilter?.(current.key, current.entry) !== false
            ? current
            : undefined;
        });
        if (!record) {
          continue;
        }
        buffered.push({
          preview,
          record,
          generation: record.generation,
          sessionId: record.entry.sessionId,
          lifecycleRevision: record.entry.lifecycleRevision,
        });
        preview.items = await readSessionPreviewItemsFromTranscriptAsync(
          {
            agentId: record.agentId,
            sessionEntry: record.entry,
            sessionId: record.entry.sessionId,
            sessionKey: record.key,
            storePath: record.storeTarget.storePath,
          },
          limit,
          maxChars,
        );
        preview.status = preview.items.length > 0 ? "ok" : "empty";
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        preview.status = error instanceof SessionTranscriptColdError ? "cold" : "error";
      }
    }

    // Later keys yield after earlier previews are buffered. Reauthorize the exact
    // incarnations together, without another await before publishing their content.
    await withPreviewRows(
      buffered.map(({ preview }) => preview.key),
      (read) => {
        sessionMutationAuthorization?.assertCurrent();
        const { cfg, policyConfig } = read.state;
        const visibilityFilter = hasOperatorBoundary(client, policyConfig)
          ? createSessionListEntryFilter({ client, cfg: policyConfig })
          : undefined;
        for (const previous of buffered) {
          const agent = resolveRequestedGlobalAgentId(cfg, previous.preview.key);
          const current = agent.ok
            ? read.describe({ key: previous.preview.key, agentId: agent.agentId }, previous.record)
            : undefined;
          if (
            !current ||
            current.agentId !== previous.record.agentId ||
            current.key !== previous.record.key ||
            current.storeTarget.storePath !== previous.record.storeTarget.storePath ||
            current.generation !== previous.generation ||
            current.entry.sessionId !== previous.sessionId ||
            current.entry.lifecycleRevision !== previous.lifecycleRevision ||
            visibilityFilter?.(current.key, current.entry) === false
          ) {
            previous.preview.status = "missing";
            previous.preview.items = [];
          }
        }
        respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
      },
    );
  },
  "sessions.resolve": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const projection = requireSessionRowProjection(context);
    await withPreparedSessionResolve(
      {
        projection,
        client,
        p: params,
        isCurrent: () => getSessionRowProjection(context) === projection,
      },
      (resolved) => {
        sessionMutationAuthorization?.assertCurrent();
        if (!resolved.ok) {
          respond(false, undefined, resolved.error);
          return;
        }
        if ("missing" in resolved) {
          respond(true, { ok: false }, undefined);
          return;
        }
        if ("ambiguous" in resolved) {
          respond(true, { ok: false, candidates: resolved.candidates }, undefined);
          return;
        }
        respond(true, resolved, undefined);
      },
    );
  },
  ...sessionByKeyReadHandlers,
  ...sessionMaintenanceHandlers,
};

export const sessionsListHandler = sessionReadHandlers["sessions.list"]!;
