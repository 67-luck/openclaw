import type { PrepareAssistantTranscriptMessage } from "../../../config/sessions/transcript-assistant-delivery.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { appendSessionTranscriptMessageByIdentityStrict } from "../../../plugin-sdk/session-transcript-runtime.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";

/** Retain only the prepared terminal draft until its logical owner accepts it. */
export function createSettledDraftTranscriptCapture(params: RunEmbeddedAgentInternalParams) {
  let draft: AssistantMessage | undefined;
  const original = params.prepareAssistantTranscriptMessage;
  const enabled = Boolean(
    params.reviewSettledDraft && params.suppressTranscriptOnlyAssistantPersistence,
  );
  const prepare: PrepareAssistantTranscriptMessage | undefined = enabled
    ? (message, sourceText) => {
        const prepared = original?.(message, sourceText) ?? message;
        // Tool calls/results retain their normal durable owner and pairing.
        if (!prepared.content.some((part) => part.type === "toolCall")) {
          draft = structuredClone(prepared);
        }
        return prepared;
      }
    : original;
  return { prepare, read: () => draft };
}

/** Persist the approved prepared draft through the existing fenced transcript owner. */
export async function persistAcceptedSettledDraft(params: {
  run: RunEmbeddedAgentInternalParams;
  message: AssistantMessage | undefined;
  assertCurrent: () => void;
}) {
  const message = params.message;
  if (!message) {
    return;
  }
  const { run, assertCurrent } = params;
  const target = run.sessionTarget;
  if (!target?.sessionId || !target.sessionKey) {
    throw new Error("An accepted private draft requires its admitted transcript target");
  }
  const admittedTarget = { ...target, sessionId: target.sessionId, sessionKey: target.sessionKey };
  assertCurrent();
  // No second plugin hook: capture already ran the normal preparation hook.
  // The canonical append still applies storage redaction and commit fencing.
  const result = await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: admittedTarget,
      assertCommitAllowed: assertCurrent,
      withTranscriptWrite: async (write) => await write(),
    },
    () =>
      appendSessionTranscriptMessageByIdentityStrict({
        ...admittedTarget,
        config: run.config,
        runId: run.runId,
        message: { ...message, idempotencyKey: run.runId + ":accepted-settled-draft" },
      }),
  );
  assertCurrent();
  if (result.kind !== "result") {
    throw new Error("The accepted private draft could not be committed to its session");
  }
}
