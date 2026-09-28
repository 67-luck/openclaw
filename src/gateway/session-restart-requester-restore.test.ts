import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it, vi } from "vitest";
import * as recoveryStore from "../agents/main-session-recovery/main-session-recovery-store.js";
import { resumeMainSession } from "../agents/main-session-recovery/main-session-restart-dispatch.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { revokeDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing, removePairedDevice } from "../infra/device-pairing.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareAgentRunUserTurn } from "./agent-turn/agent-run-user-turn.js";
import type { AgentTurnContext } from "./agent-turn/types.js";
import { resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import { captureGatewayDeviceRevocation } from "./device-revocation.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  RestartRequesterDeniedError,
  RestartRequesterPendingError,
  restoreRestartRecoveryRequester,
  type RestartRequesterLease,
} from "./session-restart-requester-restore.js";

async function withRequester(
  run: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<void>,
  pairedDevice = false,
  authenticatedIdentity = false,
) {
  await withOpenClawTestState(
    { label: "restart-requester", scenario: "minimal" },
    async (state) => {
      const fixture = await prepareFixture(state, pairedDevice, authenticatedIdentity);
      try {
        await run(fixture);
      } finally {
        fixture.release();
        resetPluginRuntimeStateForTest();
      }
    },
  );
}

async function prepareFixture(
  state: Parameters<Parameters<typeof withOpenClawTestState>[1]>[0],
  pairedDevice = false,
  authenticatedIdentity = false,
) {
  const profile = await ensureCanonicalUserProfileForEmail("restart-requester@example.test");
  let cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    gateway: {
      ...(authenticatedIdentity
        ? {
            auth: {
              identityScopes: {
                "restart-requester@example.test": ["operator.write"],
                "other@example.test": ["operator.admin"],
              },
            },
          }
        : {}),
      controlUi: { allowedOrigins: ["https://gateway.example.test"] },
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
        if (capturedId !== grantId) {
          throw new Error("original grant ended");
        }
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
          if (unavailable) {
            throw new Error("policy preparation pending");
          }
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
  originalClient.authModeAtAdmission = cfg.gateway?.auth?.mode ?? null;
  originalClient.browserOrigin = {
    requestHost: "gateway.example.test",
    origin: "https://gateway.example.test",
    isLocalClient: false,
  };
  const deviceId = "restart-operator-device";
  if (pairedDevice) {
    const request = await requestDevicePairing({
      deviceId,
      publicKey: "restart-public-key",
      role: "operator",
      scopes: ["operator.write"],
    });
    await approveDevicePairing(request.request.requestId, { callerScopes: ["operator.write"] });
    originalClient.connect.device = {
      id: deviceId,
      publicKey: "restart-public-key",
      signature: "fixture-signature",
      signedAt: 1,
      nonce: "fixture-nonce",
    };
  }
  const ingress = authenticatedIdentity
    ? captureGatewayDeviceRevocation({}, {}, () => true, undefined, {
        isCurrent: () => true,
        subscribe: () => () => {},
        dependencies: {
          client: originalClient,
          context: {},
          authenticatedUserId: "restart-requester@example.test",
          authPolicyGeneration: resolveGatewayAuthPolicyGeneration(
            cfg,
            "restart-requester@example.test",
          ),
        },
      })
    : undefined;
  const source = await captureGatewayOperatorRunAuthority({
    client: originalClient,
    context: { getRuntimeConfig: () => cfg },
    hasCurrentClientAuthority: ingress?.isCurrent,
  });
  ingress?.release();
  if (!source) {
    throw new Error("missing authenticated operator fixture");
  }
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
  const userTurn = await prepareAgentRunUserTurn({
    client,
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: scope.sessionKey,
    },
    admittedSessionId: entry.sessionId,
    admittedStorePath: scope.storePath,
    resolvedSessionKey: scope.sessionKey,
    activeSessionAgentId: scope.agentId,
    sessionEntry: entry,
    request: { message: "Continue the original task.", idempotencyKey: "accepted-continuation" },
    message: "Continue the original task.",
    effectiveTranscriptInputText: "Continue the original task.",
    images: [],
    offloadedRefs: [],
    suppressVisibleSessionEffects: false,
    requestedPromptPersistenceSuppression: false,
    canUseInternalRuntimeHandoff: false,
    cfg,
    runId: "accepted-continuation",
    context: {
      getRuntimeConfig: () => cfg,
      logGateway: { warn: () => {} },
    } as unknown as AgentTurnContext,
    assertCurrent: source.authority.assertCurrent,
  });
  expect(loadSessionEntry(scope)?.restartRecoveryRequester).toBeUndefined();
  const admitted = await userTurn.recorder?.persistApproved();
  expect(admitted?.appended).toBe(true);
  const snapshot = loadSessionEntry(scope)?.restartRecoveryRequester;
  if (!snapshot) {
    source.release();
    throw new Error("missing captured requester");
  }
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
    deviceId,
    cfg,
    scope,
    entry,
    snapshot,
    admittedMessage: admitted!.message,
    restore,
    oldAuthority: source.authority,
    readStored: () => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const stored = readSessionEntryRow(database, scope.sessionKey);
      if (!stored) {
        throw new Error("missing stored requester fixture");
      }
      return JSON.parse(stored.row.entry_json) as Record<string, unknown>;
    },
    setConfig: (value: OpenClawConfig) => {
      cfg = value;
    },
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    replaceInvitation: () => {
      grant.abort(new Error("original grant ended"));
      grantId = randomUUID();
      grant = new AbortController();
    },
    release: () => {
      for (const lease of leases) {
        lease.release();
      }
      source.release();
    },
  };
}

