import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  prepareOperatorModelPolicy,
  readOperatorModelPolicyMembership,
} from "../agents/operator-model-policy.js";
import {
  normalizeRestartRecoveryRequester,
  type RestartRecoveryRequester,
} from "../config/sessions/restart-recovery-requester.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPublishedPairedOperatorIdentity } from "../infra/device-pairing-publication.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  onUserProfilesChanged,
  UserProfileMutationUnsettledError,
} from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import {
  onOperatorRolePolicyChanged,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { checkGatewayWsBrowserOrigin } from "./server/ws-origin-policy.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

export class RestartRequesterDeniedError extends Error {
  constructor() {
    super("The original continuation requester no longer authorizes this session.");
    this.name = "RestartRequesterDeniedError";
  }
}

export class RestartRequesterPendingError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Continuation requester authorization is unavailable; recovery remains pending.",
      options,
    );
    this.name = "RestartRequesterPendingError";
  }
}

export type RestartRequesterLease = {
  authority: AdmittedRunOperatorAuthority;
  assertAdmissionCurrent: () => void;
  release: () => void;
};

const restoredRequesters = new WeakMap<AdmittedRunOperatorAuthority, RestartRecoveryRequester>();

/** The recovery transaction, not the public sharing projection, fences the private record. */
export function assertRestoredRestartRequesterEntry(
  authority: AdmittedRunOperatorAuthority | undefined,
  entry: InternalSessionEntry,
): void {
  const snapshot = authority && restoredRequesters.get(authority);
  if (!snapshot) {
    return;
  }
  authority.assertCurrent();
  if (
    entry.sessionId !== snapshot.sessionId ||
    (entry.lifecycleRevision ?? null) !== snapshot.lifecycleRevision ||
    entry.archivedAt !== undefined ||
    !isDeepStrictEqual(entry.restartRecoveryRequester, snapshot)
  ) {
    throw new RestartRequesterDeniedError();
  }
}

type RestartRequesterTarget = Pick<
  RestartRecoveryRequester,
  "agentId" | "sessionKey" | "sessionId" | "storePath" | "lifecycleRevision" | "sourceRunId"
>;

