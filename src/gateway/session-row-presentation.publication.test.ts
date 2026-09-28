import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

class PublicationSocket extends EventEmitter implements GatewayConnectionTransport {
  readyState = 1;
  bufferedAmount = 0;
  frames: EventFrame[] = [];
  close() {}
  terminate() {}
  send(frame: string, callback?: (error?: Error) => void): void;
  send(frame: Buffer, options: { binary: false }, callback?: (error?: Error) => void): void;
  send(
    frame: string | Buffer,
    options?: { binary: false } | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ) {
    this.frames.push(JSON.parse(frame.toString()));
    (typeof options === "function" ? options : callback)?.();
  }
}

it("delivers queued lifecycle receipts but rejects reset, ancestor revocation, and detached projections", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const viewer = ensureProfileForEmail("publication-viewer@example.test");
    const cfg = rolePolicyConfig();
    const parent = { agentId: "main", sessionKey: "agent:main:publication-parent" };
    const child = { agentId: "main", sessionKey: "agent:main:publication-child" };
    const entry = {
      sessionId: "publication-child",
      updatedAt: 1,
      parentSessionKey: parent.sessionKey,
    };
    replaceSessionEntrySync(parent, { sessionId: "publication-parent", updatedAt: 1 });
    replaceSessionEntrySync(child, entry);
    const projection = await createSessionRowProjection({ cfg });
    const connection = createGatewayConnectionState({
      cfg,
      scheduler: createTestGatewayScheduler(),
      bootId: "publication",
    });
    const detach = connection.attachSessionRowProjection(projection);
    const socket = new PublicationSocket();
    const source = sharingPolicyClient({ user: viewer.id });
    const client: GatewayWsClient = {
      ...source,
      connect: { ...source.connect, caps: ["session-changed-bundles"] },
      socket,
      connId: "publication-viewer",
      usesSharedGatewayAuth: false,
    };
    prepareGatewayRecipientProfile(client);
    connection.clients.add(client);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publish = (reason: string) =>
      connection.broadcast("sessions.changed", {
        sessionKey: child.sessionKey,
        agentId: "main",
        reason,
      });
    const flush = () => vi.advanceTimersByTime(25);
    try {
      publish("send");
      const updated = await patchSessionEntryCore(child, () => ({
        updatedAt: 2,
        status: "running",
        outputTokens: 10,
        modelProvider: "example",
        model: "changed",
      }));
      await projection.ensureMaterialized();
      publish("agent.run.started");
      flush();
      expect(socket.frames).toEqual([
        expect.objectContaining({
          event: "sessions.changed.bundle",
          payload: expect.objectContaining({
            receipts: [
              expect.objectContaining({
                payload: expect.objectContaining({
                  reason: "send",
                  session: expect.objectContaining({ updatedAt: 1 }),
                }),
              }),
              expect.objectContaining({
                payload: expect.objectContaining({
                  reason: "agent.run.started",
                  session: expect.objectContaining({
                    updatedAt: updated?.updatedAt,
                    status: "running",
                  }),
                }),
              }),
            ],
          }),
        }),
      ]);
      socket.frames = [];
      publish("before-reset");
      replaceSessionEntrySync(child, { ...entry, lifecycleRevision: "replacement", updatedAt: 3 });
      await projection.ensureMaterialized();
      publish("reset");
      flush();
      expect(socket.frames).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            receipts: [
              expect.objectContaining({ payload: expect.objectContaining({ reason: "reset" }) }),
            ],
          }),
        }),
      ]);
      socket.frames = [];
      publish("before-ancestor-revocation");
      await patchSessionEntryCore(parent, () => ({ visibility: "draft" }));
      await projection.ensureMaterialized();
      flush();
      expect(socket.frames).toEqual([]);
      publish("before-detach");
      detach();
      flush();
      expect(socket.frames).toEqual([]);
    } finally {
      vi.useRealTimers();
      detach();
      connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});

