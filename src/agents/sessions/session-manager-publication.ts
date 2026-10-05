import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { SessionManagerCore } from "./session-manager-core.js";

/** @internal Local publication facts are independent of a read worker or caller cancellation. */
export const sessionManagerCaptureView: unique symbol = Symbol.for(
  "openclaw.session-manager.capture-view",
);

export abstract class SessionManagerPublication extends SessionManagerCore {
  #navigationEpoch = 0;

  protected abstract assertTranscriptWriteActive(): void;

  [sessionManagerCaptureView]() {
    const view = this.captureTranscriptView();
    const fileEntryCount = view.fileEntries.length;
    const entryCount = view.byId.size;
    const opaqueEntryCount = view.opaqueFileEntries.length;
    const sessionId = this.sessionId;
    const target = this.persistenceTarget
      ? captureSessionTranscriptTargetBinding(this.persistenceTarget)
      : undefined;
    const assertNavigation = this.captureTranscriptNavigationAssertion();
    const assertNavigationCurrent = () => {
      assertNavigation();
      if (
        this.sessionId !== sessionId ||
        !sameSessionTranscriptTargetBinding(target, this.persistenceTarget)
      ) {
        throw new Error("Session manager changed during history acquisition");
      }
    };
    return {
      assertNavigationCurrent,
      assertCurrent: () => {
        assertNavigationCurrent();
        const current = this.captureTranscriptView();
        if (
          current.fileEntries.length !== fileEntryCount ||
          current.byId.size !== entryCount ||
          current.opaqueFileEntries.length !== opaqueEntryCount ||
          Object.keys(view).some((key) => Reflect.get(view, key) !== Reflect.get(current, key))
        ) {
          throw new Error("Session manager changed during history acquisition");
        }
      },
    };
  }

  protected recordTranscriptNavigationChange(selectionChanged = true): void {
    this.#navigationEpoch++;
    if (selectionChanged) {
      this.cacheTtlProjectionPrefixes = this.cacheTtlProjectionPrefixes?.filter(
        (prefix) => prefix.anchorIds.length > 0,
      );
    }
  }

  /** Local branch selections revoke pending writes; committed view adoption does not. */
  protected captureTranscriptNavigationAssertion(): () => void {
    const epoch = this.#navigationEpoch;
    return () => {
      if (this.#navigationEpoch !== epoch) {
        throw new Error("Session transcript navigation changed before publication");
      }
    };
  }

  /** A rejected older receipt cannot invalidate a newer view; failed own adoption must. */
  protected captureTranscriptPublication() {
    const version = this.transcriptVersion;
    const navigationEpoch = this.#navigationEpoch;
    const target = this.persistenceTarget
      ? captureSessionTranscriptTargetBinding(this.persistenceTarget)
      : undefined;
    const assertOwned = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
    let adopting = false;
    return {
      beginAdoption: () => {
        adopting = true;
      },
      invalidate: (error: Error, requiredVersion?: SessionTranscriptContextVersion) => {
        if (
          !adopting &&
          (this.transcriptVersion !== version || this.#navigationEpoch !== navigationEpoch)
        ) {
          try {
            this.assertTranscriptWriteActive();
            assertOwned?.();
            if (
              sameSessionTranscriptTargetBinding(target, this.persistenceTarget) &&
              (!requiredVersion || this.hasNewerPublishedTranscriptView(requiredVersion))
            ) {
              return;
            }
          } catch {
            // A changed selection cannot preserve a revoked writer's view.
          }
        }
        this.invalidateTranscriptView(error);
      },
    };
  }
}
