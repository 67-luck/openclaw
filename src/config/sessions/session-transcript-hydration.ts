import type { DatabaseSync } from "node:sqlite";
import type { SessionMetadataWorkerOperations } from "../../agents/sessions/session-manager-metadata-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { assertAgentDatabaseTerminalOpenAllowed } from "../../state/openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readSessionTranscriptCurrentTurnEntry } from "./session-accessor.sqlite-current-turn.js";
import { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import {
  captureSessionTranscriptExecution,
  retainSessionTranscriptInitialization,
  retainSessionTranscriptRead,
} from "./session-transcript-execution.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import {
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionHistoryWorkerDatabase,
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptCurrentTurnEntryRequest,
} from "./session-transcript-worker.types.js";
import {
  captureSessionTranscriptTargetBinding,
  sessionTranscriptExecution,
} from "./transcript-target-binding.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

const metadataModule = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);

/** Capture identity before queueing; a missing file remains the creation owner's responsibility. */
export function prepareSessionTranscriptHydration(
  source: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv },
  limits?: { maxBytes: number; maxEvents: number },
  signal?: AbortSignal,
) {
  const target = captureSessionTranscriptExecution(captureSessionTranscriptTargetBinding(source));
  const binding = target[sessionTranscriptExecution];
  const contextLimits = limits
    ? { maxBytes: limits.maxBytes, maxEvents: limits.maxEvents }
    : undefined;
  const receipt = resolveSessionTranscriptReadFence(target);
  const admission = receipt ? { ...receipt } : undefined;
  signal?.throwIfAborted();
  const incognitoOptions =
    !binding && isIncognitoSessionKey(target.sessionKey)
      ? toDatabaseOptions(resolveSqliteTranscriptReadScope(target))
      : undefined;
  const incognitoOwner = incognitoOptions
    ? getOpenClawAgentDatabaseIfOpen(incognitoOptions)
    : undefined;
  const assertCurrent = () => {
    if (binding) {
      binding.execution.assertCurrent();
      return;
    }
    if (incognitoOptions && getOpenClawAgentDatabaseIfOpen(incognitoOptions) !== incognitoOwner) {
      throw new Error("Session transcript incognito database owner is no longer current");
    }
  };
  const readLogical = <
    K extends
      | "session.metadata.read"
      | "session.metadata.currentTurn"
      | "session.metadata.modelContext"
      | "session.metadata.validateContext"
      | "session.metadata.activeAnchor",
  >(
    type: K,
    input: Omit<SessionMetadataWorkerOperations[K]["input"], "scope">,
    initialize = false,
  ) => {
    signal?.throwIfAborted();
    const owner = initialize
      ? retainSessionTranscriptInitialization(target, assertCurrent)
      : retainSessionTranscriptRead(target, assertCurrent);
    const { env: _env, [sessionTranscriptExecution]: _execution, ...scope } = target;
    const command = owner.command(metadataModule, { type, input: { ...input, scope } });
    const receive = (result: unknown) => {
      assertCurrent();
      signal?.throwIfAborted();
      if (result === undefined) {
        throw new SessionTranscriptStorageUnavailableError();
      }
      // SAFETY: The retained static metadata domain owns this paired result union.
      const reply = result as SessionMetadataWorkerOperations[K]["output"];
      if (!reply.ok) {
        throw new SessionTranscriptWriterClaimReboundError(reply.refusal);
      }
      return reply.value;
    };
    return {
      async read() {
        try {
          return receive(await owner.execute(command, { signal }));
        } finally {
          await owner.close();
        }
      },
      readReady() {
        try {
          return receive(owner.executeReady(command));
        } finally {
          void owner.close().catch(() => undefined);
        }
      },
    };
  };
  const readInOwner = async <T>(
    readInProcess: () => T,
    readInWorker: (
      owner: SessionHistoryWorkerDatabase,
      resolvedScope: ResolvedTranscriptReadScope,
    ) => Promise<T>,
  ): Promise<T> => {
    signal?.throwIfAborted();
    // Incognito SQLite belongs to this process; never substitute another memory database.
    if (incognitoOptions) {
      return runWithSessionTranscriptReadFence(admission, readInProcess);
    }
    const resolvedScope = await prepareSqliteTranscriptReadScope(target, signal);
    signal?.throwIfAborted();
    const options = toDatabaseOptions(resolvedScope);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    assertAgentDatabaseTerminalOpenAllowed(databasePath);
    try {
      const result = await withSessionHistoryWorkerDatabase(options, async (owner) => {
        try {
          return await readInWorker(owner, resolvedScope);
        } finally {
          // An absent-store reply must not hide a revoked read owner.
          owner.assertCurrent();
        }
      });
      signal?.throwIfAborted();
      return result;
    } finally {
      assertAgentDatabaseTerminalOpenAllowed(databasePath);
    }
  };
  const read = (): Promise<PreparedSessionTranscriptHydration> =>
    binding
      ? readLogical("session.metadata.read", { limits: contextLimits, admission }).read()
      : readInOwner<PreparedSessionTranscriptHydration>(
          () =>
            contextLimits
              ? {
                  kind: "bounded",
                  snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
                    ...contextLimits,
                    readOnly: true,
                  }),
                }
              : {
                  kind: "full",
                  snapshot: loadTranscriptReadSnapshotSync(target, { readOnly: true }),
                },
          (owner, resolvedScope) =>
            owner.readTranscript(
              { target, resolvedScope, limits: contextLimits, admission },
              signal,
            ),
        );
  const readCurrentTurnEntry = (
    input: SessionTranscriptCurrentTurnEntryRequest,
  ): Promise<SessionTranscriptCurrentTurnEntryRead> => {
    const request = {
      entryId: input.entryId,
      version: { ...input.version },
      includeEntry: input.includeEntry,
    };
    if (binding) {
      return readLogical("session.metadata.currentTurn", { request, admission }).read();
    }
    return readInOwner(
      () => readSessionTranscriptCurrentTurnEntry(target, { ...request, readOnly: true }),
      (owner, resolvedScope) =>
        owner.readCurrentTurnEntry({ ...request, target, resolvedScope, admission }, signal),
    );
  };
  const readCurrentTurnEntryReady = (
    input: SessionTranscriptCurrentTurnEntryRequest,
  ): SessionTranscriptCurrentTurnEntryRead => {
    const request = {
      entryId: input.entryId,
      version: { ...input.version },
      includeEntry: input.includeEntry,
    };
    assertCurrent();
    return binding
      ? readLogical("session.metadata.currentTurn", { request, admission }).readReady()
      : runWithSessionTranscriptReadFence(admission, () =>
          readSessionTranscriptCurrentTurnEntry(target, { ...request, readOnly: true }),
        );
  };
  const readReady = (
    onRead?: (database: DatabaseSync) => void,
  ): PreparedSessionTranscriptHydration => {
    assertCurrent();
    if (binding) {
      return readLogical("session.metadata.read", { limits: contextLimits, admission }).readReady();
    }
    return runWithSessionTranscriptReadFence(admission, () =>
      contextLimits
        ? {
            kind: "bounded",
            snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
              ...contextLimits,
              onRead,
            }),
          }
        : { kind: "full", snapshot: loadTranscriptReadSnapshotSync(target, { onRead }) },
    );
  };
  const initializeReady = (
    onRead?: (database: DatabaseSync) => void,
  ): PreparedSessionTranscriptHydration =>
    binding
      ? readLogical("session.metadata.read", { limits: contextLimits, admission }, true).readReady()
      : readReady(onRead);
  const readModelContext = (
    input: Omit<
      SessionMetadataWorkerOperations["session.metadata.modelContext"]["input"],
      "scope" | "admission"
    >,
  ) => {
    const request = { ...structuredClone(input), admission };
    return readLogical("session.metadata.modelContext", request);
  };
  const validateModelContext = (
    input: Omit<
      SessionMetadataWorkerOperations["session.metadata.validateContext"]["input"],
      "scope" | "admission"
    >,
  ) =>
    readLogical("session.metadata.validateContext", {
      ...structuredClone(input),
      admission,
    }).readReady();
  const readActiveAnchorReady = (entryId: string) =>
    binding
      ? readLogical("session.metadata.activeAnchor", { entryId }).readReady()
      : readActiveTranscriptEntryAnchor({ ...target, entryId });
  return {
    target,
    read,
    readReady,
    initializeReady,
    readCurrentTurnEntry,
    readCurrentTurnEntryReady,
    readModelContext,
    validateModelContext,
    readActiveAnchorReady,
    assertCurrent,
  };
}