describe("restart requester restoration", () => {
  it.for(["other identity", "original identity", "auth mode"] as const)(
    "preserves identity-scoped ingress custody across restart when changing %s",
    async (change) => {
      await withRequester(
        async (f) => {
          expect(f.snapshot.authIdentity).toBe("restart-requester@example.test");
          const restored = await f.restore();
          expect(restored.authority.restartAuthIdentity).toBe(f.snapshot.authIdentity);
          const next = structuredClone(f.cfg);
          if (change === "auth mode") {
            next.gateway!.auth!.mode = "token";
          } else {
            delete next.gateway!.auth!.identityScopes![
              change === "other identity" ? "other@example.test" : "restart-requester@example.test"
            ];
          }
          f.setConfig(next);
          if (change === "other identity") {
            expect(() => restored.authority.assertCurrent()).not.toThrow();
            const cold = await f.restore();
            expect(() => cold.authority.assertCurrent()).not.toThrow();
          } else {
            expect(() => restored.authority.assertCurrent()).toThrow();
            await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
          }
        },
        false,
        true,
      );
    },
  );
  it.for(["revoke", "rotate", "remove"] as const)(
    "rejects the original device after %s before cold restoration and final use",
    async (action) => {
      await withRequester(async (f) => {
        const restored = await f.restore();
        expect(() => restored.authority.assertCurrent()).not.toThrow();
        if (action === "remove") {
          await removePairedDevice(f.deviceId);
        } else if (action === "revoke") {
          await revokeDeviceToken({ deviceId: f.deviceId, role: "operator" });
        } else {
          await rotateDeviceToken({
            deviceId: f.deviceId,
            role: "operator",
            scopes: ["operator.write"],
          });
        }
        expect(() => restored.authority.assertCurrent()).toThrow();
        await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
      }, true);
    },
  );

  it("retires old requester custody on a later input and cannot recreate it by replay", async () => {
    await withRequester(async (f) => {
      const stored = loadSessionEntry(f.scope)!;
      const append = (message: unknown, requester: typeof f.snapshot | undefined) =>
        persistSessionTranscriptTurn(
          { ...f.scope, sessionId: stored.sessionId, sessionEntry: stored },
          {
            expectedSessionId: stored.sessionId,
            messages: [{ message }],
            sessionLifecyclePatch: { restartRecoveryRequester: requester },
          },
        );
      await append(
        {
          role: "user",
          content: "A later explicit task.",
          idempotencyKey: "later-input:user",
        },
        undefined,
      );
      expect(loadSessionEntry(f.scope)?.restartRecoveryRequester).toBeUndefined();
      await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
      const duplicate = await append(f.admittedMessage, f.snapshot);
      expect(duplicate?.appendedCount).toBe(0);
      expect(loadSessionEntry(f.scope)?.restartRecoveryRequester).toBeUndefined();
    });
  });

  it("reconstructs the original constrained operator after old execution custody closes", async () => {
    await withRequester(async (f) => {
      // Released public projections already omit mainRestartRecovery, but pass
      // through unknown top-level fields. Keep custody private across downgrade.
      const stored = f.readStored();
      expect(stored).not.toHaveProperty("restartRecoveryRequester");
      expect(stored).toHaveProperty("mainRestartRecovery.requester", f.snapshot);
      expect(stored.mainRestartRecovery).toMatchObject({
        cycleId: expect.any(String),
        revision: 1,
        chargedAttempts: 0,
      });
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

  it.for(["authentication", "browser origin"] as const)(
    "rejects changed %s policy before and after restoring the operator",
    async (policy) => {
      await withRequester(async (f) => {
        const restored = await f.restore();
        f.setConfig({
          ...f.cfg,
          gateway: {
            ...f.cfg.gateway,
            ...(policy === "browser origin"
              ? { controlUi: { allowedOrigins: [] } }
              : {
                  auth: {
                    mode: "trusted-proxy" as const,
                    trustedProxy: { userHeader: "x-user", allowUsers: [] },
                  },
                }),
          },
        });
        expect(() => restored.authority.assertCurrent()).toThrow();
        await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
        f.setConfig(f.cfg);
        expect(() => restored.authority.assertCurrent()).toThrow();
      });
    },
  );

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

  it.for(["before reservation", "after reservation"] as const)(
    "keeps temporary authorization failure pending without charging an attempt: %s",
    async (boundary) => {
      await withRequester(async (f) => {
        setRuntimeConfigSnapshot(f.cfg, f.cfg);
        const entry = {
          ...loadSessionEntry(f.scope)!,
          mainRestartRecovery: {
            cycleId: "pending-authorization",
            revision: 1,
            chargedAttempts: 0,
          },
        };
        await replaceSessionEntry(f.scope, entry);
        const commit = recoveryStore.commitMainSessionRecovery;
        const reservation = vi
          .spyOn(recoveryStore, "commitMainSessionRecovery")
          .mockImplementation(async (params) => {
            if (params.command.kind !== "prepare_attempt") {
              return await commit(params);
            }
            if (boundary === "before reservation") {
              f.setUnavailable(true);
            }
            const result = await commit(params);
            if (boundary === "after reservation") {
              f.setUnavailable(true);
            }
            return result;
          });
        const gatewayRuntime = {
          dispatchSessionMethod: vi.fn(),
          dispatchAgent: vi.fn(),
          waitForAgent: vi.fn(),
          sendRecoveryNotice: vi.fn(),
        };
        try {
          expect(
            await resumeMainSession({
              ...f.scope,
              cfg: f.cfg,
              entry,
              requester: f.snapshot,
              recoveryAttempt: 1,
              observation: {
                sessionId: entry.sessionId,
                cycleId: "pending-authorization",
                revision: 1,
              },
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              gatewayRuntime,
            }),
          ).toBe("failed");
          expect(reservation).toHaveBeenCalled();
          expect(gatewayRuntime.dispatchAgent).not.toHaveBeenCalled();
          expect(gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
          expect(loadSessionEntry(f.scope)).toMatchObject({
            restartRecoveryRequester: f.snapshot,
            mainRestartRecovery: { chargedAttempts: 0 },
          });
          expect(loadSessionEntry(f.scope)?.mainRestartRecovery?.reservation).toBeUndefined();
          expect(loadSessionEntry(f.scope)?.mainRestartRecovery?.tombstone).toBeUndefined();
        } finally {
          reservation.mockRestore();
        }
      });
    },
  );

  it.for(["revoked", "revoked grant", "pending"] as const)(
    "refunds unaccepted dispatch with %s requester authority",
    async (boundary) => {
      await withRequester(async (f) => {
        setRuntimeConfigSnapshot(f.cfg, f.cfg);
        const entry = {
          ...loadSessionEntry(f.scope)!,
          mainRestartRecovery: { cycleId: "dispatch-revocation", revision: 1, chargedAttempts: 0 },
        };
        await replaceSessionEntry(f.scope, entry);
        const dispatchAgent = vi.fn(
          async (
            ...[_request, _timeoutMs, options]: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>
          ) => {
            if (boundary === "revoked") {
              await setCanonicalUserProfileRole(f.profile.id, "revoked");
            } else if (boundary === "revoked grant") {
              f.replaceInvitation();
            } else {
              f.setUnavailable(true);
            }
            options?.assertAdmissionCurrent?.();
            throw new Error("Revoked requester reached execution");
          },
        );
        const gatewayRuntime = {
          dispatchSessionMethod: vi.fn(),
          dispatchAgent,
          waitForAgent: vi.fn(),
          sendRecoveryNotice: vi.fn(),
        };
        expect(
          await resumeMainSession({
            ...f.scope,
            cfg: f.cfg,
            entry,
            requester: f.snapshot,
            recoveryAttempt: 1,
            observation: {
              sessionId: entry.sessionId,
              cycleId: "dispatch-revocation",
              revision: 1,
            },
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            gatewayRuntime,
          }),
        ).toBe(boundary === "pending" ? "failed" : "skipped");
        expect(dispatchAgent).toHaveBeenCalledOnce();
        expect(gatewayRuntime.waitForAgent).not.toHaveBeenCalled();
        const current = loadSessionEntry(f.scope)!;
        expect(current.mainRestartRecovery?.chargedAttempts).toBe(0);
        expect(current.mainRestartRecovery?.reservation).toBeUndefined();
        expect(current.mainRestartRecovery?.tombstone?.reason).toBe(
          boundary === "pending"
            ? undefined
            : "original continuation requester authority is unavailable",
        );
      });
    },
  );

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
      if (!stored) {
        throw new Error("missing stored continuation");
      }
      expect(projectPublicSessionEntry(stored)).not.toHaveProperty("restartRecoveryRequester");
      await replaceSessionEntry(f.scope, { ...stored, archivedAt: 2 });
      const archived = loadSessionEntry(f.scope);
      expect(archived).not.toHaveProperty("restartRecoveryRequester");
      if (!archived) {
        throw new Error("missing archived continuation");
      }
      await replaceSessionEntry(f.scope, { ...archived, archivedAt: undefined });
      await expect(f.restore()).rejects.toBeInstanceOf(RestartRequesterDeniedError);
    });
  });
});
