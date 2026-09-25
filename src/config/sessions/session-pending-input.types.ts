import type { Selectable } from "kysely";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { GatewayPendingInputWorkerAuthority } from "../../gateway/server-methods/session-mutation-guards.js";
import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import type { SessionMutationWorkerRead } from "../../gateway/session-sharing-worker-read.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { SessionPendingInputs } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawConfig } from "../types.openclaw.js";

export type SessionPendingInputState = "queued" | "interrupted" | "cancelled";
export type SessionPendingInput = {
  id: string;
  runId: string;
  message: PersistedUserTurnMessage;
  acceptedAt: number;
  state: SessionPendingInputState;
};
export type SessionPendingInputPage = {
  items: SessionPendingInput[];
  total: number;
  nextBefore?: number;
};
export type SessionPendingInputRow = Selectable<SessionPendingInputs>;
export type PendingInputWorkerReservation = {
  owner: SessionPendingInputOwner;
  transaction: object | undefined;
  staged: boolean;
  relocatedInputId: string | undefined;
  previous: PendingInputWorkerReservation | undefined;
};

export type SessionPendingInputOwner = {
  inputId: string;
  transcriptInputId: string;
  sessionId: string;
  sessionKey: string;
  databasePath: string;
  idempotencyKey: string;
  lifecycleGeneration: string;
  messageJson: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  /** Published only after the exact input was consumed by a committed transcript write. */
  consumed?: true;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  restartRecovered?: true;
  /** Aggregate authority is the exact source closures, never persisted source identifiers. */
  sources?: readonly SessionPendingInputOwner[];
  completionScope?: { runId: string; requestHash: string };
  worker?: {
    authority: GatewayPendingInputWorkerAuthority;
    association?: SessionPendingInputWorkerAssociation;
    releaseAssociation?: () => Promise<void>;
    uses: Set<Promise<unknown>>;
    revoked: boolean;
    reservation?: PendingInputWorkerReservation;
    unresolved?: true;
    finish?: Promise<void>;
    completion?: Promise<AgentRunTerminalOutcome>;
  };
};

export type SessionPendingInputTerminalRequest = {
  owner: SessionPendingInputAppendIdentity;
} & (
  | { kind: "finish"; disposition: "cancelled" | "interrupted" }
  | {
      kind: "complete";
      completionScope: { runId: string; requestHash: string };
      outcome: AgentRunTerminalOutcome;
      authorization: SessionMutationWorkerRead;
    }
);

export type SessionPendingInputTerminalResult =
  | { kind: "committed"; outcome?: AgentRunTerminalOutcome; failures: readonly unknown[] }
  | { kind: "not-committed" | "unknown"; error: unknown };

export type SessionPendingInputWorkerAssociation = {
  retain(): () => Promise<void>;
  settle(
    request: SessionPendingInputTerminalRequest,
    authorize: (facts: PreparedSessionMutationFacts) => void,
  ): Promise<SessionPendingInputTerminalResult>;
};

export type SessionPendingInputAppend = {
  inputId: string;
  message: PersistedUserTurnMessage;
  messageJson: string;
  alreadyPromoted: boolean;
  sourceInputIds?: readonly string[];
  stageRelocation?: (destinationInputId: string) => void;
};

export type SessionPendingInputAppendIdentity = Pick<
  SessionPendingInputOwner,
  | "inputId"
  | "transcriptInputId"
  | "sessionId"
  | "sessionKey"
  | "databasePath"
  | "idempotencyKey"
  | "lifecycleGeneration"
  | "messageJson"
> & { sources?: readonly SessionPendingInputAppendIdentity[] };

export type SessionPendingInputWorkerAppend = {
  identity: SessionPendingInputAppendIdentity;
  relocationSourceId?: string;
  authorizations: Array<{ inputId: string; read: SessionMutationWorkerRead }>;
};

export type SessionPendingInputWorkerFacts = {
  requiresCurrent: boolean;
  authorizations: Array<{ inputId: string; facts: PreparedSessionMutationFacts }>;
  consumedInputIds: readonly string[];
  relocatedInputId?: string;
};
