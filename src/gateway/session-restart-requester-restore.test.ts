import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  RestartRequesterDeniedError,
  RestartRequesterPendingError,
  restoreRestartRecoveryRequester,
  type RestartRequesterLease,
} from "./session-restart-requester-restore.js";
import { captureRestartRecoveryRequester } from "./session-restart-requester.js";

async function withRequester(
  run: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "restart-requester", scenario: "minimal" },
    async (state) => {
      const fixture = await prepareFixture(state);
      try {
        await run(fixture);
      } finally {
        fixture.release();
        resetPluginRuntimeStateForTest();
      }
    },
  );
}

async function prepareFixture(state: Parameters<Parameters<typeof withOpenClawTestState>[1]>[0]) {
  const profile = await ensureCanonicalUserProfileForEmail("restart-requester@example.test");
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    gateway: {
      roles: {
        default: "writer",
        definitions: {
          writer: {
            sessions: { others: "none" },
            agents: ["main"],
            scopes: ["operator.write"],
            accessPolicyPlugin: "restart-access",
          },
          revoked: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  await state.writeConfig(cfg);
  const { config, registry } = createPluginRegistryFixture();
  let grantId = randomUUID();
  let grant = new AbortController();
  let unavailable = false;
  const liveGrant = () => {
    const captured = grant;
    const capturedId = grantId;
    return {
      grantId: capturedId,
      signal: captured.signal,
      assertCurrent: () => {
        captured.signal.throwIfAborted();
        if (capturedId !== grantId) throw new Error("original grant ended");
      },
    };
  };
  registerVirtualTestPlugin({
    registry,
    config,
    id: "restart-access",
    name: "Restart access",
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize: () => liveGrant(),
        resume: (request) => {
          if (unavailable) throw new Error("policy preparation pending");
          return request.grantId === grantId && !grant.signal.aborted ? liveGrant() : undefined;
        },
      });
    },
  });
  setActivePluginRegistry(registry.registry);
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:restart-owned",
    storePath: path.join(state.sessionsDir("main"), "sessions.json"),
  };
  const entry: InternalSessionEntry = {
    sessionId: "restart-owned-session",
    lifecycleRevision: "restart-owned-incarnation",
    updatedAt: 1,
    status: "running",
    abortedLastRun: true,
    createdActor: { type: "human", source: "profile", id: profile.id },
  };
  await replaceSessionEntry(scope, entry);
  const originalClient = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: profile.id },
    operatorAccessAuthority: resolveGatewayOperatorAccessAuthority(profile.id, cfg),
    scopes: ["operator.write"],
  });
  const source = await captureGatewayOperatorRunAuthority({
    client: originalClient,
    context: { getRuntimeConfig: () => cfg },
  });
  if (!source) throw new Error("missing authenticated operator fixture");
  const operationalRunInstance = { instanceId: "original-instance", runId: "original-run" };
  const client = {
    ...originalClient,
    internal: {
      ...originalClient.internal,
      operatorRunAuthority: source.authority,
      agentRuntimeIdentity: {
        kind: "agentRuntime" as const,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local" as const,
          operationalRunInstance,
          lifecycleGeneration: "previous-gateway",
          claimId: "original-run-claim",
        },
      },
    },
  };
  const snapshot = await captureRestartRecoveryRequester({
    ...scope,
    client,
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: scope.sessionKey,
    },
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    runId: "accepted-continuation",
    getConfig: () => cfg,
    assertCurrent: source.authority.assertCurrent,
  });
  if (!snapshot) {
    source.release();
    throw new Error("missing captured requester");
  }
  await replaceSessionEntry(scope, { ...entry, restartRecoveryRequester: snapshot });
  source.release();
  const leases: RestartRequesterLease[] = [];
  const restore = async () => {
    const lease = await restoreRestartRecoveryRequester({
      snapshot,
      target: snapshot,
      getConfig: () => cfg,
      assertCurrent: () => {},
      assertRecordCurrent: () => {
        const current = loadSessionEntry(scope);
        if (!isDeepStrictEqual(current?.restartRecoveryRequester, snapshot)) {
          throw new RestartRequesterDeniedError();
        }
      },
    });
    leases.push(lease);
    return lease;
  };
  return {
    profile,
    cfg,
    scope,
    entry,
    snapshot,
    restore,
    oldAuthority: source.authority,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    replaceInvitation: () => {
      grant.abort(new Error("original grant ended"));
      grantId = randomUUID();
      grant = new AbortController();
    },
    release: () => {
      for (const lease of leases) lease.release();
      source.release();
    },
  };
}

describe("restart requester restoration", () => {
  it("reconstructs the original constrained operator after old execution custody closes", async () => {
    await withRequester(async (f) => {
      expect(() => f.oldAuthority.assertCurrent()).toThrow();
      const restored = await f.restore();
      expect(restored.authority.profileId).toBe(f.profile.id);
      expect(restored.authority.scopes).toEqual(["operator.write"]);
      expect(restored.authority.gatewayAccessGrant).toEqual(f.snapshot.grant);
      const releaseRun = restored.authority.retain!();
      restored.release();
      expect(() => restored.authority.assertCurrent()).not.toThrow();
      releaseRun();
      expect(() => restored.authority.assertCurrent()).toThrow();
    });
  });

  it("keeps a revoked live role capture closed after its assignment is restored", async () => {
    await withRequester(async (f) => {
      const restored = await f.restore();
      await setCanonicalUserProfileRole(f.profile.id, "revoked");
      expect(() => restored.authority.assertCurrent()).toThrow();
      await setCanonicalUserProfileRole(f.profile.id, null);
      expect(() => restored.authority.assertCurrent()).toThrow();
      expect(restored.authority.signal?.aborted).toBe(true);
    });
  });

  it("distinguishes unavailable original policy from a replacement invitation", async () => {
    await withRequester(async (f) => {
      f.setUnavailable(true);
      await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterPendingError);
      expect(loadSessionEntry(f.scope)?.restartRecoveryRequester).toEqual(f.snapshot);
      f.setUnavailable(false);
      const restored = await f.restore();
      restored.release();
      f.replaceInvitation();
      await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
    });
  });

  it("does not authorize a replacement incarnation with the same session key", async () => {
    await withRequester(async (f) => {
      await replaceSessionEntry(f.scope, {
        ...f.entry,
        lifecycleRevision: "replacement",
        restartRecoveryRequester: f.snapshot,
      });
      await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
    });
  });

  it("keeps requester records private and retires them when the conversation is archived", async () => {
    await withRequester(async (f) => {
      const stored = loadSessionEntry(f.scope);
      if (!stored) throw new Error("missing stored continuation");
      expect(projectPublicSessionEntry(stored)).not.toHaveProperty("restartRecoveryRequester");
      await replaceSessionEntry(f.scope, { ...stored, archivedAt: 2 });
      const archived = loadSessionEntry(f.scope);
      expect(archived).not.toHaveProperty("restartRecoveryRequester");
      if (!archived) throw new Error("missing archived continuation");
      await replaceSessionEntry(f.scope, { ...archived, archivedAt: undefined });
      await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
    });
  });
});
