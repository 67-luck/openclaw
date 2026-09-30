// Memory audiences against the real session owner: worker reads, SQLite rows,
// and the generation leases that keep currency checks read-free.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertMemoryAudienceCurrent,
  delegateMemoryAudience,
  resolveMemoryAudienceFromEntry,
} from "./memory-audience.js";

const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const RECALL_KEY = "agent:main:root:active-memory:recall";

it("binds lineage and delegated child incarnations to committed session rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const write = (sessionKey: string, entry: SessionEntry) =>
      replaceSessionEntrySync({ agentId: "main", sessionKey, env }, entry);
    const root: SessionEntry = {
      sessionId: randomUUID(),
      lifecycleRevision: randomUUID(),
      chatType: "direct",
      updatedAt: 1,
    };
    const child: SessionEntry = {
      sessionId: randomUUID(),
      lifecycleRevision: randomUUID(),
      updatedAt: 1,
      spawnedBy: ROOT_KEY,
      parentSessionKey: ROOT_KEY,
      spawnedBySessionId: root.sessionId,
      parentSessionLifecycleRevision: root.lifecycleRevision,
      spawnedBySenderIsOwner: true,
    };
    write(ROOT_KEY, root);
    write(CHILD_KEY, child);
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });

    const resolution = await resolveMemoryAudienceFromEntry(
      {
        agentId: "main",
        sessionKey: CHILD_KEY,
        sessionId: child.sessionId,
        senderIsOwner: false,
        storePath,
      },
      child,
    );
    if (resolution.status !== "granted") {
      throw new Error(resolution.reason);
    }
    expect(resolution.audience).toEqual({ kind: "owner-private", agentId: "main" });

    const recall: SessionEntry = { sessionId: "recall-session", updatedAt: 1 };
    write(RECALL_KEY, recall);
    const delegated = await delegateMemoryAudience(resolution.audience, {
      sessionKey: RECALL_KEY,
      storePath,
    });
    // Same-incarnation writes keep both grants current.
    write(ROOT_KEY, { ...root, updatedAt: 2 });
    write(RECALL_KEY, { ...recall, updatedAt: 2 });
    assertMemoryAudienceCurrent(resolution.audience);
    assertMemoryAudienceCurrent(delegated.audience);

    // Resetting the delegated child revokes only the delegate.
    write(RECALL_KEY, { ...recall, sessionId: "recall-replacement", updatedAt: 3 });
    expect(() => assertMemoryAudienceCurrent(delegated.audience)).toThrow("no longer current");
    assertMemoryAudienceCurrent(resolution.audience);

    // A detached child binds its row's absence; a claimed key revokes the delegate.
    const detachedKey = "agent:main:root:memory-flush:detached";
    const detached = await delegateMemoryAudience(resolution.audience, {
      sessionKey: detachedKey,
      storePath,
      detached: true,
    });
    assertMemoryAudienceCurrent(detached.audience);
    write(detachedKey, { sessionId: "claimed", updatedAt: 1 });
    expect(() => assertMemoryAudienceCurrent(detached.audience)).toThrow("no longer current");

    // Resetting a lineage parent revokes the inherited grant.
    write(ROOT_KEY, { ...root, lifecycleRevision: randomUUID(), updatedAt: 4 });
    expect(() => assertMemoryAudienceCurrent(resolution.audience)).toThrow("no longer current");

    detached.release();
    delegated.release();
    resolution.release();
  });
});
