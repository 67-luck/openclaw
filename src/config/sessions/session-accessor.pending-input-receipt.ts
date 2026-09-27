import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  normalizeMessageClientSources,
  readMessageClientSources,
} from "../../chat/message-client-source.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  captureGatewayPendingInputWorkerAuthority,
  type GatewayPendingInputWorkerAuthority,
} from "../../gateway/server-methods/session-mutation-guards.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  bindSessionPendingInputWorkerOwner,
  completeSessionPendingInputWorkerOwner,
  joinSessionPendingInputWorkerOwner,
  parseSessionPendingInputMessage,
  runWithSessionPendingInput,
  runWithSessionPendingInputPersistence,
} from "./session-accessor.sqlite-pending-inputs.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionPendingInputOwner,
  SessionPendingInputState,
} from "./session-pending-input.types.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

export type SessionPendingInputReceipt = {
  state: "queued" | "consumed";
  inputId: string;
  message: PersistedUserTurnMessage;
  run: <T>(operation: () => T) => T;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  completion?: AgentRunTerminalOutcome;
  complete?: (outcome: AgentRunTerminalOutcome) => AgentRunTerminalOutcome;
};
const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();

export function bindSessionPendingInputWorkerAuthority(
  receipt: SessionPendingInputReceipt,
  authority: GatewayPendingInputWorkerAuthority,
): boolean {
  const captured = captureGatewayPendingInputWorkerAuthority(authority);
  const owner = receiptOwners.get(receipt);
  if (!owner) {
    captured.release();
    return false;
  }
  bindSessionPendingInputWorkerOwner(owner, captured);
  return true;
}

/** Internal callers join worker completion; the native receipt signature stays synchronous. */
export function completeSessionPendingInputReceipt(
  receipt: SessionPendingInputReceipt,
  outcome: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome | Promise<AgentRunTerminalOutcome> | undefined {
  const owner = receiptOwners.get(receipt);
  return (
    (owner && completeSessionPendingInputWorkerOwner(owner, outcome)) ?? receipt.complete?.(outcome)
  );
}

export function joinSessionPendingInputReceipt(
  receipt: SessionPendingInputReceipt,
): Promise<void> | undefined {
  const owner = receiptOwners.get(receipt);
  if (!owner) {
    return undefined;
  }
  const joins = (owner.sources ?? [owner]).flatMap(
    (source) => joinSessionPendingInputWorkerOwner(source) ?? [],
  );
  return joins.length
    ? Promise.allSettled(joins).then((settlements) => {
        const failures = settlements.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Pending input sources did not all settle");
        }
      })
    : undefined;
}

export function createSessionPendingInputReceipt(
  owner: SessionPendingInputOwner,
): SessionPendingInputReceipt {
  const receipt: SessionPendingInputReceipt = {
    get state() {
      return owner.consumed || owner.sources?.every((source) => source.consumed)
        ? "consumed"
        : "queued";
    },
    inputId: owner.inputId,
    message: parseSessionPendingInputMessage(owner.messageJson),
    run: (operation) => runWithSessionPendingInput(owner, operation),
    finish: owner.finish,
  };
  receiptOwners.set(receipt, owner);
  return receipt;
}

/** Install only a private receipt's persistence context; this does not reopen execution authority. */
export function withSessionPendingInputPersistence<T>(
  receipt: SessionPendingInputReceipt,
  persist: () => T,
): T {
  const owner = receiptOwners.get(receipt);
  return owner ? runWithSessionPendingInputPersistence(owner, persist) : receipt.run(persist);
}

/** Bind one collected message to its private admitted sources without creating another durable queue. */
export function bindSessionPendingInputSources(
  receipts: readonly SessionPendingInputReceipt[],
  message: PersistedUserTurnMessage,
): SessionPendingInputReceipt | undefined {
  const sources = [
    ...new Set(
      receipts.flatMap((receipt) => {
        if (receipt.state === "consumed") {
          throw new Error("Collected input has already been consumed");
        }
        const owner = receiptOwners.get(receipt);
        return owner ? (owner.sources ?? [owner]) : [];
      }),
    ),
  ];
  const first = sources[0];
  if (!first) {
    return undefined;
  }
  const idempotencyKey = readMessageIdempotencyKey(message);
  if (
    !idempotencyKey ||
    sources.some(
      (source) =>
        source.databasePath !== first.databasePath ||
        source.sessionId !== first.sessionId ||
        source.sessionKey !== first.sessionKey ||
        source.idempotencyKey === idempotencyKey,
    )
  ) {
    throw new Error("Collected input requires one exact session and a distinct aggregate identity");
  }
  // Collected framing still passes storage redaction; its staged sources have
  // already passed approval and must not run through another plugin hook.
  const clients = normalizeMessageClientSources(
    receipts.flatMap((receipt) => readMessageClientSources(receipt.message)),
  );
  const collectedMessage = { ...message };
  if (clients.length) {
    collectedMessage["__openclaw"] = {
      ...message["__openclaw"],
      transport: { ...asOptionalRecord(message["__openclaw"]?.transport), clients },
    };
  }
  const messageJson = JSON.stringify(
    redactTranscriptMessageForStorage(collectedMessage, { config: sources.at(-1)?.config }),
  );
  if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Collected input exceeds the Gateway payload limit");
  }
  const aggregateInputId = randomUUID();
  return createSessionPendingInputReceipt({
    ...first,
    inputId: aggregateInputId,
    transcriptInputId: aggregateInputId,
    idempotencyKey,
    messageJson,
    sources,
    finish: (disposition) => {
      const failures: unknown[] = [];
      for (const source of sources) {
        try {
          source.finish(disposition);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Failed to finish collected input custody");
      }
    },
  });
}
