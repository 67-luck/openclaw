import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { SessionManagerBranching } from "./session-manager-branching.js";
import {
  committedTranscriptViewError,
  receiveSessionManagerCommit,
  SessionManagerActorCommittedError,
} from "./session-manager-persistence-error.js";
import {
  sessionManagerRewriteTranscript,
  type SessionTranscriptMessageRewrite,
} from "./session-manager-rewrite.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerRewrite extends SessionManagerBranching {
  async [sessionManagerRewriteTranscript](input: SessionTranscriptMessageRewrite) {
    this.assertTranscriptWriteActive();
    const request = structuredClone(input);
    const target = this.persistenceTarget;
    const version = this.transcriptVersion;
    const appendParentId = this.appendParentId;
    const assertNavigation = this.captureTranscriptNavigationAssertion();
    const publication = this.captureTranscriptPublication();
    const assertOwned = target ? captureOwnedTranscriptWriteAssertion(target) : () => {};
    const initial = this.captureTranscriptView();
    const entryCount = this.fileEntries.length;
    const retainedEntries = this.fileEntries.filter(
      (entry) => entry.type !== "session" && entry.type !== "message",
    );
    const customData = new Map<string, unknown>(
      retainedEntries.flatMap((entry) =>
        entry.type === "custom" && entry.data !== undefined
          ? [[entry.id, entry.data] as const]
          : [],
      ),
    );
    const retention = {
      retainedEntryIds: retainedEntries.map((entry) => entry.id),
      retainedCustomDataIds: [...customData.keys()],
      contextStartEntryId: this.contextStartEntryId,
    };
    const restoreCustomData = (
      reload: PreparedSessionTranscriptReload,
      sources: Array<[string, string]>,
    ) => {
      const sourceIds = new Map(sources);
      reload.snapshot.events = reload.snapshot.events.map((entry) => {
        if (
          isIndexedSessionEntry(entry) &&
          entry.type === "custom" &&
          !Object.hasOwn(entry, "data")
        ) {
          const sourceId = sourceIds.get(entry.id) ?? entry.id;
          if (customData.has(sourceId)) {
            return { ...entry, data: customData.get(sourceId) };
          }
        }
        return entry;
      });
      return reload;
    };
    const assertCurrent = () => {
      this.assertTranscriptWriteActive();
      assertOwned();
      assertNavigation();
      const current = this.captureTranscriptView();
      if (
        !sameSessionTranscriptTargetBinding(target, this.persistenceTarget) ||
        this.fileEntries.length !== entryCount ||
        Object.keys(initial).some((key) => Reflect.get(initial, key) !== Reflect.get(current, key))
      ) {
        throw new Error("Session transcript changed before rewrite publication");
      }
    };
    return withSessionManagerWrite(this, async (admission) => {
      assertCurrent();
      admission?.assertCurrent();
      if (!target) {
        const { prepareSessionTranscriptMessageRewrite } =
          await import("./session-manager-rewrite-plan.js");
        assertCurrent();
        const branch = this.getBranch();
        const sourceParents = this.boundedParentIds.get(branch[0]?.id ?? "");
        const prepared = prepareSessionTranscriptMessageRewrite(
          branch,
          request,
          sourceParents ? sourceParents.rawParentId : (branch[0]?.parentId ?? null),
        );
        if (prepared.result.changed) {
          const preparedView = new SessionManagerRewrite(this.cwd);
          Object.assign(preparedView, this.captureTranscriptView(true));
          for (const entry of prepared.entries) {
            freezeJsonSnapshot(entry);
            if (entry.type === "leaf") {
              preparedView.opaqueFileEntries.push({
                index: preparedView.fileEntries.length,
                record: entry,
              });
            } else {
              preparedView.fileEntries.push(entry);
              if (entry.type === "label") {
                // Branch parents may be normalized copies; custody belongs to the loaded record.
                const source = prepared.sources.get(entry.id);
                const original = source && this.byId.get(source.id);
                const admission = original && this.admittedLabelRecords.get(original);
                if (
                  original?.type === "label" &&
                  source?.type === "label" &&
                  admission?.targetId === original.targetId &&
                  admission.targetId === source.targetId
                ) {
                  // The planner remaps this admitted relationship to its copied target ID.
                  preparedView.admittedLabelRecords.set(entry, {
                    targetId: entry.targetId,
                    rawSeq: null,
                  });
                }
              }
            }
          }
          preparedView.buildIndex();
          for (const [id, parent] of this.opaqueParentsById) {
            preparedView.opaqueParentsById.set(id, parent);
          }
          for (const [id, parent] of this.logicalParentsById) {
            preparedView.logicalParentsById.set(id, parent);
          }
          preparedView.inheritResidentContextEntries(this, prepared.sources);
          preparedView.pendingDeliberateAppend = false;
          const rewrittenIds = new Map(
            [...prepared.sources].map(([id, source]) => [source.id, id]),
          );
          if (retention.contextStartEntryId) {
            preparedView.contextStartEntryId =
              rewrittenIds.get(retention.contextStartEntryId) ?? retention.contextStartEntryId;
          }
          // Detached views share prefixes; retain old anchors for branch-back without mutating them.
          preparedView.cacheTtlProjectionPrefixes = this.cacheTtlProjectionPrefixes?.map(
            (prefix) => ({
              ...prefix,
              anchorIds: [
                ...prefix.anchorIds,
                ...prefix.anchorIds.flatMap((id) => {
                  const replacement = rewrittenIds.get(id);
                  return replacement ? [replacement] : [];
                }),
              ],
            }),
          );
          assertCurrent();
          Object.assign(this, preparedView.captureTranscriptView());
          this.enforceResidentBudget();
        }
        return prepared.result;
      }
      if (!admission || !version) {
        throw new Error("Transcript rewrite lost its persistent owner");
      }
      const assertAdmitted = () => {
        assertCurrent();
        admission.assertCurrent();
      };
      let committed = false;
      try {
        if (isIncognitoSessionKey(target.sessionKey) && "db" in admission.database) {
          const { readCommittedTranscriptRewrite, rewriteSessionTranscriptMessages } =
            await import("./session-manager-rewrite.worker.js");
          const assertIncognitoOwner = () => {
            assertAdmitted();
            if (getOpenClawAgentDatabaseIfOpen(admission.options) !== admission.database) {
              throw new Error("Session transcript incognito database owner is no longer current");
            }
          };
          assertIncognitoOwner();
          return rewriteSessionTranscriptMessages(
            target,
            request,
            version,
            appendParentId,
            admission.database.db,
            assertIncognitoOwner,
            retention,
            undefined,
            (_version, retained) => {
              committed = true;
              assertIncognitoOwner();
              publication.beginAdoption();
              this.adoptPreparedTranscriptReload(
                restoreCustomData(
                  readCommittedTranscriptRewrite(
                    target,
                    this.boundedContextLimits,
                    retained.retainedEntryIds,
                    retained.retainedCustomDataIds,
                  ),
                  retained.customDataSources,
                ),
              );
              this.contextStartEntryId = retained.contextStartEntryId;
              this.enforceResidentBudget();
            },
          ).result;
        }
        const { withSessionMetadataWorker } = await import("./session-manager-metadata-runtime.js");
        assertAdmitted();
        const { env: _env, ...scope } = withOwnedSessionTranscriptWriterFence(target);
        const receipt = await receiveSessionManagerCommit(
          "session.transcript.rewriteMessages",
          () =>
            withSessionMetadataWorker(
              admission.options,
              admission.database,
              assertAdmitted,
              (worker) =>
                worker.execute({
                  type: "session.transcript.rewriteMessages",
                  input: {
                    scope: { ...scope, storePath: admission.database.path },
                    request,
                    retention,
                    version,
                    appendParentId,
                    limits: this.boundedContextLimits,
                  },
                }),
            ),
        );
        const outcome = receipt.value;
        committed = outcome.result.changed;
        if (receipt.failure) {
          throw receipt.failure;
        }
        assertAdmitted();
        if (committed) {
          if (!outcome.reload?.ok) {
            throw committedTranscriptViewError(outcome.reload?.error);
          }
          if (
            outcome.reload.value.snapshot.version.generation !== outcome.version?.generation ||
            outcome.reload.value.snapshot.version.rawSeq !== outcome.version?.rawSeq ||
            outcome.reload.value.snapshot.version.updatedAt !== outcome.version?.updatedAt
          ) {
            throw new Error("Session transcript changed before committed rewrite publication");
          }
          publication.beginAdoption();
          this.adoptPreparedTranscriptReload(
            restoreCustomData(outcome.reload.value, outcome.retained.customDataSources),
          );
          this.contextStartEntryId = outcome.retained.contextStartEntryId;
          this.enforceResidentBudget();
        }
        return outcome.result;
      } catch (cause) {
        if (cause instanceof SessionManagerActorCommittedError) {
          this.invalidateTranscriptView(cause);
          throw cause;
        }
        if (!committed) {
          throw cause;
        }
        const error = new Error(
          "Session transcript rewrite committed but view publication failed",
          { cause },
        );
        recordModelFallbackStop(error);
        publication.invalidate(error);
        throw error;
      }
    });
  }
}
