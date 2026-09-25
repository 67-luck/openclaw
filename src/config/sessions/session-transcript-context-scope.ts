import type { AgentMessage } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { markSessionHistoryPrelude } from "../../../packages/agent-core/src/harness/session/session.js";
import type { SessionMetadataWorkerOperations } from "../../agents/sessions/session-manager-metadata-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { assertSyncTransactionResult } from "../../infra/sqlite-transaction.js";
import { createSqliteWorkerHostScope } from "../../infra/sqlite-worker-scoped-operation.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";
import {
  captureSessionTranscriptReadExecution,
  retainSessionTranscriptReadScope,
} from "./session-transcript-execution.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { sessionTranscriptExecution } from "./transcript-target-binding.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

type SessionTranscriptContextOpening = {
  header: unknown;
  version: SessionTranscriptContextVersion;
};
export type SessionTranscriptContextNext =
  | { done: true }
  | { done: false; value: AgentMessage; historyPrelude: boolean };

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);

/** User code stays on this caller stack; only one lazy cursor request is in flight. */
export function readSessionTranscriptContextInExecution<T>(
  captured: NonNullable<ReturnType<typeof captureSessionTranscriptReadExecution>>,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
): T {
  let result: { value: T } | undefined;
  let entered = false;
  const continuation = createSqliteWorkerHostScope((step, scope) => {
    if (
      step.kind !== "session-context" ||
      entered ||
      !isRecord(step.value) ||
      !isRecord(step.value.version)
    ) {
      throw new Error("Session context handoff differs from its retained read");
    }
    entered = true;
    captured.execution.assertCurrent();
    // SAFETY: The paired canonical cursor supplies this opening-snapshot envelope.
    const opening = step.value as SessionTranscriptContextOpening;
    let done = false;
    let returned = false;
    const cursor: IterableIterator<AgentMessage> = {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        if (done) {
          return { done: true, value: undefined };
        }
        captured.execution.assertCurrent();
        // SAFETY: The original scope and single request sequence bind this lazy row.
        const reply = scope.call({ kind: "next" }) as SessionTranscriptContextNext;
        if (reply.done) {
          done = true;
          return { done: true, value: undefined };
        }
        return {
          done: false,
          value: reply.historyPrelude ? markSessionHistoryPrelude(reply.value) : reply.value,
        };
      },
      return() {
        done = true;
        if (!returned) {
          returned = true;
          scope.call({ kind: "return" });
        }
        return { done: true, value: undefined };
      },
    };
    try {
      const value = read(cursor, opening.header, opening.version);
      assertSyncTransactionResult(value);
      result = { value };
    } finally {
      // Closing the cursor does not end the snapshot; the host driver sends finish
      // only after the callback returns or throws, preserving caught cursor errors.
      cursor.return?.();
    }
    return undefined;
  }, captured.execution.incarnation);
  const receipt = resolveSessionTranscriptReadFence(captured.scope);
  let owner: ReturnType<typeof retainSessionTranscriptReadScope>;
  try {
    owner = retainSessionTranscriptReadScope(
      captured.execution,
      () => captured.execution.assertCurrent(),
      continuation,
    );
  } catch (error) {
    continuation.close();
    throw error;
  }
  const { env: _env, ...scope } = captured.scope;
  // The execution capability is host-local; the original admission transfers the scope port.
  Reflect.deleteProperty(scope, sessionTranscriptExecution);
  try {
    const value = owner.executeReady(
      owner.command(moduleUrl, {
        type: "session.metadata.context",
        input: { scope, admission: receipt ? { ...receipt } : undefined },
      }),
    );
    captured.execution.assertCurrent();
    if (value === undefined) {
      return read([], undefined);
    }
    // SAFETY: This static domain owns the context command and its small terminal result.
    const reply = value as SessionMetadataWorkerOperations["session.metadata.context"]["output"];
    if (!reply.ok) {
      throw new SessionTranscriptWriterClaimReboundError(reply.refusal);
    }
    if (!reply.value) {
      return read([], undefined);
    }
    if (!result) {
      throw new Error("Session context completed without its original caller result");
    }
    return result.value;
  } catch (error) {
    const original = continuation.restoreHostFailure(error, owner.nativeSettlement);
    if (original) {
      throw original.error;
    }
    throw error;
  } finally {
    // UNKNOWN keeps the retained read/child custody until the original actor actually joins.
    void owner.close().catch(() => undefined);
  }
}
