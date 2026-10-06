import { expect, it } from "vitest";
import {
  prepareSessionDeliveryGeneration,
  prepareSessionGenerationFacts,
} from "../config/sessions/session-delivery-generation.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createPresenceRecipientProjection } from "../gateway/presence-projection.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";

type ActorCompositionFixture = {
  actor: IncognitoAgentDatabaseExecution;
  authority: IncognitoSessionAuthority;
  sessionKey: string;
  entry: SessionEntry & { lifecycleRevision: string };
};

export function registerIncognitoActorCompositionTest(
  getFixture: () => ActorCompositionFixture,
): void {
  it("composes sharing, delivery and presence from current actor facts without host SQL", async () => {
    const { actor, authority, sessionKey, entry } = getFixture();
    const initial = {
      ...entry,
      permissionMode: "read-only",
      toolOverrides: { webSearch: false },
    } satisfies SessionEntry;
    await actor.sessions.create(authority, { sessionKey, entry: initial });
    const signal = new AbortController();
    await withIncognitoSessionActor(
      actor,
      async () => {
        const sql = observeMainThreadSql();
        const facts = await prepareSessionMutationFacts({ cfg: {}, agentId: "main", sessionKey });
        const delivery = await prepareSessionDeliveryGeneration({
          agentId: "main",
          storePath: actor.path,
          sessionKey,
          sessionId: initial.sessionId,
          lifecycleRevision: initial.lifecycleRevision,
        });
        let generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
        try {
          generation = await prepareSessionGenerationFacts({
            agentId: "main",
            storePath: actor.path,
            sessionKey,
            sessionId: initial.sessionId,
            lifecycleRevision: initial.lifecycleRevision,
          });
          expect(generation.readSessionSettings()).toEqual({
            permissionMode: "read-only",
            toolOverrides: { webSearch: false },
          });
          const person = { text: "actor watcher", ts: 1, watchedSessions: [sessionKey] };
          const project = createPresenceRecipientProjection({ cfg: {}, presence: [person] });
          const client: GatewayClient = {
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              role: "operator",
              scopes: ["operator.admin"],
              client: {
                id: "openclaw-control-ui",
                version: "test",
                platform: "test",
                mode: "webchat",
              },
            },
          };
          expect(facts.storageTarget.storePath).toBe(actor.path);
          expect(facts.readCurrent({}).target.entry.sessionId).toBe(initial.sessionId);
          expect(project(client)).toEqual([person]);
          delivery.assertCurrent();
          await actor.sessions.sideData(authority, {
            type: "session.sharing.add",
            input: { sessionKey, params: { identityId: "viewer", addedBy: "owner" } },
          });
          expect(facts.readCurrent({}).membership.has("viewer")).toBe(true);
          delivery.assertCurrent();
          signal.abort(new Error("authority revoked"));
          expect(() => facts.readCurrent({})).toThrow("Session access facts are unavailable");
          expect(() => delivery.assertCurrent()).toThrow(
            "Session delivery generation is unavailable",
          );
          expect(generation.readSessionSettings).toThrow(
            "Session delivery generation is unavailable",
          );
          expect(() => project(client)).toThrow("authority revoked");
          sql.expectIdle();
        } finally {
          generation?.release();
          delivery.release();
          facts.release();
          sql.restore();
        }
      },
      signal.signal,
    );
  });
}
