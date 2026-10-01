import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { walkMatrixStateFiles } from "./state-layout-walk.js";
import type { MatrixThreadBindingRecord } from "./thread-bindings-shared.js";
import {
  buildThreadBindingStoreKey,
  openMatrixThreadBindingStoreOptions,
} from "./thread-bindings-store.js";

const FILENAME = "thread-bindings.json";
type ThreadBindingMigrationReceipt = { importedAt: number } | { sourceSha256: string };

async function collectSources(stateDir: string): Promise<string[]> {
  const { entries, failedDirs } = await walkMatrixStateFiles(
    stateDir,
    (name, depth) => name === FILENAME && (depth === 2 || depth === 4),
  );
  if (failedDirs.length > 0) {
    throw failedDirs[0]!.error;
  }
  return entries.map((entry) => entry.path).toSorted();
}

function normalizeBindingRecord(
  entry: unknown,
  pathAccountId: string | undefined,
): MatrixThreadBindingRecord {
  if (!isRecord(entry)) {
    throw new Error("Invalid Matrix thread binding record");
  }
  const accountId = normalizeOptionalString(entry.accountId) ?? pathAccountId;
  const conversationId = normalizeOptionalString(entry.conversationId);
  const parentConversationId = normalizeOptionalString(entry.parentConversationId);
  const targetSessionKey = normalizeOptionalString(entry.targetSessionKey);
  if (
    !accountId ||
    !conversationId ||
    !targetSessionKey ||
    (pathAccountId && accountId !== pathAccountId)
  ) {
    throw new Error(
      "Matrix thread binding has missing or conflicting account/conversation identity",
    );
  }
  const boundAt =
    typeof entry.boundAt === "number" && Number.isFinite(entry.boundAt)
      ? Math.floor(entry.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof entry.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
      ? Math.floor(entry.lastActivityAt)
      : boundAt;
  const agentId = normalizeOptionalString(entry.agentId);
  const label = normalizeOptionalString(entry.label);
  const boundBy = normalizeOptionalString(entry.boundBy);
  return {
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
    targetKind: entry.targetKind === "subagent" ? "subagent" : "acp",
    targetSessionKey,
    ...(agentId ? { agentId } : {}),
    ...(label ? { label } : {}),
    ...(boundBy ? { boundBy } : {}),
    boundAt,
    lastActivityAt: Math.max(lastActivityAt, boundAt),
    ...(typeof entry.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)
      ? { idleTimeoutMs: Math.max(0, Math.floor(entry.idleTimeoutMs)) }
      : {}),
    ...(typeof entry.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)
      ? { maxAgeMs: Math.max(0, Math.floor(entry.maxAgeMs)) }
      : {}),
  };
}

function importKey(accountId: string, sourcePath: string): string {
  const digest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(sourcePath)
    .digest("hex");
  return `${accountId}:${digest}`;
}

export const matrixThreadBindingsMigration: PluginDoctorStateMigration = {
  id: "matrix-thread-bindings-json-to-plugin-state",
  label: "Matrix thread bindings",
  async collectBackupResources({ stateDir }) {
    return (await collectSources(stateDir)).flatMap((sourcePath) => [
      { path: sourcePath, kind: "file" as const },
      {
        path: path.join(path.dirname(sourcePath), "state", "openclaw.sqlite"),
        kind: "sqlite" as const,
      },
    ]);
  },
  async detectLegacyState({ stateDir }) {
    const sources = await collectSources(stateDir);
    return sources.length > 0
      ? {
          preview: sources.map(
            (source) => `Matrix thread binding JSON can migrate to SQLite: ${source}`,
          ),
        }
      : null;
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const sourcePath of await collectSources(params.stateDir)) {
      try {
        const sourceBytes = await fs.readFile(sourcePath);
        const value: unknown = JSON.parse(sourceBytes.toString("utf8"));
        if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bindings)) {
          throw new Error("Expected Matrix thread bindings version 1");
        }
        const parts = path
          .relative(path.join(params.stateDir, "matrix"), sourcePath)
          .split(path.sep);
        const pathAccountId = parts[0] === "accounts" ? parts[1] : undefined;
        const records = [
          ...new Map(
            value.bindings.map((entry) => {
              const record = normalizeBindingRecord(entry, pathAccountId);
              return [buildThreadBindingStoreKey(record), record] as const;
            }),
          ).values(),
        ];
        const env = { ...params.env, OPENCLAW_STATE_DIR: path.dirname(sourcePath) };
        const bindingOptions = openMatrixThreadBindingStoreOptions(env);
        const store = params.context.openPluginStateKeyedStore<MatrixThreadBindingRecord>({
          ...bindingOptions,
          overflowPolicy: "reject-new",
        });
        const markers = params.context.openPluginStateKeyedStore<ThreadBindingMigrationReceipt>({
          namespace: "thread-bindings-migrations",
          maxEntries: bindingOptions.maxEntries + 1,
          overflowPolicy: "reject-new",
          env,
        });
        const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
        const sourceClaimKey = `source:${createHash("sha256").update(sourcePath).digest("hex")}`;
        // Bind retries before the first row write, including uncertain or partial writes.
        await markers.registerIfAbsent(sourceClaimKey, { sourceSha256 });
        const sourceClaim = await markers.lookup(sourceClaimKey);
        if (
          !sourceClaim ||
          !("sourceSha256" in sourceClaim) ||
          sourceClaim.sourceSha256 !== sourceSha256
        ) {
          throw new Error(
            "Matrix thread binding source changed after import began. Restore its pre-migration backup before retrying, or resolve the changed bindings in canonical state before retiring the source",
          );
        }
        const pendingAccounts = new Set<string>();
        for (const accountId of new Set(records.map((record) => record.accountId))) {
          // Released runtimes recorded completion before deleting JSON; preserve later unbinds.
          if (!(await markers.lookup(importKey(accountId, sourcePath)))) {
            pendingAccounts.add(accountId);
          }
        }
        let imported = 0;
        for (const record of records) {
          if (!pendingAccounts.has(record.accountId)) {
            continue;
          }
          const key = buildThreadBindingStoreKey(record);
          const current = await store.lookup(key);
          if (current !== undefined) {
            continue;
          }
          const inserted = await store.registerIfAbsent(key, record);
          const persisted = await store.lookup(key);
          if (persisted === undefined || (inserted && !isDeepStrictEqual(persisted, record))) {
            throw new Error(`Failed verifying imported Matrix thread binding ${key}`);
          }
          imported += Number(inserted);
        }
        if (imported > 0) {
          changes.push(
            `Migrated ${imported} Matrix thread bindings to SQLite for ${path.dirname(sourcePath)}`,
          );
        }
        await archiveLegacyStateSource({
          filePath: sourcePath,
          label: "Matrix thread bindings",
          changes,
          warnings,
          verifiedCompletion: {
            expectedBytes: sourceBytes,
            complete: async () => {
              for (const accountId of pendingAccounts) {
                await markers.registerIfAbsent(importKey(accountId, sourcePath), {
                  importedAt: Date.now(),
                });
              }
            },
          },
        });
      } catch (error) {
        warnings.push(
          `Failed migrating Matrix thread bindings ${sourcePath}: ${String(error)}; left source in place. Run openclaw doctor --fix after resolving the failure.`,
        );
      }
    }
    return { changes, warnings };
  },
};
