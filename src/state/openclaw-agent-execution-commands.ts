import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
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
  assertCleanupCurrent(): void;
  admit(
    this: void,
    stage: "transaction" | "commit",
    facts?: { domain?: unknown; publication?: unknown },
  ): void;
}) {
  const { options, admit } = context;
  type Request = { startupJournal: boolean; domain: unknown; domainTaken: boolean };
  let request: Request | undefined;
  const readRequest = (): Request => {
    const attachment = takeSqliteWorkerOperationAdmissionAttachment();
    if (
      !isRecord(attachment) ||
      attachment.kind !== "agent-execution" ||
      typeof attachment.startupJournal !== "boolean"
    ) {
      throw new Error("Agent execution requires its request-local preparation facts");
    }
    return {
      startupJournal: attachment.startupJournal,
      domain: attachment.domain,
      domainTaken: false,
    };
  };
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
    assertCleanupCurrent: context.assertCleanupCurrent,
    takePreparation() {
      if (!request || request.domainTaken) {
        throw new Error("Agent domain preparation is unavailable");
      }
      request.domainTaken = true;
      const domain = request.domain;
      request.domain = undefined;
      return domain;
    },
    admit: (stage, facts) => admit(stage, { domain: facts }),
  });
  return {
    beginRequest() {
      if (request) {
        throw new Error("Agent execution already has request-local preparation facts");
      }
      request = readRequest();
    },
    endRequest() {
      request = undefined;
    },
    hasRequest() {
      return request !== undefined;
    },
    startupJournal() {
      if (!request) {
        throw new Error("Agent execution lost its request-local preparation facts");
      }
      return request.startupJournal;
    },
    executeScoped(
      command: SqliteWorkerCommand<AgentDatabaseOperations>,
      retain: (database: DatabaseSync) => void,
    ) {
      if (command.type !== "database.domain.run") {
        throw new Error("Nested session execution requires its prepared domain command");
      }
      // A nested job owns another transport attachment, not another take of its
      // parent's preparation. Restore the parent even when the child rolls back.
      const parent = request;
      request = readRequest();
      try {
        return domain.executeNested(command, retain);
      } finally {
        request = parent;
      }
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
      if (
        command.type === "session.transcript.initialize" ||
        (command.type === "session.entries.replace" && command.input.initializeTranscript)
      ) {
        return Promise.all([
          import("../config/sessions/session-accessor.sqlite-transcript-header.js"),
          import("../config/sessions/session-accessor.sqlite-scope.js"),
          command.type === "session.entries.replace"
            ? import("../config/sessions/session-accessor.sqlite-replacement-state.js")
            : undefined,
        ]).then(([header, scope, replacement]) => {
          replacements = replacement ?? replacements;
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
        command.type === "database.domain.publish" ||
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
        command.type === "database.domain.publish" ||
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
      if (command.type === "database.walMaintenance") {
        return (
          context.assertCurrent().walMaintenance.maintainPeriodic?.(command.input, admit) ?? {
            reclaimedPages: 0,
          }
        );
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
            const result = replace(current, command.input, () => {
              const initialization = command.input.initializeTranscript;
              if (!initialization) {
                return;
              }
              try {
                if (!transcript) {
                  throw new Error("Session transcript initialization was not prepared");
                }
                const assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity =
                  transcript.assertIdentity;
                assertIdentity(initialization);
                transcript.initialize(
                  current,
                  { agentId: options.agentId, path: options.path, ...initialization },
                  initialization.cwd,
                );
              } catch (error) {
                throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
                  name: "SessionTranscriptInitializationError",
                });
              }
            });
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
    preparePublication: domain.preparePublication,
    cleanupPublication: domain.cleanupPublication,
    assertSettled: domain.assertSettled,
    close(this: void) {
      try {
        domain.close();
      } finally {
        request = undefined;
      }
    },
  };
}