it("retains visible child identity and membership authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const viewer = ensureProfileForEmail("publication-member@example.test");
    const client = sharingPolicyClient({ user: viewer.id });
    prepareGatewayRecipientProfile(client);
    const cfg = rolePolicyConfig();
    const parent = { agentId: "main", sessionKey: "agent:main:parent" };
    const child = { agentId: "main", sessionKey: "agent:main:child" };
    replaceSessionEntrySync(parent, { sessionId: "parent", updatedAt: 1, visibility: "suggest" });
    replaceSessionEntrySync(child, {
      sessionId: "child",
      updatedAt: 1,
      parentSessionKey: parent.sessionKey,
    });
    addSessionMember(parent, { identityId: viewer.id, addedBy: "owner" });
    const projection = await createSessionRowProjection({ cfg });
    const publication = () => {
      const present = prepareSessionRowPublication(projection, 1)(
        client,
        createVisibleActiveSessionRunProjector(
          { chatAbortControllers: new Map() },
          projection.state.rowContext.projectedAgentRuns,
        ),
        true,
      );
      const row = present.snapshot({ agentId: "main", key: parent.sessionKey }).row;
      expect(row?.childSessions).toEqual([child.sessionKey]);
      expect(present.isCurrent?.()).toBe(true);
      return present;
    };
    try {
      const beforeMemberRemoval = publication();
      removeSessionMember(parent, viewer.id);
      expect(beforeMemberRemoval.isCurrent?.()).toBe(false);
      await projection.ensureMaterialized();
      const beforeChildReset = publication();
      replaceSessionEntrySync(child, {
        sessionId: "child",
        lifecycleRevision: "reset-child",
        updatedAt: 2,
        parentSessionKey: parent.sessionKey,
      });
      expect(beforeChildReset.isCurrent?.()).toBe(false);
      await projection.ensureMaterialized();
      const beforeChildRevocation = publication();
      await patchSessionEntryCore(child, () => ({ visibility: "draft" }));
      expect(beforeChildRevocation.isCurrent?.()).toBe(false);
    } finally {
      projection.dispose();
    }
  });
});

it("retires captured model presentation when committed operator policy changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const viewer = ensureProfileForEmail("publication-model-viewer@example.test");
    const client = sharingPolicyClient({ user: viewer.id });
    prepareGatewayRecipientProfile(client);
    const cfg = {
      ...rolePolicyConfig(),
      agents: { defaults: { model: { primary: "example/visible" } } },
    };
    let policyConfig = cfg;
    const scope = { agentId: "main", sessionKey: "agent:main:model-publication" };
    replaceSessionEntrySync(scope, {
      sessionId: "model-publication",
      updatedAt: 1,
      modelProvider: "example",
      model: "visible",
    });
    const projection = await createSessionRowProjection({
      cfg,
      getPolicyConfig: () => policyConfig,
    });
    try {
      const present = prepareSessionRowPublication(projection, 1)(
        client,
        createVisibleActiveSessionRunProjector(
          { chatAbortControllers: new Map() },
          projection.state.rowContext.projectedAgentRuns,
        ),
        true,
      );
      expect(present.snapshot({ agentId: "main", key: scope.sessionKey }).row).toMatchObject({
        model: "visible",
      });
      expect(present.isCurrent?.()).toBe(true);
      policyConfig = { ...cfg };
      expect(present.isCurrent?.()).toBe(true);
      const profile = client.preparedSessionProfile;
      expect(profile).toBeDefined();
      if (profile) {
        client.preparedSessionProfile = { ...profile, aliases: new Set(profile.aliases) };
      }
      client.connect.scopes = client.connect.scopes?.toReversed();
      expect(present.isCurrent?.()).toBe(true);
      policyConfig = {
        ...cfg,
        gateway: {
          roles: {
            default: "view",
            definitions: {
              view: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
                modelPolicy: { allow: [] },
              },
            },
          },
        },
      };
      expect(present.isCurrent?.()).toBe(false);
    } finally {
      projection.dispose();
    }
  });
});
