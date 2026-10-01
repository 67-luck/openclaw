import type { OpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import type {
  SessionControllerLifecycle,
  SessionEffectRef,
} from "./session-controller.lifecycle.types.js";
import type { SessionControllerMailbox } from "./session-controller.mailbox.js";
import type { SessionTarget } from "./session-controller.target.js";

export type ReplyRunWaiter = {
  finish: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

export type ReplyRunAdmissionSource = {
  sessionId: string;
  sessionIds: Set<string>;
  operation: ReplyOperation;
  databaseIdentity?: OpenClawAgentDatabaseIdentity;
};

export type ReplyRunCompletionObservation = {
  changed: boolean;
  sources: Map<OpenClawAgentDatabaseIdentity | undefined, ReplyRunAdmissionSource>;
};

export type ReplyRunAdmissionBarrier = {
  settled: Promise<void>;
  source: ReplyRunAdmissionSource;
  sources: Map<OpenClawAgentDatabaseIdentity | undefined, ReplyRunAdmissionSource>;
};

export type ReplyOperationAdmission = {
  lease?: SessionEffectRef;
  readonly databaseIdentity?: OpenClawAgentDatabaseIdentity;
};

/** One retained scheduling owner per canonical key. Native attempts are subordinate
 * to active; waiters, fences and completion observations belong to this same entry.
 * Mailbox and mutation scheduling extend this entry, never a second keyed registry. */
export type SessionControllerEntry = {
  readonly id: string;
  readonly key: string;
  target?: SessionTarget;
  aliases: Set<string>;
  logicalAliases: Set<string>;
  mailbox?: SessionControllerMailbox;
  lifecycle?: SessionControllerLifecycle;
  active?: ReplyOperation;
  nativeAttempt?: {
    operation: ReplyOperation;
    projectSessionActive?: boolean;
    handle: import("../agents/embedded-agent-runner/run-state.js").EmbeddedAgentQueueHandle;
  };
  sourceTurnId?: string;
  waiters: Set<ReplyRunWaiter>;
  followupBarrier?: ReplyRunAdmissionBarrier;
  successorBarrier?: ReplyRunAdmissionBarrier;
  observations: Set<ReplyRunCompletionObservation>;
};

export type ReplyOperationAfterClear = {
  callbacks: Set<(sessionId: string) => void>;
  barrier?: ReplyRunAdmissionBarrier;
};
export type ReplyOperationSuccessorBarrierGroup = {
  registrationKey: string;
  sources: Map<string, ReplyRunAdmissionSource>;
};
