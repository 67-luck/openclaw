import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  projectSessionParticipant,
  projectSessionProfileInvolvement,
} from "./session-identity-projection.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import type * as records from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  authorizeIncognitoSessionTarget,
  hasSessionReadAccessChanged,
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type PresentationOptions = Omit<
  records.SnapshotOptions,
  "now" | "active" | "subagentRuns" | "preparedFacts"
> & {
  includeActivitySummary?: boolean;
};

function toProjectedSessionSharingTarget(record: records.EntryRow): SessionSharingTarget {
  return {
    agentId: record.agentId,
    canonicalKey: record.key,
    entry: record.entry,
    storeKey: record.key,
    storeKeys: [record.key],
    storePath: record.storeTarget.storePath,
  };
}

type PublicationRows = WeakMap<records.MaterializedRow, Map<string, GatewaySessionRow>>;
type PublicationView = (context: SessionRowReadView["state"]["rowContext"]) => {
  rows: PublicationRows;
  subagentRuns: SessionRowReadView["state"]["rowContext"]["subagentRuns"];
};
type RetainPublicationRow = (record: records.EntryRow, row?: GatewaySessionRow) => void;

function captureReadAccess(entry: records.EntryRow["entry"]): records.EntryRow["entry"] {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    createdActor: entry.createdActor && { ...entry.createdActor },
    visibility: entry.visibility,
    incognito: entry.incognito,
  };
}

