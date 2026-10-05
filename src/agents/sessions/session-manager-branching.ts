import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import { bindCacheTtlProjectionPrefixes } from "../../config/sessions/session-cache-ttl-prefix.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { prepareBranchedSession } from "./session-manager-branch-path.js";
import { isIndexedSessionEntry } from "./session-manager-codec.js";
import { createManagedSessionId } from "./session-manager-id.js";
import { prepareSessionManagerHydration } from "./session-manager-incognito.js";
import { SessionManagerMetadata } from "./session-manager-metadata.js";
import {
  committedTranscriptViewError,
  receiveSessionManagerCommit,
} from "./session-manager-persistence-error.js";
import type { SessionHeader } from "./session-manager-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerBranching extends SessionManagerMetadata {
  async createBranchedSession(leafId: string): Promise<string | undefined> {
    return withSessionManagerWrite(this, async (admission) => {
      this.assertTranscriptWriteActive();
      const assertNavigation = this.captureTranscriptNavigationAssertion();
      const previousSessionId = this.sessionId;
      const newSessionId = createManagedSessionId();
      const timestamp = new Date().toISOString();
      const persistenceTarget = this.persistenceTarget;

      const header: SessionHeader = {
        type: "session",
        version: this.getHeader()?.version,
        id: newSessionId,
        timestamp,
        cwd: this.cwd,
        parentSession: persistenceTarget ? previousSessionId : undefined,
      };
      if (persistenceTarget && admission) {
        const identity = { ...persistenceTarget };
        const version = this.transcriptVersion;
        if (!version) {
          throw new Error("Session branch requires committed history");
        }
        const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
        const assertDestinationOwned = captureOwnedTranscriptWriteAssertion({
          ...identity,
          sessionId: newSessionId,
        });
        const assertCurrent = () => {
          admission.assertCurrent();
          this.assertTranscriptWriteActive();
          assertOwned();
          assertNavigation();
          if (
            !sameSessionTranscriptTargetBinding(identity, this.persistenceTarget) ||
            this.transcriptVersion !== version
          ) {
            throw new Error("Session transcript changed during branch preparation");
          }
        };
        const { restoreSessionColdTranscript } =
          await import("../../config/sessions/session-cold-storage.js");
        if ("db" in admission.database) {
          await restoreSessionColdTranscript(persistenceTarget, assertCurrent);
        }
        const reader = prepareSessionManagerHydration(
          persistenceTarget,
          undefined,
          undefined,
          this,
        );
        const assertBranchCurrent = () => {
          // The actor commit intentionally replaces the captured source session generation.
          if ("db" in admission.database) {
            reader.assertCurrent();
          }
          assertCurrent();
          assertDestinationOwned();
        };
        const facts = await reader.readMaintenance({ operation: "version" });
        reader.assertCurrent();
        assertBranchCurrent();
        const { withSessionMetadataWorker } = await import("./session-manager-metadata-runtime.js");
        assertBranchCurrent();
        const fencedTarget = withOwnedSessionTranscriptWriterFence(persistenceTarget);
        const { env: _env, ...scope } = fencedTarget;
        const retainedCustomData = new Map(
          [...this.byId.values()].flatMap((entry) =>
            entry.type === "custom" && entry.data !== undefined
              ? [[entry.id, entry.data] as const]
              : [],
          ),
        );
        const command = {
          type: "session.transcript.branch" as const,
          input: {
            scope: { ...scope, storePath: admission.database.path },
            branch: { leafId, header },
            version,
            limits: this.boundedContextLimits,
            retainedEntryIds: [...this.byId.values()]
              .filter((entry) => entry.type !== "message")
              .map((entry) => entry.id),
            retainedCustomDataIds: [...retainedCustomData.keys()],
            expectedLifecycleRevision: facts.lifecycleRevision,
          },
        };
        const nativeIncognito =
          isIncognitoSessionKey(persistenceTarget.sessionKey) && "db" in admission.database
            ? admission.database
            : undefined;
        const receipt = await receiveSessionManagerCommit("session.transcript.branch", () =>
          nativeIncognito
            ? (async () => {
                const { executeSessionMaintenance } =
                  await import("./session-manager-maintenance.worker.js");
                assertBranchCurrent();
                return executeSessionMaintenance(command, fencedTarget, {
                  database: nativeIncognito.db,
                  admit: assertBranchCurrent,
                });
              })()
            : withSessionMetadataWorker(
                admission.options,
                admission.database,
                assertBranchCurrent,
                (worker) => worker.execute(command),
              ),
        );
        const committed = receipt.value;
        if (committed.projectionNeedsReconcile && !receipt.failure) {
          startSessionTranscriptIndexReconcile({
            ...admission.options,
            preferredSessionId: newSessionId,
          });
        }
        let failure: { cause: unknown } | undefined;
        try {
          if (receipt.failure) {
            throw receipt.failure;
          }
          assertBranchCurrent();
          if (!committed.reload.ok) {
            throw committedTranscriptViewError(committed.reload.error);
          }
          const prepared = committed.reload.value;
          prepared.snapshot.events = prepared.snapshot.events.map((entry) =>
            isIndexedSessionEntry(entry) &&
            entry.type === "custom" &&
            retainedCustomData.has(entry.id)
              ? { ...entry, data: retainedCustomData.get(entry.id) }
              : entry,
          );
          this.adoptPreparedTranscriptReload(prepared, undefined, {
            ...fencedTarget,
            sessionId: newSessionId,
          });
        } catch (cause) {
          failure = { cause };
        }
        try {
          if ("db" in admission.database) {
            reader.assertCurrent();
          }
          publishCommittedSessionIdentity(
            scope.agentId,
            "db" in admission.database
              ? readOpenClawAgentDatabaseIdentity(admission.database).identity
              : admission.database.identity.incarnation,
            committed.identity.previous,
            committed.identity.current,
          );
        } catch (cause) {
          failure = {
            cause: failure
              ? new AggregateError(
                  [failure.cause, cause],
                  "Branch adoption and identity publication failed",
                  { cause: failure.cause },
                )
              : cause,
          };
        }
        if (failure) {
          const error = Object.assign(
            new Error(
              "Session branch committed, but publication did not complete; do not replay the branch",
              { cause: failure.cause },
            ),
            {
              name: "SessionBranchCommittedError",
              committedSessionId: newSessionId,
              committedTarget: { ...fencedTarget, sessionId: newSessionId },
              committedVersion: committed.version,
            },
          );
          recordModelFallbackStop(error);
          this.invalidateTranscriptView(error);
          throw error;
        }
      } else {
        const { events } = prepareBranchedSession(this.getPersistedFileEntries(), leafId, header);
        const prepared = new SessionManagerBranching(this.cwd);
        prepared.boundedContextLimits = this.boundedContextLimits;
        prepared.setLoadedSessionTarget(undefined, events);
        const selectedCurrentTip = leafId === this.rawLeafId;
        prepared.cacheTtlProjectionPrefixes = bindCacheTtlProjectionPrefixes(
          {
            cacheTtlProjectionPrefixes: this.cacheTtlProjectionPrefixes,
            selectedLeafEntryId: leafId,
            parents: this.boundedParentIds,
            opaqueParents: this.opaqueParentsById,
          },
          prepared,
          selectedCurrentTip,
        );
        if (selectedCurrentTip) {
          prepared.inheritResidentContextEntries(this);
          prepared.contextStartEntryId = this.contextStartEntryId;
        }
        Object.assign(this, prepared.captureTranscriptView());
      }
      return persistenceTarget ? newSessionId : undefined;
    });
  }
}
