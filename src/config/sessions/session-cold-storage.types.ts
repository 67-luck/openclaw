import type { SessionGoalOperation } from "./goals-operations.types.js";
import type {
  SqliteExpectedSessionTranscriptTurnResult,
  SqliteSessionTurnOptions,
} from "./session-turn.types.js";

export type SessionColdMutationResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
  restored: boolean;
  sessionKey?: string;
  turnRebound?: SqliteExpectedSessionTranscriptTurnResult;
};
export type SessionColdTurnGuard = {
  agentId: string;
  sessionKey: string;
  options: Pick<
    SqliteSessionTurnOptions,
    | "keyFormat"
    | "expectedSessionId"
    | "selectedSessionId"
    | "selectedLifecycleRevision"
    | "expectedLifecycleRevision"
    | "expectedWriterRunId"
    | "expectedSessionState"
    | "initialSessionEntry"
  >;
  goalOperation?: SessionGoalOperation;
};