/** Sharing decisions remain recipient-local; only their identical presented results are reused. */
export function prepareSessionRowPublication(projection: SessionRowProjection, now: number) {
  let context: SessionRowReadView["state"]["rowContext"] | undefined;
  let revision: object | undefined;
  let rows: PublicationRows = new WeakMap();
  let subagentRuns: SessionRowReadView["state"]["rowContext"]["subagentRuns"];
  const view: PublicationView = (current) => {
    const sharingRevision = projection.sharingRevision;
    if (context !== current || revision !== sharingRevision || sharingRevision === undefined) {
      context = current;
      revision = sharingRevision;
      rows = new WeakMap();
      subagentRuns = current.subagentRuns.atTime(now);
    }
    return { rows, subagentRuns };
  };
  return (
    client: GatewayClient,
    projectRun: ReturnType<typeof createVisibleActiveSessionRunProjector>,
    retainAuthority = false,
  ): ReturnType<typeof prepareProjectedSessionPresentation> & { isCurrent?: () => boolean } => {
    if (!retainAuthority) {
      return prepareProjectedSessionPresentation(projection, client, now, projectRun, view);
    }
    const creator = gatewayClientSessionCreator(client)?.id;
    const prepareSharing = () =>
      prepareProjectedSessionSharing({
        cfg: projection.getPolicyConfig(),
        client,
        isMember: (target, identity) =>
          projection.hasMembership(target.storePath, target.storeKey, identity),
      });
    const sharing = prepareSharing();
    const retained = new Map<
      records.EntryRow,
      {
        entry: records.EntryRow["entry"];
        role: ReturnType<typeof sharing.roleForTarget>;
        rows: Set<GatewaySessionRow>;
      }
    >();
    const children = new Map<
      string,
      {
        query: records.Lookup;
        target?: SessionSharingTarget & { generation: string | symbol };
        role?: ReturnType<typeof sharing.roleForTarget>;
      }
    >();
    let retired = false;
    let validatedRevision = projection.sharingRevision;
    let validatedModels = getGatewayPluginMetadataSnapshot();
    let validatedPolicy = projection.getPolicyConfig();
    let validatedProfile = client.preparedSessionProfile;
    let validatedScopes = JSON.stringify(client.connect.scopes);
    const retain: RetainPublicationRow = (record, row) => {
      let captured = retained.get(record);
      if (!captured) {
        captured = {
          entry: captureReadAccess(record.entry),
          role: sharing.roleForTarget(toProjectedSessionSharingTarget(record)),
          rows: new Set(),
        };
        retained.set(record, captured);
      }
      if (row) {
        captured.rows.add(row);
        const keys = new Set([
          ...(row.childSessions ?? []),
          ...(row.swarm?.groups.flatMap(
            (group) => group.children?.map((child) => child.sessionKey) ?? [],
          ) ?? []),
        ]);
        for (const key of keys) {
          if (children.has(key)) {
            continue;
          }
          const query = { agentId: parseAgentSessionKey(key)?.agentId ?? record.agentId, key };
          const state = projection.sharingTargetState(query);
          if (state.status === "pending") {
            retired = true;
          }
          children.set(key, {
            query,
            ...(state.status === "ready"
              ? {
                  target: { ...state.target, entry: captureReadAccess(state.target.entry) },
                  role: sharing.roleForTarget(state.target),
                }
              : {}),
          });
        }
      }
      validatedRevision = projection.sharingRevision;
    };
    return {
      ...prepareProjectedSessionPresentation(projection, client, now, projectRun, view, retain),
      isCurrent: () => {
        if (
          retired ||
          projection.sharingRevision === undefined ||
          gatewayClientSessionCreator(client)?.id !== creator ||
          [...retained.keys()].some((record) => !projection.isCurrent(record))
        ) {
          retired = true;
          return false;
        }
        const revision = projection.sharingRevision;
        const modelMetadata = getGatewayPluginMetadataSnapshot();
        const policyConfig = projection.getPolicyConfig();
        const profile = client.preparedSessionProfile;
        const scopes = JSON.stringify(client.connect.scopes);
        if (
          revision === validatedRevision &&
          modelMetadata === validatedModels &&
          policyConfig === validatedPolicy &&
          profile === validatedProfile &&
          scopes === validatedScopes
        ) {
          return true;
        }
        const sharing = prepareSharing();
        const models = prepareOperatorModelPresentation({
          cfg: projection.state.cfg,
          policyConfig,
          client,
        });
        for (const { query, target, role } of children.values()) {
          const current = projection.sharingTargetState(query);
          if (
            current.status === "pending" ||
            (target
              ? current.status !== "ready" ||
                current.target.generation !== target.generation ||
                current.target.storePath !== target.storePath ||
                hasSessionReadAccessChanged(target.entry, current.target.entry) ||
                sharing.entryFilter?.(current.target.canonicalKey, current.target.entry) ===
                  false ||
                sharing.roleForTarget(current.target) !== role
              : current.status !== "missing")
          ) {
            retired = true;
            return false;
          }
        }
        for (const [record, captured] of retained) {
          const query = {
            agentId: record.agentId,
            key: record.key,
            storePath: record.storeTarget.storePath,
          };
          const state = projection.sharingTargetState(query);
          const privateRecord = isIncognitoSessionKey(record.key)
            ? projection.describe(query, record)
            : undefined;
          const target = privateRecord
            ? toProjectedSessionSharingTarget(privateRecord)
            : state.status === "ready"
              ? state.target
              : undefined;
          if (
            !target ||
            hasSessionReadAccessChanged(captured.entry, target.entry) ||
            sharing.entryFilter?.(target.canonicalKey, target.entry) === false ||
            sharing.roleForTarget(target) !== captured.role ||
            [...captured.rows].some((row) => models && models.session(row) !== row)
          ) {
            retired = true;
            return false;
          }
        }
        validatedRevision = revision;
        validatedModels = modelMetadata;
        validatedPolicy = policyConfig;
        validatedProfile = profile;
        validatedScopes = scopes;
        return true;
      },
    };
  };
}

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: ReturnType<typeof createVisibleActiveSessionRunProjector>,
  publication?: PublicationView,
  retain?: RetainPublicationRow,
) {
  const { cfg, policyConfig, rowContext } = projection.state;
  const models =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client });
  const shared = publication?.(rowContext);
  const publicationRows = shared?.rows;
  const subagentRuns = shared?.subagentRuns ?? rowContext.subagentRuns.atTime(now);
  const active = (key: string, entry: records.MaterializedRow["entry"], agentId: string) =>
    projectRun?.({
      requestedKey: key,
      canonicalKey: key,
      sessionId: entry.sessionId,
      agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, key),
    });
  const target = (query: records.Lookup) => {
    const record = projection.describe(query);
    return record ? toProjectedSessionSharingTarget(record) : null;
  };
  const sharing = prepareProjectedSessionSharing({
    cfg: policyConfig,
    client: client ?? null,
    isMember: (value, identityId) =>
      projection
        .readMembership({
          agentId: value.agentId,
          key: value.storeKey,
          storePath: value.storePath,
        })
        ?.has(identityId) ?? false,
  });
  const profile = gatewayClientSessionCreator(client ?? null);
  const profiles = rowContext.userProfileIdentityById;
  const profileId = profile
    ? projectSessionParticipant({ type: "profile", id: profile.id }, profiles).identity.id
    : undefined;
  const viewer = (value: SessionSharingTarget) => ({
    visibility: resolveSessionVisibility(value.entry),
    ...(profileId && !value.entry.incognito && !isIncognitoSessionKey(value.canonicalKey)
      ? {
          hiddenFromInvolvingMe:
            projectSessionProfileInvolvement(value.entry, profileId, profiles)?.hidden ?? false,
        }
      : {}),
    sharingRole: sharing.roleForTarget(value),
  });
  const present = (
    captured: records.MaterializedRow,
    options: PresentationOptions = {},
  ): GatewaySessionRow | null => {
    const record = projection.describe(
      { agentId: captured.agentId, key: captured.key, storePath: captured.storeTarget.storePath },
      captured,
    );
    if (!record) {
      return null;
    }
    const run = active(record.key, record.entry, record.agentId);
    const excludedChildKeys =
      options.excludedChildKeys ??
      new Set(
        record.materialized.source.childLinks?.flatMap(({ key, entry }) =>
          client !== undefined && sharing.entryFilter?.(key, entry) === false ? [key] : [],
        ),
      );
    const sourceSwarm = record.materialized.row.swarm;
    let swarm: GatewaySessionRow["swarm"];
    if (sourceSwarm) {
      swarm = { ...sourceSwarm, groups: [] };
      for (const group of sourceSwarm.groups) {
        swarm.groups.push({
          ...group,
          children: group.children?.filter(
            ({ sessionKey }) =>
              !excludedChildKeys.has(sessionKey) &&
              (client === undefined ||
                !projection
                  .selectEntries({ key: sessionKey })
                  .some((child) => sharing.entryFilter?.(child.key, child.entry) === false)),
          ),
        });
      }
    }
    const value = toProjectedSessionSharingTarget(record);
    const viewerFacts = client === undefined ? undefined : viewer(value);
    // Permission-pending and worker availability can change without a row publication.
    const preparedFacts = record.facts?.present();
    const canEnsure =
      client !== undefined && preparedFacts?.activitySummary
        ? !authorizeIncognitoSessionTarget({
            client: client ?? null,
            sessionKey: value.canonicalKey,
            target: value,
          }) && !sharing.authorizeTarget(value)
        : undefined;
    const signature =
      publicationRows &&
      JSON.stringify([
        options.includeDerivedTitles,
        options.includeLastMessage,
        options.includeActivitySummary,
        [...excludedChildKeys],
        swarm,
        run,
        viewerFacts,
        preparedFacts,
        canEnsure,
        record.materializedSequence,
        record.profileRevision,
        record.subagentRevision,
        record.lastMessagePreview,
        record.fallbackModel,
      ]);
    let views = publicationRows?.get(record);
    const cached = signature === undefined ? undefined : views?.get(signature);
    const projectModels = (row: GatewaySessionRow) => {
      let projected = models?.session(row) ?? row;
      if (projected !== row && views && signature !== undefined) {
        const modelSignature =
          signature +
          JSON.stringify([
            projected.modelProvider,
            projected.model,
            projected.activeModelProvider,
            projected.activeModel,
            projected.contextBudgetStatus,
          ]);
        const existing = views.get(modelSignature);
        if (existing) {
          projected = existing;
        } else {
          views.set(modelSignature, projected);
        }
      }
      retain?.(record, projected);
      return projected;
    };
    if (cached) {
      return projectModels(cached);
    }
    const row = projection.present(record, {
      ...options,
      now,
      subagentRuns,
      active: run?.active,
      excludedChildKeys,
      preparedFacts,
    });
    if (swarm) {
      row.swarm = swarm;
    }
    if (run) {
      Object.assign(
        row,
        projectGatewaySessionActiveRun(run, row.status),
        run.runIds === undefined ? {} : { activeRunIds: run.runIds },
      );
    }
    if (options.includeActivitySummary === false) {
      row.activitySummary = undefined;
    }
    if (viewerFacts) {
      Object.assign(row, viewerFacts);
      if (row.activitySummary) {
        row.activitySummary = { ...row.activitySummary, canEnsure: canEnsure === true };
      }
    }
    if (publicationRows && signature !== undefined) {
      if (!views) {
        views = new Map();
        publicationRows.set(record, views);
      }
      views.set(signature, row);
    }
    return projectModels(row);
  };
  return {
    rowContext: { ...rowContext, subagentRuns },
    active,
    sharing,
    target,
    present,
    snapshot(query: records.Lookup, options: PresentationOptions = {}) {
      const record = projection.describe(query);
      return record
        ? { row: present(record, options), lifecycleRunId: record.entry.lifecycleRunId }
        : { row: null };
    },
    authorizeDescription(query: records.Lookup) {
      return authorizeIncognitoSessionTarget({
        client: client ?? null,
        sessionKey: query.key,
        target: isIncognitoSessionKey(query.key) ? null : target(query),
      });
    },
  };
}
