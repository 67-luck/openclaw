import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current-runtime.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
} from "../../../config/sessions/session-entry-current.types.js";
import {
  withSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoresInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "../../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";

export type NativeSessionBindingRead = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};

export type NativeSessionBindingLineage = {
  read: NativeSessionBindingRead;
  sessionId: string;
  previousSessionId?: string;
  createSupersededError: (sessionId: string) => Error;
};

/** A fresh lineage read owns custody only through the synchronous effect admission. */
export type NativeSessionBindingWithCurrent = <T>(consume: () => T) => Promise<T>;
export type NativeSessionBindingAuthority = {
  readonly lineage: readonly NativeSessionBindingLineage[];
  /** Cancellation and lifecycle only; durable authority is acquired through withCurrent. */
  assertCurrent: () => void;
  /** For shipped synchronous capabilities that cannot await worker admission. */
  assertLegacyCurrent: () => void;
  withCurrent: NativeSessionBindingWithCurrent;
  prepareMutation: () => Promise<{
    assertCurrent: () => void;
    sessionEntryCurrent?: SessionEntryCurrentCheck;
  }>;
};

export function readNativeSessionBindingEntries<T>(
  reads: readonly NativeSessionBindingRead[],
  consume: (entries: readonly (SessionEntry | undefined)[]) => T,
): Promise<T> {
  const sameRead = (left: NativeSessionBindingRead, right: NativeSessionBindingRead) =>
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey &&
    left.storePath === right.storePath &&
    left.env === right.env;
  // Share row observations, not lineage assertions or their lifecycle guards.
  const unique = reads.filter(
    (read, index) => reads.findIndex((candidate) => sameRead(candidate, read)) === index,
  );
  const durable = unique.filter((read) => !isIncognitoSessionKey(read.sessionKey));
  return withSessionEntriesFromStoresInWorker(
    durable.map((read) => ({
      ...read,
      sessionKeys: [
        ...new Set([
          normalizeStoreSessionKey(read.sessionKey),
          ...collectSessionEntryLookupKeys(read.sessionKey),
        ]),
      ],
    })),
    (prepared) => {
      const entries = unique.map((read) => {
        const index = durable.indexOf(read);
        // Process-owned incognito handles cannot be reopened in a durable reader worker.
        return index < 0
          ? loadSessionEntryReadOnly({
              ...read,
              readConsistency: "latest",
              hydrateSkillPromptRefs: false,
            })
          : resolveSessionEntryCandidates({
              entries: prepared[index]?.result.entries ?? [],
              sessionKey: read.sessionKey,
              canonicalKeys: true,
            }).existing?.entry;
      });
      for (const read of prepared) {
        read.assertCurrent();
      }
      return consume(
        reads.map((read) => entries[unique.findIndex((candidate) => sameRead(candidate, read))]),
      );
    },
    { ordered: true },
  );
}

export function createNativeSessionBindingAuthority(
  lineage: readonly NativeSessionBindingLineage[],
  assertCurrent: () => void,
): NativeSessionBindingAuthority {
  const assertEntry = (
    expected: NativeSessionBindingLineage,
    entry:
      | Pick<SessionEntry, "sessionId" | "previousSessionId">
      | SessionEntryCurrentFacts
      | undefined,
  ) => {
    if (
      !entry ||
      entry.sessionId !== expected.sessionId ||
      entry.previousSessionId !== expected.previousSessionId
    ) {
      throw expected.createSupersededError(expected.sessionId);
    }
  };
  return {
    lineage,
    assertCurrent,
    withCurrent: async (consume) => {
      assertCurrent();
      return readNativeSessionBindingEntries(
        lineage.map(({ read }) => read),
        (entries) => {
          assertCurrent();
          lineage.forEach((expected, index) => assertEntry(expected, entries[index]));
          return consume();
        },
      );
    },
    prepareMutation: async () => {
      assertCurrent();
      let restriction: SessionEntryCurrentCheck | undefined;
      const nativeChecks: Array<() => void> = [];
      for (const expected of lineage) {
        await withSessionEntryReadOnlyInWorker(
          expected.read,
          assertCurrent,
          async (read, owner) => {
            if (!read.ok) {
              throw expected.createSupersededError(expected.sessionId);
            }
            assertEntry(expected, read.value);
            const captured = captureSessionEntryCurrentRead(expected.read, owner);
            if (captured.kind !== "file") {
              nativeChecks.push(() => assertEntry(expected, captured.readCurrent()));
              return;
            }
            const next: SessionEntryCurrentCheck = {
              source: captured.source,
              assertCurrent: (facts) => {
                captured.assertSourceCurrent();
                assertEntry(expected, facts);
              },
            };
            restriction = restriction
              ? { ...restriction, additional: [...(restriction.additional ?? []), next] }
              : next;
          },
        );
      }
      const assertMutationCurrent = () => {
        assertCurrent();
        for (const check of nativeChecks) {
          check();
        }
      };
      assertMutationCurrent();
      return { assertCurrent: assertMutationCurrent, sessionEntryCurrent: restriction };
    },
    assertLegacyCurrent: () => {
      assertCurrent();
      for (const expected of lineage) {
        let entry: SessionEntry | undefined;
        try {
          entry = loadSessionEntryReadOnly({
            ...expected.read,
            readConsistency: "latest",
            hydrateSkillPromptRefs: false,
          });
        } catch {
          throw expected.createSupersededError(expected.sessionId);
        }
        assertEntry(expected, entry);
      }
    },
  };
}

/** Batch every owner into one retained read rather than nesting writer admissions. */
export function combineNativeSessionBindingAuthority(
  ...authorities: readonly (NativeSessionBindingAuthority | undefined)[]
): NativeSessionBindingAuthority {
  const present = [...new Set(authorities.filter((authority) => authority !== undefined))];
  if (present.length === 1) {
    return present[0]!;
  }
  return createNativeSessionBindingAuthority(
    present.flatMap(({ lineage }) => lineage),
    () => {
      for (const authority of present) {
        authority.assertCurrent();
      }
    },
  );
}
