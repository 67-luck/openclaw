import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("lifecycle entry isolation", () => {
  const fixture = useTempSessionsFixture("openclaw-lifecycle-isolation-");
  it("isolates lifecycle builders and retained outputs across repeated-key upserts", async () => {
    const scope = { sessionKey: "agent:main:lifecycle-isolation", storePath: fixture.storePath() };
    await upsertSessionEntryCore(scope, {
      sessionId: "lifecycle-isolation",
      updatedAt: 10,
      skillsSnapshot: { prompt: "stored prompt", skills: [] },
    });
    let retained: SessionEntry | undefined;
    await applySessionEntryLifecycleMutation({
      storePath: fixture.storePath(),
      skipMaintenance: true,
      upserts: [
        {
          sessionKey: scope.sessionKey,
          buildEntry: ({ currentEntry }) => {
            const entry = expectDefined(currentEntry, "first lifecycle builder input");
            const skills = expectDefined(entry.skillsSnapshot, "first lifecycle skills");
            skills.prompt = "first prompt";
            retained = entry;
            return entry;
          },
        },
        {
          sessionKey: scope.sessionKey,
          buildEntry: ({ currentEntry }) => {
            const entry = expectDefined(currentEntry, "second lifecycle builder input");
            const skills = expectDefined(entry.skillsSnapshot, "second lifecycle skills");
            expectDefined(retained?.skillsSnapshot, "retained lifecycle skills").prompt =
              "changed after return";
            expect(skills.prompt).toBe("first prompt");
            skills.prompt = "second prompt";
            return entry;
          },
        },
      ],
    });
    expect(loadSessionEntry(scope)?.skillsSnapshot?.prompt).toBe("second prompt");
  });

  it("retains lifecycle expectations when canonical repair normalizes an earlier same-key upsert", async () => {
    const scope = { sessionKey: "agent:main:lifecycle-repair", storePath: fixture.storePath() };
    await upsertSessionEntryCore(scope, { sessionId: "lifecycle-repair", updatedAt: 10 });
    const original = expectDefined(loadSessionEntry(scope), "original lifecycle entry");
    await expect(
      applySessionEntryLifecycleMutation({
        storePath: fixture.storePath(),
        skipMaintenance: true,
        allowCanonicalRepair: true,
        upserts: [
          {
            sessionKey: scope.sessionKey,
            entry: {
              ...original,
              publicShare: { id: "a".repeat(48), sessionId: "other-generation", createdAt: 1 },
            },
          },
          { sessionKey: scope.sessionKey, entry: { ...original, label: "uncommitted" } },
        ],
      }),
    ).rejects.toMatchObject({
      name: "SessionEntryLifecycleUpsertConflictError",
    });
    expect(loadSessionEntry(scope)).toEqual(original);
  });
});
