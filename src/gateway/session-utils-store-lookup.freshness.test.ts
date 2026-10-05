import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionEntryReaders from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";

it.each(["before", "during", "repeated", "consume"] as const)(
  "consumes an ordered sharing snapshot with a native write %s admission",
  async (timing) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const key = "agent:main:sharing-before-snapshot";
      const scope = { agentId: "main", sessionKey: key, env };
      await replaceSessionEntry(scope, { sessionId: "same-session", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const committedMembers: string[] = [];
      const pendingMembers =
        timing === "repeated" ? ["first-member", "second-member"] : ["first-member"];
      let reads = 0;
      const readEntries = sessionEntryReaders.withSessionEntriesFromStoresInWorker;
      const read = vi
        .spyOn(sessionEntryReaders, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (inputs, consume, options) => {
          reads += 1;
          const write = () => {
            const identityId = pendingMembers.shift();
            if (identityId) {
              addSessionMember(scope, { identityId, addedBy: "owner", addedAt: 1 });
              committedMembers.push(identityId);
            }
          };
          if (timing === "before") {
            await runOpenClawAgentWriteAdmission(
              { agentId: "main", path: database.path, env },
              write,
            );
          }
          return readEntries(inputs, consume, {
            ...options,
            onReadAdmitted() {
              options?.onReadAdmitted?.();
              if (timing === "during" || timing === "repeated") {
                write();
              }
            },
          });
        });
      let consumptions = 0;
      try {
        const reading = withGatewaySessionStoreTarget(
          { cfg, key, env, includeMembership: true },
          (target, membership, assertCurrent) => {
            consumptions += 1;
            if (timing === "consume") {
              database.db
                .prepare(
                  "UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?",
                )
                .run(key);
            }
            assertCurrent();
            expect(target.store[key]?.sessionId).toBe("same-session");
            return membership
              .get(key)
              ?.map((member) => member.identityId)
              .toSorted();
          },
        );
        if (timing === "repeated" || timing === "consume") {
          await expect(reading).rejects.toThrow("Session entry changed during read");
          expect(reads).toBe(timing === "repeated" ? 2 : 1);
          expect(consumptions).toBe(timing === "consume" ? 1 : 0);
        } else {
          expect(await reading).toEqual(committedMembers.toSorted());
          expect(reads).toBe(timing === "during" ? 2 : 1);
          expect(consumptions).toBe(1);
        }
      } finally {
        read.mockRestore();
      }
    });
  },
);
