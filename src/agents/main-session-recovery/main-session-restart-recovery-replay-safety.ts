import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeRestartRecoveryRequester,
  type RestartRecoveryRequester,
} from "../../config/sessions/restart-recovery-requester.js";
import {
  visitSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
import {
  isCompletionReportInputProvenance,
  isMainSessionRestartRecoveryInputProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.metadata.js";
import { getTranscriptMessageRole } from "../embedded-agent-runner/message-visibility.js";
import { hasReplaySafeCodeModeCheckpointInCurrentTurn } from "./main-session-restart-recovery-resume-policy.js";

type RecoverySource =
  | "completion"
  | "harness_completion"
  | "inter_session"
  | "internal_system"
  | "external_user";

export async function readMainSessionRecoveryCheckpoint(
  scope: SessionTranscriptReadScope,
  requesterRecord?: RestartRecoveryRequester,
): Promise<{ replaySafe: boolean; source: RecoverySource | undefined; requesterMatched: boolean }> {
  let replaySafe = false;
  let requesterMatched = false;
  const requester = normalizeRestartRecoveryRequester(requesterRecord);
  let source: RecoverySource | undefined;
  // The display tail can evict the source and checkpoint. Recovery inputs
  // continue the original turn; both facts come from one constant-memory snapshot.
  await visitSessionMessagesAsync(scope, (message) => {
    if (getTranscriptMessageRole(message) === "user") {
      const provenance = normalizeInputProvenance(asOptionalRecord(message)?.provenance);
      if (!isMainSessionRestartRecoveryInputProvenance(provenance)) {
        replaySafe = false;
        requesterMatched = Boolean(
          requester &&
          requester.sessionId === scope.sessionId &&
          requester.sessionKey === scope.sessionKey &&
          provenance?.kind === "inter_session" &&
          provenance.sourceTool === "sessions_send" &&
          provenance.sourceSessionKey === requester.sessionKey &&
          asOptionalRecord(message)?.idempotencyKey ===
            buildRunUserTurnIdempotencyKey(requester.sourceRunId),
        );
        switch (provenance?.kind) {
          case "internal_system":
            source = "internal_system";
            break;
          case "inter_session":
            source =
              provenance.sourceTool?.toLowerCase() === "agent_harness_task"
                ? "harness_completion"
                : isCompletionReportInputProvenance(provenance)
                  ? "completion"
                  : "inter_session";
            break;
          case "external_user":
            source = "external_user";
            break;
          default:
            // A later unverified input cannot inherit an earlier human sender's evidence.
            source = undefined;
        }
      }
    } else if (hasReplaySafeCodeModeCheckpointInCurrentTurn([message])) {
      replaySafe = true;
    }
  });
  return { replaySafe, source, requesterMatched };
}
