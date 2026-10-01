import type { Result } from "@openclaw/normalization-core/result";
import { retainSessionTranscriptWrite } from "../../config/sessions/session-transcript-execution.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCallerPublication } from "../../infra/sqlite-worker-host-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import type {
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
} from "./session-manager-metadata-contract.js";

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);
const log = createSubsystemLogger("agents/session-metadata");

export function withReadySessionMetadata<T>(
  target: SessionTranscriptTargetBinding,
  assertCurrent: () => void,
  operation: (scope: {
    readonly tentative: boolean;
    publish(this: void, publish: () => void): void;
    execute<K extends keyof SessionMetadataOperations>(command: {
      type: K;
      input: SessionMetadataOperations[K]["input"];
    }): SessionMetadataOperations[K]["output"];
  }) => T,
): T {
  const retained = retainSessionTranscriptWrite(target, assertCurrent);
  try {
    return operation({
      get tentative() {
        return retained.tentative;
      },
      publish(publish) {
        if (!retained.tentative) {
          publish();
          return;
        }
        if (!deferSqliteWorkerCallerPublication(publish)) {
          throw new Error("Tentative session metadata lost its original transaction");
        }
      },
      execute(command) {
        const value = retained.executeReady(retained.command(moduleUrl, command));
        // SAFETY: this static metadata module owns the paired command and result union.
        const reply = value as SessionMetadataWorkerOperations[typeof command.type]["output"];
        if (!reply?.ok) {
          throw new SessionTranscriptWriterClaimReboundError(reply?.refusal);
        }
        return reply.value;
      },
    });
  } finally {
    // The execution reference retains a timed-out original job until native settlement.
    void retained.close().catch(() => undefined);
  }
}

/** Each command settles and unbinds before the next; the enclosing manager keeps its FIFO turn. */
export async function withSessionMetadataWorker<T>(
  options: OpenClawAgentDatabaseOptions,
  database: OpenClawAgentDatabase,
  assertCurrent: () => void,
  operation: (scope: Pick<SqliteWorkerStore<SessionMetadataOperations>, "execute">) => Promise<T>,
): Promise<T> {
  const worker = await openOpenClawAgentSqliteWorkerStore<SessionMetadataWorkerOperations>(
    options,
    database.db,
    { moduleUrl, input: undefined },
  );
  let result: Result<T, unknown>;
  try {
    const value = await operation({
      execute: async (command, commandOptions) => {
        const reply = await worker.execute(command, assertCurrent, commandOptions);
        if (!reply.ok) {
          throw new SessionTranscriptWriterClaimReboundError(reply.refusal);
        }
        return reply.value;
      },
    });
    result = { ok: true, value };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await worker.close();
  } catch (error) {
    if (!result.ok) {
      throw createSqliteLifecycleAggregateError(
        [result.error, error],
        "Session metadata operation and cleanup failed",
        result.error,
      );
    }
    try {
      log.warn(`Session metadata completed before cleanup failed: ${formatErrorMessage(error)}`);
    } catch {
      // A failed diagnostic cannot erase the completed operation's receipt.
    }
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