/** Restore the original requester's restrictions, never the recovery service's System powers. */
export async function restoreRestartRecoveryRequester(params: {
  snapshot: unknown;
  target: RestartRequesterTarget;
  getConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  /** The recovery owner fences its exact private record until execution accepts custody. */
  assertRecordCurrent: () => void;
}): Promise<RestartRequesterLease> {
  const snapshot = normalizeRestartRecoveryRequester(params.snapshot);
  if (
    !snapshot ||
    snapshot.agentId !== params.target.agentId ||
    snapshot.sessionKey !== params.target.sessionKey ||
    snapshot.sessionId !== params.target.sessionId ||
    snapshot.lifecycleRevision !== params.target.lifecycleRevision ||
    snapshot.sourceRunId !== params.target.sourceRunId ||
    path.resolve(snapshot.storePath) !== path.resolve(params.target.storePath)
  ) {
    throw new RestartRequesterDeniedError();
  }
  const originalPolicy: unknown = JSON.parse(snapshot.rolePolicy);
  const revoked = new AbortController();
  let references = 1;
  let prepared = false;
  let identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  let facts: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
  const subscriptions: Array<() => void> = [];
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: snapshot.profileId },
    scopes: [...snapshot.scopes],
  });
  let modelConfig: OpenClawConfig | undefined;
  let modelMetadata: ReturnType<typeof getProcessGatewayPluginMetadataSnapshot>;
  let modelPolicy: ReturnType<typeof prepareOperatorModelPolicy>;
  let access: ReturnType<typeof resumeGatewayOperatorAccessGrant> = null;

  const deny = (): never => {
    const error = new RestartRequesterDeniedError();
    revoked.abort(error);
    throw error;
  };
  const assertPolicy = () => {
    params.assertCurrent();
    revoked.signal.throwIfAborted();
    if (references === 0 || !identity || !facts) {
      return deny();
    }
    let current;
    try {
      current = identity.readCurrentFacts(snapshot.aliasBindingIds);
    } catch (error) {
      if (error instanceof UserProfileMutationUnsettledError) {
        throw new RestartRequesterPendingError({ cause: error });
      }
      return deny();
    }
    if (snapshot.device) {
      let currentDevice;
      try {
        currentDevice = getPublishedPairedOperatorIdentity(snapshot.device.deviceId);
      } catch (error) {
        throw new RestartRequesterPendingError({ cause: error });
      }
      if (currentDevice !== snapshot.device.identity) {
        return deny();
      }
    }
    const cfg = params.getConfig();
    if (resolveGatewayAuthPolicyGeneration(cfg, snapshot.authIdentity) !== snapshot.authPolicy) {
      return deny();
    }
    if (snapshot.browserOrigin && !checkGatewayWsBrowserOrigin(snapshot.browserOrigin, cfg).ok) {
      return deny();
    }
    const role = resolveOperatorRolePolicyForAssignment(
      snapshot.profileId,
      current.profile.assignedRole,
      cfg,
    );
    if (
      current.profile.profileId !== snapshot.profileId ||
      current.profile.assignedRole !== snapshot.role ||
      !isDeepStrictEqual(sourceRolePolicy(role) ?? null, originalPolicy) ||
      (role &&
        !roleScopesAllow({
          role: "operator",
          requestedScopes: snapshot.scopes,
          allowedScopes: role.scopes,
        }))
    ) {
      return deny();
    }
    let currentFacts;
    try {
      currentFacts = facts.readCurrent(cfg);
    } catch (error) {
      throw new RestartRequesterPendingError({ cause: error });
    }
    const entry = currentFacts.target.entry;
    if (
      entry.sessionId !== snapshot.sessionId ||
      (entry.lifecycleRevision ?? null) !== snapshot.lifecycleRevision ||
      entry.archivedAt !== undefined ||
      facts.storageTarget.agentId !== snapshot.agentId ||
      facts.storageTarget.canonicalKey !== snapshot.sessionKey ||
      path.resolve(facts.storageTarget.storePath) !== path.resolve(snapshot.storePath) ||
      authorizePreparedSessionMutation(
        { cfg, client, agentId: snapshot.agentId, sessionKey: snapshot.sessionKey },
        currentFacts,
        { policy: role, aliases: current.aliases },
      )
    ) {
      return deny();
    }
    const metadata = getProcessGatewayPluginMetadataSnapshot();
    if (modelConfig !== cfg || modelMetadata !== metadata) {
      const next = prepareOperatorModelPolicy({
        cfg,
        policy: role?.modelPolicy,
        manifestPlugins: metadata ?? [],
      });
      if (readOperatorModelPolicyMembership(next) !== snapshot.modelPolicyMembership) {
        return deny();
      }
      modelPolicy = next;
      modelConfig = cfg;
      modelMetadata = metadata;
    }
    return { profile: current.profile, cfg, entry };
  };
  const assertAccessCurrent = () => {
    if (!access) {
      return;
    }
    try {
      access.signal.throwIfAborted();
      access.assertCurrent();
    } catch (error) {
      if (access.signal.aborted || error instanceof GatewayOperatorAccessDeniedError) {
        deny();
      }
      throw new RestartRequesterPendingError({ cause: error });
    }
  };
  const assertCurrent = () => {
    assertAccessCurrent();
    const current = assertPolicy();
    try {
      const restored = resumeGatewayOperatorAccessGrant(
        current.profile,
        current.cfg,
        snapshot.grant,
      );
      if (!prepared) {
        access = restored;
      }
    } catch (error) {
      if (error instanceof GatewayOperatorAccessDeniedError) {
        deny();
      }
      throw new RestartRequesterPendingError({ cause: error });
    }
    // Access-policy callbacks can change role, identity, sharing, or config synchronously.
    assertPolicy();
    assertAccessCurrent();
  };
  const assertAdmissionCurrent = () => {
    params.assertRecordCurrent();
    assertCurrent();
    params.assertRecordCurrent();
    return access;
  };
  const recheck = () => {
    if (!prepared || references === 0 || revoked.signal.aborted) {
      return;
    }
    try {
      assertCurrent();
    } catch (error) {
      if (error instanceof RestartRequesterDeniedError) {
        revoked.abort(error);
      }
    }
  };
  const releaseHold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (--references !== 0) {
        return;
      }
      for (const unsubscribe of subscriptions.splice(0)) {
        unsubscribe();
      }
      facts?.release();
      identity?.release();
    };
  };
  const release = releaseHold();
  try {
    params.assertCurrent();
    subscriptions.push(
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === snapshot.profileId) {
          revoked.abort(new RestartRequesterDeniedError());
        } else if (change.kind === "config") {
          const role = resolveOperatorRolePolicyForAssignment(
            snapshot.profileId,
            snapshot.role,
            params.getConfig(),
          );
          if (!isDeepStrictEqual(sourceRolePolicy(role) ?? null, originalPolicy)) {
            revoked.abort(new RestartRequesterDeniedError());
          }
          recheck();
        }
      }),
      onUserProfilesChanged(recheck),
      sessionChanges.subscribe((change) => {
        if (!("sessionKey" in change) || change.sessionKey === snapshot.sessionKey) {
          recheck();
        }
      }),
    );
    try {
      if (snapshot.device) {
        await getPairedDevice(snapshot.device.deviceId);
      }
      identity = await prepareUserProfileIdentity(snapshot.profileId);
      params.assertCurrent();
      revoked.signal.throwIfAborted();
      facts = await prepareSessionMutationFacts({
        cfg: params.getConfig(),
        agentId: snapshot.agentId,
        sessionKey: snapshot.sessionKey,
      });
    } catch (error) {
      if (error instanceof RestartRequesterDeniedError) {
        throw error;
      }
      throw new RestartRequesterPendingError({ cause: error });
    }
    const admittedAccess = assertAdmissionCurrent();
    prepared = true;
    const signal = admittedAccess
      ? AbortSignal.any([revoked.signal, admittedAccess.signal])
      : revoked.signal;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: snapshot.profileId,
      scopes: snapshot.scopes,
      gatewayAccessGrant: snapshot.grant,
      restartAccessGrant: snapshot.grant,
      restartDevice: snapshot.device,
      restartAuthPolicy: snapshot.authPolicy,
      restartAuthIdentity: snapshot.authIdentity,
      restartBrowserOrigin: snapshot.browserOrigin,
      source: Object.freeze({}),
      assertCurrent,
      signal,
      readCurrentRoleAssignment: () => {
        assertCurrent();
        return snapshot.role;
      },
      get modelPolicy() {
        assertCurrent();
        return modelPolicy;
      },
      retain: () => {
        assertCurrent();
        references += 1;
        return releaseHold();
      },
    });
    restoredRequesters.set(authority, snapshot);
    return { authority, assertAdmissionCurrent, release };
  } catch (error) {
    release();
    throw error;
  }
}
