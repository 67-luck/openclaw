import type { DatabaseSync } from "node:sqlite";
import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "./openclaw-agent-db.js";
import type { AgentDatabaseOperations } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseDomainOwner } from "./openclaw-agent-execution-domain.js";

/** Commands borrow one canonical connection; native and volatile owners retain open/close authority. */
export function createAgentDatabaseCommandOwner(context: {
  options: OpenClawAgentDatabaseOptions & { path: string };
  getPreparedDatabase(this: void): DatabaseSync;
  assertCurrent(): OpenClawAgentDatabase;
  admit(
    this: void,
    stage: "transaction" | "commit",
    facts?: { domain?: unknown; publication?: unknown },
  ): void;
}) {
  const { options, admit } = context;
  let providerReview:
    | typeof import("../config/sessions/provider-review-store.worker.js")
    | undefined;
  let entryReader:
    | typeof import("../config/sessions/session-accessor.sqlite-entry-read.js")
    | undefined;
  let trajectory: typeof import("../trajectory/runtime-store.sqlite.js") | undefined;
  let archives:
    | typeof import("../config/sessions/session-accessor.sqlite-archive-store-kernel.js")
    | undefined;
  let transcript:
    | {
        initialize: typeof import("../config/sessions/session-accessor.sqlite-transcript-header.js").ensureTranscriptHeader;
        assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity;
      }
    | undefined;
  let archivePruning:
    | typeof import("../config/sessions/session-history-archive-pruning.worker.js")
    | undefined;
  let replacements:
    | typeof import("../config/sessions/session-accessor.sqlite-replacement-state.js")
    | undefined;
  const domain = createAgentDatabaseDomainOwner({
    databasePath: options.path,
    getPreparedDatabase: context.getPreparedDatabase,
    assertCurrent: () => context.assertCurrent().db,
    admit: (stage, facts) => admit(stage, { domain: facts }),
  });
  return {
    executeScoped(
      command: SqliteWorkerCommand<AgentDatabaseOperations>,
      retain: (database: DatabaseSync) => void,
    ) {
      if (command.type !== "database.domain.run") {
        throw new Error("Nested session execution requires its prepared domain command");
      }
      return domain.executeNested(command, retain);
    },
    prepare(this: void, command: SqliteWorkerCommand<AgentDatabaseOperations>) {
      if (command.type === "session.entry.read") {
        return import("../config/sessions/session-accessor.sqlite-entry-read.js").then((module) => {
          entryReader = module;
        });
      }
      if (command.type === "trajectory.events.append") {
        return import("../trajectory/runtime-store.sqlite.js").then((module) => {
          trajectory = module;
        });
      }
      if (
        command.type === "session.archives.preparePublication" ||
        command.type === "session.archives.recordPublication"
      ) {
        return import("../config/sessions/session-accessor.sqlite-archive-store-kernel.js").then(
          (module) => {
            archives = module;
          },
        );
      }
      if (command.type === "session.transcript.initialize") {
        return Promise.all([
          import("../config/sessions/session-accessor.sqlite-transcript-header.js"),
          import("../config/sessions/session-accessor.sqlite-scope.js"),
        ]).then(([header, scope]) => {
          transcript = {
            initialize: header.ensureTranscriptHeader,
            assertIdentity: scope.assertSqliteTranscriptWriteIdentity,
          };
        });
      }
      if (
        command.type === "session.archivePruning.deletePublished" ||
        command.type === "session.archivePruning.removeLegacy" ||
        command.type === "session.archivePruning.reclaimPages"
      ) {
        return import("../config/sessions/session-history-archive-pruning.worker.js").then(
          (module) => {
            archivePruning = module;
          },
        );
      }
      if (command.type === "session.entries.replace") {
        return import("../config/sessions/session-accessor.sqlite-replacement-state.js").then(
          (module) => {
            replacements = module;
          },
        );
      }
      if (command.type === "session.providerReview.compare") {
        return import("../config/sessions/provider-review-store.worker.js").then((module) => {
          providerReview = module;
        });
      }
      if (
        command.type === "database.domain.bind" ||
        command.type === "database.domain.run" ||
        command.type === "database.domain.execute" ||
        command.type === "database.domain.close"
      ) {
        return domain.prepare(command);
      }
      return undefined;
    },
    execute(command: SqliteWorkerCommand<AgentDatabaseOperations>): unknown {
      if (
        command.type === "database.domain.bind" ||
        command.type === "database.domain.run" ||
        command.type === "database.domain.execute" ||
        command.type === "database.domain.close"
      ) {
        return domain.execute(command);
      }
      if (command.type === "database.prepareWrite") {
        context.assertCurrent();
        return undefined;
      }
      if (command.type === "session.entry.read" && entryReader) {
        return entryReader.readSessionEntryRow(context.assertCurrent(), command.input.sessionKey)
          ?.entry;
      }
      if (command.type === "trajectory.events.append" && trajectory) {
        const opened = context.assertCurrent();
        const append = trajectory.appendSqliteTrajectoryRuntimeEventsInTransaction;
        return runOpenClawAgentWriteTransaction(
          (current) => {
            if (current.db !== opened.db) {
              throw new Error("Trajectory append lost its canonical database owner");
            }
            admit("transaction");
            append(current, command.input);
            deferSqliteWorkerCommitReceipt(current.db, { kind: "trajectory-runtime-append" });
            admit("commit");
          },
          options,
          { operationLabel: "trajectory.runtime.append" },
        );
      }
      if (
        (command.type === "session.archives.preparePublication" ||
          command.type === "session.archives.recordPublication") &&
        archives
      ) {
        const opened = context.assertCurrent();
        const kernel = archives;
        return runOpenClawAgentWriteTransaction(
          (current) => {
            if (current.db !== opened.db) {
              throw new Error("Session archive publication lost its canonical database owner");
            }
            admit("transaction");
            const result =
              command.type === "session.archives.preparePublication"
                ? kernel.prepareSessionTranscriptArchivePublishPlans(current, command.input)
                : kernel.recordSessionTranscriptArchivePublishResults(
                    current,
                    command.input.results,
                    command.input.nowMs,
                  );
            admit("commit");
            return result;
          },
          options,
          { operationLabel: "session.archive.publish" },
        );
      }
      if (command.type === "session.transcript.initialize" && transcript) {
        const assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity =
          transcript.assertIdentity;
        assertIdentity(command.input);
        const initialize = transcript.initialize;
        const opened = context.assertCurrent();
        return runOpenClawAgentWriteTransaction(
          (current) => {
            if (current.db !== opened.db) {
              throw new Error("Session transcript lost its canonical database owner");
            }
            admit("transaction");
            const publication: SessionTranscriptInitializationPublication = {
              kind: "session-transcript-initialized",
              sessionKey: command.input.sessionKey,
            };
            initialize(
              current,
              { agentId: options.agentId, path: options.path, ...command.input },
              command.input.cwd,
              {
                onPlaceholderInserted: ({ sessionId }) => {
                  publication.placeholder = { sessionId };
                },
              },
            );
            deferSqliteWorkerCommitReceipt(current.db, publication);
            admit("commit", { publication });
            return publication;
          },
          options,
          { operationLabel: "session.entry.create-with-transcript" },
        );
      }
      if (command.type === "session.entries.replace" && replacements) {
        const opened = context.assertCurrent();
        const replace = replacements.commitSessionEntryReplacementsInDatabase;
        const preparePublication = replacements.prepareSessionEntryReplacementPublication;
        return runOpenClawAgentWriteTransaction(
          (current) => {
            if (current.db !== opened.db) {
              throw new Error("Session replacement lost its canonical database owner");
            }
            admit("transaction");
            const result = replace(current, command.input, () => {});
            const publication = preparePublication(result);
            deferSqliteWorkerCommitReceipt(current.db, publication);
            admit("commit", { publication });
            return result;
          },
          options,
          { operationLabel: "session.entry-replacements" },
        );
      }
      if (command.type === "session.providerReview.compare" && providerReview) {
        return providerReview.compareSessionProviderReviewInWorker(
          context.assertCurrent(),
          options,
          command.input,
          admit,
        );
      }
      if (command.type === "session.archivePruning.deletePublished" && archivePruning) {
        return archivePruning.deletePublishedSessionArchiveInDatabase(
          context.assertCurrent(),
          options,
          command.input,
          admit,
        );
      }
      if (command.type === "session.archivePruning.removeLegacy" && archivePruning) {
        return archivePruning.removeLegacySessionArchiveInDatabase(
          context.assertCurrent(),
          options,
          command.input.filePath,
          admit,
        );
      }
      if (command.type === "session.archivePruning.reclaimPages" && archivePruning) {
        return archivePruning.reclaimSessionArchivePagesInWorker(
          context.assertCurrent(),
          command.input.maxPages,
          admit,
        );
      }
      throw new Error("Unknown agent database operation");
    },
    assertSettled: domain.assertSettled,
    close: domain.close,
  };
}
