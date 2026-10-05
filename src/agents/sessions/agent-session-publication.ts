import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { AgentMessage } from "../runtime/index.js";

type SessionMessageState = { messages: AgentMessage[] };

const unavailableMessageViews = new WeakMap<SessionMessageState, WeakMap<AgentMessage[], Error>>();

/** Replacing model context retires its failure; appending to the same stale array does not. */
export function assertSessionMessageViewAvailable(state: SessionMessageState): void {
  const error = unavailableMessageViews.get(state)?.get(state.messages);
  if (error) {
    throw error;
  }
}

/** Transcript authority and the active message array have independent publication lifecycles. */
export function prepareSessionMessagePublication(readState: () => SessionMessageState) {
  const state = readState();
  const messages = state.messages;
  const entries = messages.slice();
  const assertCurrent = () => {
    const current = readState();
    if (
      current !== state ||
      current.messages !== messages ||
      messages.length !== entries.length ||
      messages.some((message, index) => message !== entries[index])
    ) {
      throw new Error("Active session messages changed before publication");
    }
  };
  return {
    assertCurrent,
    invalidateIfCurrent: (error: Error) => {
      const current = readState();
      if (current !== state || current.messages !== messages) {
        return;
      }
      let failures = unavailableMessageViews.get(state);
      if (!failures) {
        failures = new WeakMap();
        unavailableMessageViews.set(state, failures);
      }
      failures.set(messages, error);
    },
    publish: (next: AgentMessage[]) => {
      assertCurrent();
      state.messages = next;
    },
  };
}

export function committedSessionPublicationError(message: string, cause: unknown): Error {
  const error = new Error(message, { cause });
  recordModelFallbackStop(error);
  return error;
}
