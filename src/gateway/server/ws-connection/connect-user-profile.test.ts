import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import * as profileReader from "../../../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../../auth-policy.js";
import { cfg } from "../../github-user-identity.oidc.test-support.js";
import { prepareGatewayLocalUserIngress } from "../../local-user-ingress.js";
import { GatewayConnectionWork } from "../../server-connection-work.js";
import { createContext } from "../../server-plugin-in-process-dispatch.test-support.js";
import { GatewayClientRegistry } from "../client-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  createGatewayConnectProfileLifecycle,
  resolveGatewayConnectProfileAdmission,
} from "./connect-user-profile.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

function connection(profileId: string) {
  setRuntimeConfigSnapshot(cfg);
  const connectionWork = new GatewayConnectionWork();
  let registered: GatewayWsClient | null = null;
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  });
  const connectParams: GatewayConnectPhaseContext["connectParams"] = {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "openclaw-control-ui", mode: "webchat", version: "test", platform: "test" },
    role: "operator",
    scopes: ["operator.read"],
  };
  const logger = createSubsystemLogger("test/profile-lifecycle");
  const context: GatewayConnectPhaseContext = {
    configSnapshot: cfg,
    connectParams,
    frame: { type: "req", id: "profile-admission", method: "connect", params: connectParams },
    trustedProxies: [],
    allowRealIpFallback: false,
    peerLabel: "test",
    hasProxyHeaders: false,
    isLocalClient: false,
    reportedClientIpSource: "none",
    hasBrowserOriginHeader: false,
    clientLabel: "test",
    clientMeta: {},
    handler: {
      clients: new GatewayClientRegistry(),
      connId: "profile-lifecycle",
      bootId: "profile-lifecycle-boot",
      connectNonce: "profile-lifecycle-nonce",
      socket,
      upgradeReq: new IncomingMessage(new Socket()),
      ingressAttribution: {
        kind: "direct-local",
        clientIp: "127.0.0.1",
        rateLimit: { subject: { key: "127.0.0.1" }, resetOnSuccess: true },
      },
      getResolvedAuth: () => ({ mode: "trusted-proxy", allowTailscale: false }),
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      nodeLifecycleDispatch: new GatewayNodeLifecycleDispatchTracker(),
      prepareAuthenticatedReceive: () => ({ ok: true, value: vi.fn() }),
      refreshHealthSnapshot:
        vi.fn<GatewayConnectPhaseContext["handler"]["refreshHealthSnapshot"]>(),
      send: () => ({ kind: "sent" }),
      clearHandshakeTimer: vi.fn(),
      setHandshakeState: vi.fn(),
      advanceHandshakePhase: vi.fn(),
      setCloseCause: vi.fn(),
      setLastFrameMeta: vi.fn(),
      originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
      logWsControl: logger,
      logGateway: logger,
      logHealth: logger,
      isClosed: () => connectionWork.signal.aborted,
      getClient: () => registered,
      setClient: (client) => {
        registered = client;
        return true;
      },
      connectionWork,
      buildRequestContext: createContext,
      close: vi.fn(),
    },
    markHandshakeFailure: vi.fn(),
    sendHandshakeErrorResponse: vi.fn(),
    sendFrame: async () => {},
    onHelloDelivered: vi.fn(),
    isWebchatConnect: () => true,
    runDetachedConnectWork: vi.fn(),
    pendingNodePairingCleanup: {},
    broadcastNodePairingResult: vi.fn(),
    releasePendingNodePairingCleanup: async () => {},
  };
  const state: DeviceAuthorizedGatewayConnect = {
    authPolicy: captureGatewayAuthPolicy(cfg, null),
    resolvedAuth: { mode: "trusted-proxy", allowTailscale: false },
    minProtocol: 1,
    maxProtocol: 1,
    usesLegacyNodeProtocol: false,
    role: "operator",
    scopes: ["operator.read"],
    hasRequestedScopes: true,
    isControlUi: true,
    isBrowserOperatorUi: true,
    isWebchat: true,
    isNativeAppUi: false,
    startupPending: false,
    device: null,
    devicePublicKey: null,
    deviceAuthPayloadVersion: null,
    hasTokenAuth: false,
    hasPasswordAuth: false,
    authResult: { ok: true, method: "trusted-proxy", user: "ada@example.test" },
    authMethod: "trusted-proxy",
    pairingLocality: "remote",
    sessionUsesSharedGatewayAuth: false,
    issuedBootstrapProfile: null,
    handoffBootstrapProfile: null,
    trustedProxyAuthOk: true,
    controlUiPairingKind: null,
    skipLocalBackendSelfPairing: false,
    rejectUnauthorized: vi.fn(),
    deviceToken: null,
    bootstrapDeviceTokens: [],
  };
  const lifecycle = createGatewayConnectProfileLifecycle(context, state);
  const admit = () =>
    resolveGatewayConnectProfileAdmission({
      context,
      state,
      ownerProfileExpected: false,
      authenticatedUserId: "ada@example.test",
      resolveAuthenticatedGitHubIdentity: async () => ({ profileId, updatedAt: 1 }),
      assertCurrent: lifecycle.assertCurrent,
    });
  return {
    lifecycle,
    admit,
    context,
    bind: (profile: Extract<Awaited<ReturnType<typeof admit>>, { ok: true }>["prepared"]) => {
      registered = {
        socket,
        connId: "profile-lifecycle",
        connect: connectParams,
        usesSharedGatewayAuth: false,
        authenticatedUserProfile: profile?.profile,
        preparedProfileIdentity: profile?.identity,
      };
      lifecycle.bind(registered);
      return registered;
    },
    close: () => {
      connectionWork.beginClose();
      context.handler.upgradeReq.destroy();
      socket.emit("close");
    },
  };
}

