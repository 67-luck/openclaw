import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptMessageAppendResult } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { captureSessionPendingInputWorkerAppend } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { TranscriptWriteSnapshot } from "../../config/sessions/session-accessor.sqlite-transcript-write-guard.js";
import type { SessionPendingInputWorkerFacts } from "../../config/sessions/session-pending-input.types.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import type {
  PendingToolResultDelta,
  SessionToolResultPending,
} from "../session-tool-result-pending.js";
import type { SessionWorkerInitialEntryCommit } from "./session-manager-metadata-contract.js";

type SessionMessageOwnerIdentity = {
  databasePath: string;
  sessionId: string;
  sessionKey: string;
};

export type SessionMessageAppendOwner = SessionMessageOwnerIdentity &
  (
    | {
        kind: "manager";
        capture: ReturnType<SessionToolResultPending["capture"]>;
        inputCapture?: ReturnType<typeof captureSessionPendingInputWorkerAppend>;
      }
    | { kind: "target-note" }
  );

export type SessionMessageCommitFacts = {
  operationId: string;
  owner: SessionMessageOwnerIdentity;
  receipt: Omit<TranscriptMessageAppendResult<unknown>, "message">;
  before: TranscriptWriteSnapshot<unknown>["before"];
  after: TranscriptWriteSnapshot<unknown>["after"];
  lifecycleRevision?: string;
  visibleTail: { entryId: string | null; generation: string | null };
  projectionNeedsReconcile: boolean;
} & (
  | {
      kind: "manager";
      delta: PendingToolResultDelta;
      pendingInput?: SessionPendingInputWorkerFacts;
      initial?: SessionWorkerInitialEntryCommit;
    }
  | { kind: "target-note" }
);

/** Private membership settles before fallible view adoption and outward publication. */
export function createSessionMessageAppendSettlement(
  operationId: string,
  owner: SessionMessageAppendOwner,
) {
  let preparation:
    | {
        facts: SessionMessageCommitFacts;
        reservation?: ReturnType<ReturnType<SessionToolResultPending["capture"]>["reserve"]>;
        inputReservation?: ReturnType<
          NonNullable<ReturnType<typeof captureSessionPendingInputWorkerAppend>>["reserve"]
        >;
      }
    | undefined;
  let committed: SessionMessageCommitFacts | undefined;
  let outcome: "waiting" | "reserved" | "tentative" | "committed" | "rolled-back" | "unknown" =
    "waiting";
  const matchesOwner = (facts: unknown) =>
    isRecord(facts) &&
    facts.operationId === operationId &&
    facts.kind === owner.kind &&
    isRecord(facts.owner) &&
    facts.owner.databasePath === owner.databasePath &&
    facts.owner.sessionId === owner.sessionId &&
    facts.owner.sessionKey === owner.sessionKey;
  return {
    get outcome() {
      return outcome;
    },
    get committed() {
      return committed;
    },
    get tentative() {
      return outcome === "tentative" ? preparation?.facts : undefined;
    },
    stage(this: void) {
      if (outcome !== "reserved" || !preparation) {
        throw new Error("Tentative session append has no retained preparation");
      }
      preparation.reservation?.stage();
      preparation.inputReservation?.stage();
      outcome = "tentative";
    },
    prepare(facts: SessionMessageCommitFacts) {
      if (outcome !== "waiting" || !matchesOwner(facts)) {
        throw new Error("Session message admission does not own this operation");
      }
      if (owner.kind === "target-note") {
        preparation = { facts: structuredClone(facts) };
        outcome = "reserved";
        return;
      }
      const { capture, inputCapture } = owner;
      const anchor = facts.receipt.anchor;
      if (
        facts.kind !== "manager" ||
        !anchor ||
        !capture.owner ||
        capture.owner.databasePath !== owner.databasePath ||
        capture.owner.sessionId !== owner.sessionId ||
        anchor.storePath !== owner.databasePath ||
        anchor.sessionId !== owner.sessionId
      ) {
        throw new Error("Session message admission does not own this manager");
      }
      if (Boolean(inputCapture) !== Boolean(facts.pendingInput)) {
        throw new Error("Session message receipt changed its pending input owner");
      }
      const reservation = capture.reserve(facts.delta);
      try {
        preparation = {
          facts: structuredClone(facts),
          reservation,
          inputReservation:
            inputCapture && facts.pendingInput
              ? inputCapture.reserve(facts.pendingInput)
              : undefined,
        };
      } catch (error) {
        reservation.rollback();
        throw error;
      }
      outcome = "reserved";
    },
    settle(this: void, nativeCommit: unknown, settlement: SqliteWorkerOperationSettlement) {
      if (outcome === "committed" || outcome === "rolled-back") {
        return;
      }
      if (matchesOwner(nativeCommit)) {
        if (!preparation) {
          throw new Error("Committed session message lost its retained preparation");
        }
        committed = preparation.facts;
        outcome = "committed";
        const failures: unknown[] = [];
        for (const reservation of [preparation.reservation, preparation.inputReservation]) {
          try {
            reservation?.commit();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            "Committed session custody could not be fully adopted",
          );
        }
      } else if (settlement.kind === "unknown") {
        if (owner.kind === "manager") {
          owner.inputCapture?.unknown();
        }
        outcome = "unknown";
      } else {
        outcome = "rolled-back";
        const failures: unknown[] = [];
        for (const reservation of [preparation?.reservation, preparation?.inputReservation]) {
          try {
            reservation?.rollback();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length) {
          throw new AggregateError(failures, "Rolled-back session custody cleanup failed", {
            cause: failures[0],
          });
        }
      }
    },
  };
}
