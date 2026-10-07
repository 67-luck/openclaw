import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import type { SessionExactEntriesWorkerResult } from "../config/sessions/session-entry-read.types.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
import {
  readSessionMessagesMatchingIdAsync,
  readSessionMessagesWithSourceAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";
import { iterateSessionTranscriptSourcePages } from "./session-transcript-source-pages.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

/** Serving keeps discovery and physical readers alive through response publication. */
export async function withManagedImageSessionRead<T>(
  params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    stateDir: string;
    assertCurrent: () => void;
    purpose?: "cleanup";
    onMissing?: () => T;
  },
  consume: (scope: SessionTranscriptReadScope, assertCurrent: () => void) => Promise<T>,
): Promise<T | null> {
  const { cfg, sessionKey, agentId, stateDir } = params;
  params.assertCurrent();
  const { candidates, ...prepared } = prepareSessionStoreTargetInventory(cfg, [agentId], {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  const inventoryRead = prepareSessionStoreTargetInventoryRead({ ...prepared, candidates });
  const assertSelectionCurrent = () => {
    params.assertCurrent();
    for (const candidate of candidates) {
      if (
        captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
        candidate.physicalPath
      ) {
        throw new Error("Managed media session store changed during read");
      }
    }
  };
  return inventoryRead.withRead(async (inventory, assertDiscoveryCurrent) => {
    const source = inventory.agents[0];
    if (!source?.result.available) {
      return null;
    }
    return withSessionHistoryWorkerDatabases(
      source.reads.map(({ database }) => ({ ...database, env: prepared.env })),
      async (readers) => {
        const identities = new Map<string, string>();
        const assertCurrent = () => {
          assertDiscoveryCurrent();
          for (const reader of readers) {
            reader.assertCurrent();
          }
          for (const [pathname, identity] of identities) {
            assertExistingDatabaseIdentity(pathname, identity);
          }
        };
        let matched: SessionTranscriptReadScope | undefined;
        for (const [index, { database }] of source.reads.entries()) {
          const scope = {
            agentId,
            databaseAgentId: database.agentId,
            storePath: database.path,
            env: prepared.env,
            sessionKey,
          };
          const reader = readers[index]!;
          let exact: SessionExactEntriesWorkerResult;
          try {
            exact = await reader.readExactEntries({
              sessionKeys: [sessionKey],
              projection: params.purpose === "cleanup" ? "exact" : "sharing",
              ...(params.purpose === "cleanup" ? { snapshotFields: [] } : {}),
              env: prepared.env,
            });
          } catch (error) {
            assertCurrent();
            if (
              extractErrorCode(error) === "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" ||
              (error instanceof SessionMetadataUnavailableError &&
                error.reason === "schema-missing")
            ) {
              return null;
            }
            throw error;
          }
          if (exact.sharing) {
            identities.set(database.path, exact.sharing.databaseIdentity);
          }
          assertCurrent();
          if (exact.sharing?.placeholders.length) {
            return null;
          }
          let entry = exact.entries[0]?.entry;
          if (!entry) {
            const read = await reader.readEntryResult({ scope });
            assertCurrent();
            if (!read.ok) {
              return null;
            }
            entry = read.value;
          }
          if (entry) {
            if (matched) {
              return null;
            }
            matched = { ...scope, sessionEntry: entry, sessionId: entry.sessionId };
          }
        }
        if (matched) {
          return consume(matched, assertCurrent);
        }
        if (path.resolve(stateDir) !== path.resolve(resolveStateDir())) {
          return params.onMissing?.() ?? null;
        }
        const fallback = await resolveGatewaySessionStoreTargetInWorker({
          cfg: prepared.config,
          key: sessionKey,
          agentId,
          env: prepared.env,
          assertActive: assertCurrent,
        });
        assertCurrent();
        if (!fallback.readSource) {
          return null;
        }
        const database = fallback.readSource;
        return withSessionHistoryWorkerDatabases(
          [{ ...database, env: prepared.env }],
          async ([reader]) => {
            const scope = {
              agentId,
              databaseAgentId: database.agentId,
              sessionKey: fallback.canonicalKey,
              storePath: database.path,
              env: prepared.env,
            };
            const read = await reader!.readEntryResult({ scope });
            const assertFallbackCurrent = () => {
              assertCurrent();
              reader!.assertCurrent();
            };
            assertFallbackCurrent();
            if (!read.ok) {
              return null;
            }
            if (!read.value) {
              return params.onMissing?.() ?? null;
            }
            return consume(
              {
                ...scope,
                sessionKey,
                sessionId: read.value.sessionId,
                sessionEntry: read.value,
              },
              assertFallbackCurrent,
            );
          },
        );
      },
    );
  }, assertSelectionCurrent);
}

/** Cleanup includes off-path branches because rewind can expose their attachments again. */
export async function readManagedImageSessionIndex(
  scope: SessionTranscriptReadScope,
  messageId: string | undefined,
  collectKeys: (messageId: string, content: readonly Record<string, unknown>[]) => Iterable<string>,
  assertCurrent: () => void,
): Promise<Set<string>> {
  const pages =
    messageId === undefined
      ? iterateSessionTranscriptSourcePages(readSessionMessagesWithSourceAsync, scope, {
          allowResetArchiveFallback: true,
          includeOffPathMessages: true,
        })
      : [{ messages: await readSessionMessagesMatchingIdAsync(scope, messageId) }];
  const index = new Set<string>();
  for await (const { messages } of pages) {
    assertCurrent();
    for (const message of messages) {
      const messageId = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
      if (typeof messageId !== "string" || !messageId) {
        continue;
      }
      for (const key of collectKeys(messageId, readAssistantDisplayContent(message))) {
        index.add(key);
      }
    }
  }
  assertCurrent();
  return index;
}