const ingress = (profile: { profileId: string; displayName: string | null }) =>
  prepareGatewayLocalUserIngress({
    authMethod: "trusted-proxy",
    authenticatedUserExpected: true,
    profile,
    isLocalClient: false,
  });

afterEach(() => vi.restoreAllMocks());

describe("WebSocket profile identity ownership", () => {
  it("rejects a revoked pre-registration role and releases its admission lease", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("ada@example.test");
      setUserProfileRole(profile.id, "maintainer");
      const connectionState = connection(profile.id);
      const admitted = await connectionState.admit();
      expect(admitted.ok).toBe(true);
      if (!admitted.ok || !admitted.prepared) {
        throw new Error("Profile admission failed");
      }
      connectionState.lifecycle.retain(admitted.prepared);
      expect(connectionState.lifecycle.isCurrent(admitted.prepared)).toBe(true);
      setUserProfileRole(profile.id, null);
      expect(connectionState.lifecycle.isCurrent(admitted.prepared)).toBe(false);
      connectionState.lifecycle[Symbol.dispose]();
      expect(() => admitted.prepared!.identity.readCurrentProfile()).toThrow();
    });
  });

  it("replaces the socket lease with a merge-aware identity and releases it on close without host SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = ensureProfileForEmail("ada@example.test");
      const target = ensureProfileForEmail("target@example.test");
      const connectionState = connection(source.id);
      const admitted = await connectionState.admit();
      if (!admitted.ok || !admitted.prepared) {
        throw new Error("Profile admission failed");
      }
      connectionState.lifecycle.retain(admitted.prepared);
      const client = connectionState.bind(admitted.prepared);
      linkEmail("ada@example.test", target.id);
      const native = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        await connectionState.lifecycle.attach(source.id, ingress);
        expect(client.authenticatedUserProfile?.profileId).toBe(target.id);
        expect(client.preparedSessionProfile?.aliases).toEqual(new Set([source.id, target.id]));
        expect(() => admitted.prepared!.identity.readCurrentProfile()).toThrow();
        const identity = client.preparedProfileIdentity!;
        connectionState.lifecycle[Symbol.dispose]();
        expect(identity.readCurrentProfile().profileId).toBe(target.id);
        connectionState.close();
        expect(() => identity.readCurrentProfile()).toThrow();
        expect(native).not.toHaveBeenCalled();
      } finally {
        native.mockRestore();
        connectionState.close();
      }
    });
  });

  it.each(["connection close", "profile merge"])(
    "releases acquired identity after %s during awaited admission",
    async (revocation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const source = ensureProfileForEmail("ada@example.test");
        const target = ensureProfileForEmail("target@example.test");
        const connectionState = connection(source.id);
        const acquired =
          createDeferred<Awaited<ReturnType<typeof profileReader.prepareUserProfileIdentity>>>();
        const resume = createDeferred<void>();
        const prepare = profileReader.prepareUserProfileIdentity;
        vi.spyOn(profileReader, "prepareUserProfileIdentity").mockImplementationOnce(
          async (...args) => {
            const identity = await prepare(...args);
            acquired.resolve(identity);
            await resume.promise;
            return identity;
          },
        );
        const admission = connectionState.admit();
        const identity = await awaitGateBeforeSettlement(
          acquired.promise,
          admission,
          "Admission skipped identity preparation",
        );
        if (revocation === "connection close") {
          connectionState.close();
        } else {
          linkEmail("ada@example.test", target.id);
        }
        resume.resolve();
        expect(await admission).toEqual({ ok: false });
        expect(connectionState.context.sendHandshakeErrorResponse).toHaveBeenCalledOnce();
        expect(() => identity.readCurrentProfile()).toThrow();
        connectionState.lifecycle[Symbol.dispose]();
      });
    },
  );
});
