import type {
  ErrorShape,
  SessionsPatchParams,
  SessionsPatchResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  getPreparedModelCatalogOwnerSnapshot,
  withPreparedModelCatalogOwner,
} from "../agents/prepared-model-catalog.js";
import { readPreparedModelRuntimeCliBackendModels } from "../agents/prepared-model-runtime-auth.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "../agents/prepared-model-runtime.owner.js";
import { retainPublishedModelRuntimeOwner } from "../agents/prepared-model-runtime.published-owner.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { applySessionPatchProjection } from "../config/sessions/session-accessor.js";
import { projectSessionPatchResult } from "../gateway/session-utils-model.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "../gateway/session-utils.js";
import { projectSessionsPatchEntry } from "../gateway/sessions-patch.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Local patches retain only available or validation-requested catalog resources. */
export async function patchEmbeddedSession(
  opts: SessionsPatchParams,
  lifecycle: { ready: Promise<void>; waitForModelRuntime: () => Promise<void> },
): Promise<SessionsPatchResult> {
  await lifecycle.ready;
  await lifecycle.waitForModelRuntime();
  const cfg = getRuntimeConfig();
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: opts.key,
    agentId: opts.agentId,
    exactRead: true,
  });
  await using catalogResources = new AsyncDisposableStack();
  const catalogParams = { config: cfg, agentId: target.agentId, readOnly: true };
  let preparedCatalog: PreparedModelRuntimeSnapshot | undefined;
  try {
    const snapshot = getPreparedModelCatalogOwnerSnapshot(catalogParams);
    const owner = snapshot && resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    if (snapshot && owner) {
      preparedCatalog = catalogResources.use(
        retainPublishedModelRuntimeOwner(owner, snapshot),
      ).snapshot;
    }
  } catch {
    // Optional response facts cannot make an unrelated patch require catalog preparation.
  }
  let preparingCatalog: Promise<PreparedModelRuntimeSnapshot> | undefined;
  const loadPatchCatalog = async () => {
    if (!preparingCatalog) {
      const prepared = createDeferredCore<PreparedModelRuntimeSnapshot>();
      const release = createDeferredCore();
      let admitted = false;
      const completion = withPreparedModelCatalogOwner(catalogParams, (snapshot) => {
        admitted = true;
        preparedCatalog = snapshot;
        prepared.resolve(snapshot);
        return release.promise;
      }).catch((error: unknown) => {
        if (!admitted) {
          // The validation waiter receives acquisition failure; cleanup must not report it twice.
          prepared.reject(error);
          return;
        }
        throw error;
      });
      catalogResources.defer(async () => {
        release.resolve();
        await completion;
      });
      preparingCatalog = prepared.promise;
    }
    return (await preparingCatalog).modelCatalog;
  };
  const applied = await applySessionPatchProjection<{ ok: false; error: ErrorShape }>({
    ...(opts.label === undefined ? { sessionKeys: target.storeKeys } : {}),
    storePath: target.storePath,
    resolveTarget: ({ store }) => {
      const { target: migratedTarget, primaryKey } = resolveCanonicalGatewaySessionStoreKey({
        cfg,
        key: opts.key,
        store,
        agentId: opts.agentId,
      });
      return { primaryKey, candidateKeys: migratedTarget.storeKeys };
    },
    project: async ({ primaryKey, existingEntry, isLabelInUse }) =>
      await projectSessionsPatchEntry({
        cfg,
        existingEntry,
        isLabelInUse,
        storeKey: primaryKey,
        agentId: target.agentId,
        patch: opts,
        loadGatewayModelCatalogSnapshot: loadPatchCatalog,
      }),
  });
  if (!applied.ok) {
    throw new Error(applied.error.message);
  }

  const projected = projectSessionPatchResult({
    canonicalKey: target.canonicalKey ?? opts.key,
    cfg,
    entry: applied.entry,
    storePath: target.storePath,
    targetAgentId: target.agentId,
    metadataSnapshot: preparedCatalog?.metadataSnapshot,
    preparedCliBackendModels: preparedCatalog
      ? readPreparedModelRuntimeCliBackendModels(preparedCatalog)
      : undefined,
  });
  return { ...projected, entry: { ...projected.entry } };
}
