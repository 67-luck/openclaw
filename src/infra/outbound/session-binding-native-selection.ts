import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

/** Private core capability; kept outside the public adapter contract and SDK. */
export const nativeSessionBindingSelection = Symbol.for("openclaw.sessionBinding.nativeSelection");

export type NativeSessionBindingSelection = {
  [nativeSessionBindingSelection]?: (
    refs: readonly ConversationRef[],
  ) => Promise<ReadonlyArray<SessionBindingRecord | null>>;
};

/** Core-owned SQLite adapters enumerate through their original worker; SDK adapters keep their contract. */
export const nativeSessionBindingListBySessions = Symbol.for(
  "openclaw.sessionBinding.nativeListBySessions",
);

export type NativeSessionBindingListing = {
  [nativeSessionBindingListBySessions]?: (
    targetSessionKeys: readonly string[],
    context: OpenClawStateWorkerContext,
  ) => Promise<SessionBindingRecord[][]>;
};

/** Native mutation precondition; external adapter and released SDK shapes remain unchanged. */
export const expectedCurrentSessionBinding = Symbol.for("openclaw.sessionBinding.expectedCurrent");
export type CurrentSessionBindingExpectation = {
  [expectedCurrentSessionBinding]?: SessionBindingRecord | null;
};

/** The core adapter supplies its normalized store keys; the shared owner performs the one native selection. */
export const nativeSessionBindingInspection = Symbol.for(
  "openclaw.sessionBinding.nativeInspection",
);
export type NativeSessionBindingInspection = {
  [nativeSessionBindingInspection]?: {
    capture(ref: ConversationRef): ConversationRef | null;
    assertCurrent(): void;
  };
};
