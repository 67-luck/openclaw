import {
  getActiveNativeAttempt,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
} from "../agents/embedded-agent-runner/run-state.js";
import type { ReplyToolAuthorityOverlay } from "../sessions/session-controller.contracts.js";
import {
  getAttachedBackend,
  resolveReplyRunForCurrentSessionId,
} from "../sessions/session-controller.state.js";

/** A session-wide request selects one existing owner; later work cannot inherit it. */
export function captureRealtimeVoiceRunOwner(sessionId: string, sessionKey: string) {
  const handle = getActiveNativeAttempt(sessionId);
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!handle && !operation) {
    return undefined;
  }
  const runId = handle?.runId;
  const handleFingerprint = handle?.toolAuthorityFingerprint;
  const fingerprint = handleFingerprint ?? operation?.toolAuthorityFingerprint;
  const isCurrent = () => {
    if (
      operation &&
      (operation.result ||
        operation.key !== sessionKey ||
        operation.sessionId !== sessionId ||
        resolveReplyRunForCurrentSessionId(sessionId) !== operation ||
        (handle && getAttachedBackend(operation) !== handle))
    ) {
      return false;
    }
    if (
      handle &&
      (getActiveNativeAttempt(sessionId) !== handle ||
        ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) !== registration ||
        (registration?.sessionKey !== undefined && registration.sessionKey !== sessionKey) ||
        handle.runId !== runId ||
        handle.toolAuthorityFingerprint !== handleFingerprint ||
        handle.isStopped?.() ||
        handle.isAborted?.())
    ) {
      return false;
    }
    try {
      registration?.toolAuthority?.assertActive();
      return true;
    } catch {
      return false;
    }
  };
  return {
    isCurrent,
    matchesCaller: (overlay: ReplyToolAuthorityOverlay) => {
      if (!isCurrent()) {
        return false;
      }
      const projected = registration?.toolAuthority
        ? registration.toolAuthority.project(overlay)
        : operation?.projectToolAuthorityFingerprint(overlay);
      return Boolean(fingerprint && projected === fingerprint && isCurrent());
    },
  };
}
