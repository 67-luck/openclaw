import { randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type {
  SessionEntryReadQuery,
  SessionEntryReadResult,
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
} from "../../agents/sessions/session-manager-metadata-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { deferSqliteWorkerCallerPublication } from "../../infra/sqlite-worker-host-context.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerHostScope } from "../../infra/sqlite-worker-scoped-operation.js";
import { agentDatabaseLifecycle } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
  type AgentDatabaseExecutionBinding,
} from "../../state/openclaw-agent-execution.js";
import { captureOpenClawAgentHostExecution } from "../../state/openclaw-agent-write-admission.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import type { SessionEntryPatchOptions } from "./session-accessor.sqlite-contract.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import type { SessionEntryPatchSelection } from "./session-accessor.sqlite-entry-mutation.js";
import { toDatabaseOptions, type ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { retainSessionDatabaseRead } from "./session-transcript-execution.js";
import type { InternalSessionEntry } from "./types.js";

type Snapshot = SessionMetadataOperations["session.metadata.entrySnapshot"]["output"];
type Patch = SessionMetadataOperations["session.metadata.entryPatch"]["input"];
type Mutation = SessionMetadataOperations["session.metadata.entryPatch"]["output"];
type SettledPublication = ReturnType<
  ReturnType<typeof retainSessionEntryWorkerPublication>["settle"]
>;
const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata).href;
const sourceExecution = Symbol.for("openclaw.sessionEntryReadSourceExecution");
type WorkerReadSource = CapturedSessionEntryReadSource & {
  [sourceExecution]?: { execution: AgentDatabaseExecutionBinding; incarnation: string };
};

export function hasWorkerSessionEntrySource(source: WorkerReadSource): boolean {
  return source[sourceExecution] !== undefined;
}

/** Fresh borrows share owner identity, not their per-borrow capability closures. */
export function sessionEntryReadSourcesEqual(
  left: WorkerReadSource | undefined,
  right: WorkerReadSource | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const a = left[sourceExecution];
  const b = right[sourceExecution];
  return (
    left.agentId === right.agentId &&
    left.path === right.path &&
    left.databaseIdentity === right.databaseIdentity &&
    left.databaseBirthtime === right.databaseBirthtime &&
    a?.execution.incarnation === b?.execution.incarnation &&
    a?.incarnation === b?.incarnation
  );
}

/** Consumers retain the producer's real lifecycle binding; identity strings never grant it. */
export function retainWorkerSessionEntrySource(source: WorkerReadSource) {
  const retained = source[sourceExecution];
  if (
    !retained ||
    retained.execution.path !== source.path ||
    retained.execution.agentId !== source.agentId
  ) {
    throw new Error("Session entry read did not retain its original execution owner");
  }
  retained.execution.assertCurrent();
  return retained;
}

/** The native descriptor records identity; only the retained binding supplies lifecycle custody. */
function captureWorkerSessionEntryReadSource(
  execution: AgentDatabaseExecutionBinding,
  snapshot: Pick<Snapshot, "incarnation" | "physical">,
): CapturedSessionEntryReadSource {
  execution.assertCurrent();
  const source: WorkerReadSource = {
    agentId: execution.agentId,
    path: execution.path,
    databaseIdentity: snapshot.physical.identity,
    databaseBirthtime: snapshot.physical.birthtime,
    [sourceExecution]: { execution, incarnation: snapshot.incarnation },
  };
  return source;
}

type SessionEntryReadValues = {
  [Read in SessionEntryReadResult as Read["kind"]]: Read["value"];
};
type SessionEntryExecutionRead<Q extends SessionEntryReadQuery> =
  | { found: false }
  | {
      found: true;
      value: SessionEntryReadValues[Q["kind"]];
      source: CapturedSessionEntryReadSource;
    };

/** The existing-only reader retains its original owner even when no database exists. */
export function captureSessionEntryReadExecution(
  resolved: ResolvedSqliteScope,
  captured?: WorkerReadSource,
) {
  const options = toDatabaseOptions(resolved);
  options.path = resolveOpenClawAgentSqlitePath(options);
  if (
    !isMainThread ||
    !agentDatabaseLifecycle.gatewayExecution ||
    !isIncognitoOpenClawAgentSqlitePath(options.path, options)
  ) {
    return undefined;
  }
  const capturedExecution = captured?.[sourceExecution];
  const execution = capturedExecution
    ? capturedExecution.execution.borrow()
    : captureOpenClawAgentDatabaseExecution(options);
  const binding = execution.binding;
  const assertCurrent = () => {
    binding.assertCurrent();
    if (binding.agentId !== options.agentId || binding.path !== options.path) {
      throw new Error("Session entry read differs from its captured native owner");
    }
    capturedExecution?.execution.assertCurrent();
  };
  let retained: ReturnType<typeof retainSessionDatabaseRead> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const read = <Q extends SessionEntryReadQuery>(query: Q): SessionEntryExecutionRead<Q> => {
    if (closed) {
      throw new Error("Session entry reader is closed");
    }
    execution.assertCurrent();
    assertCurrent();
    if (captured && typeof captured.databaseIdentity !== "string") {
      throw new Error("Captured native session database differs from the enrolled worker owner");
    }
    retained ??= retainSessionDatabaseRead(binding, assertCurrent);
    const { env: _env, ...scope } = resolved;
    const value = retained.executeReady(
      retained.command(new URL(moduleUrl), {
        type: "session.metadata.entryRead",
        input: {
          scope: { ...scope, path: options.path },
          query,
          ...(captured
            ? {
                expected: {
                  identity: captured.databaseIdentity,
                  birthtime: captured.databaseBirthtime,
                  incarnation: capturedExecution?.incarnation,
                },
              }
            : {}),
        },
      }),
    );
    const reply =
      // The fixed metadata domain returns this original entryRead command's reply.
      // SAFETY: absence, ok and the matching query tag are checked below.
      value as SessionMetadataWorkerOperations["session.metadata.entryRead"]["output"] | undefined;
    if (!reply) {
      return { found: false };
    }
    if (!reply.ok || reply.value.result.kind !== query.kind) {
      throw new Error("Session entry read returned a different original query");
    }
    const source = captureWorkerSessionEntryReadSource(binding, reply.value);
    return {
      found: true,
      source,
      // SAFETY: the paired native query tag was checked; the canonical reader owns its value.
      value: reply.value.result.value as SessionEntryReadValues[Q["kind"]],
    };
  };
  return {
    read,
    databasePath: binding.path,
    // Binding validation survives releasing the borrow, so cleanup cannot hide revocation.
    assertCurrent,
    close() {
      closed = true;
      return (closing ??= (async () => {
        try {
          await retained?.close();
        } finally {
          await execution.release();
        }
      })());
    },
  };
}

/** Synchronous callers defer the same native join; async consumers explicitly await it. */
export function readSessionEntryThroughExecution<Q extends SessionEntryReadQuery>(
  resolved: ResolvedSqliteScope,
  query: Q,
  captured?: CapturedSessionEntryReadSource,
): SessionEntryExecutionRead<Q> | undefined {
  const reader = captureSessionEntryReadExecution(resolved, captured);
  if (!reader) {
    return undefined;
  }
  try {
    return reader.read(query);
  } finally {
    void reader.close().catch(() => undefined);
  }
}

export function decodeSessionEntryReadResult(
  read: SessionEntryExecutionRead<{ kind: "resolve-result" }>,
): Result<InternalSessionEntry | undefined, unknown> {
  if (!read.found) {
    return ok(undefined);
  }
  if (read.value.ok) {
    return read.value;
  }
  const error = new Error("Session entry selection failed");
  retainOpenClawStateWorkerErrorPayload(error, read.value.error);
  return err(hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }));
}

/** Incognito patch planning retains its original execution before queueing or updating. */
export function captureSessionEntryPatchExecution(
  resolved: ResolvedSqliteScope,
  captured?: WorkerReadSource,
) {
  const options = toDatabaseOptions(resolved);
  // Durable predicates can synchronously write the same database. Keep their
  // existing native commit owner instead of holding a worker BEGIN across them.
  if (
    !isMainThread ||
    !agentDatabaseLifecycle.gatewayExecution ||
    !isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options) ||
    !supportsOpenClawAgentDatabaseExecution(options)
  ) {
    return undefined;
  }
  const retained = captured?.[sourceExecution];
  const execution = retained
    ? retained.execution.borrow()
    : captureOpenClawAgentDatabaseExecution(options);
  const binding = execution.binding;
  if (execution.agentId !== options.agentId || execution.path !== resolved.path) {
    void execution.release();
    throw new Error("Captured session database differs from its patch execution");
  }
  const assertCurrent = () => {
    execution.assertCurrent();
    retained?.execution.assertCurrent();
    if (retained && retained.execution.incarnation !== binding.incarnation) {
      throw new Error("Captured session database changed before update");
    }
  };
  const { env: _env, ...scope } = resolved;
  let prepared: Snapshot | undefined;
  const assertSnapshot = (snapshot: Snapshot) => {
    assertCurrent();
    if (
      captured &&
      (snapshot.physical.identity !== captured.databaseIdentity ||
        snapshot.physical.birthtime !== captured.databaseBirthtime ||
        (retained && retained.incarnation !== snapshot.incarnation))
    ) {
      throw new Error("Captured session database changed before update");
    }
  };
  const execute = async <
    K extends "session.metadata.entrySnapshot" | "session.metadata.entryPatch",
  >(
    type: K,
    input: SessionMetadataOperations[K]["input"],
    callbacks?: { shouldCommit?: () => boolean; assertCommitAllowed?: () => void },
  ) => {
    assertCurrent();
    const host = captureOpenClawAgentHostExecution(options);
    let native: ReturnType<typeof host.beginNative> | undefined;
    let settlement: SqliteWorkerOperationSettlement | undefined;
    let tentative = false;
    const grants: Array<{
      admission: SqliteWorkerOperationAdmission;
      settlement?: SqliteWorkerOperationSettlement;
      tentative?: boolean;
      consumed?: boolean;
    }> = [];
    let receipt: Mutation | undefined;
    const publication =
      type === "session.metadata.entryPatch" && prepared
        ? retainSessionEntryWorkerPublication({
            agentId: resolved.agentId,
            storePath: execution.path,
            databaseIdentity: prepared.physical.identity,
            identityKind: execution.backend === "volatile" ? "volatile" : "file",
          })
        : undefined;
    let published: SettledPublication;
    let retainedOperation:
      | ReturnType<NonNullable<typeof execution.retainReadyOperation>>
      | undefined;
    const operationId =
      // Only snapshot/apply below call this private generic with matching tags and inputs.
      // SAFETY: the patch branch retains that input's original operationId.
      type === "session.metadata.entryPatch" ? (input as Patch).operationId : randomUUID();
    const seen = new Set<string>();
    const hostScope =
      callbacks &&
      createSqliteWorkerHostScope((step) => {
        if (
          !isRecord(step.value) ||
          step.value.operationId !== operationId ||
          seen.has(step.kind)
        ) {
          throw new Error("Session entry continuation differs from its original patch");
        }
        assertCurrent();
        seen.add(step.kind);
        if (step.kind === "entry-should-commit" && callbacks.shouldCommit) {
          return callbacks.shouldCommit();
        }
        if (step.kind === "entry-before-write" && callbacks.assertCommitAllowed) {
          callbacks.assertCommitAllowed();
          return undefined;
        }
        throw new Error("Session entry patch requested an unowned host continuation");
      }, binding.incarnation);
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent,
      requiresHostContinuation: Boolean(hostScope),
      createAdmission(owner) {
        return () => {
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          const original = createSqliteWorkerOperationAdmission(
            (request, grant) => {
              owner.authorize(request);
              assertCurrent();
              if (request.stage === "transaction" || request.stage === "commit") {
                const facts = isRecord(request.facts) ? request.facts.domain : undefined;
                if (
                  type !== "session.metadata.entryPatch" ||
                  !isRecord(facts) ||
                  facts.kind !== "session-entry.patch" ||
                  facts.operationId !== operationId ||
                  facts.databasePath !== execution.path ||
                  facts.sessionKey !== resolved.sessionKey ||
                  facts.incarnation !== prepared?.incarnation ||
                  (request.stage === "transaction" ? phase !== "waiting" : phase !== "transaction")
                ) {
                  throw new Error("Session entry admission differs from its retained patch");
                }
                if (request.stage === "commit" && facts.publication !== undefined) {
                  const publish = facts.publication;
                  if (
                    !isRecord(publish) ||
                    publish.kind !== "session-entry-replacements" ||
                    !Array.isArray(publish.changedKeys) ||
                    !publish.changedKeys.every((key): key is string => typeof key === "string") ||
                    !Array.isArray(publish.membershipInvalidatedKeys) ||
                    publish.membershipInvalidatedKeys.length !== 0
                  ) {
                    throw new Error("Session entry commit omitted its publication custody");
                  }
                  publication?.begin(publish.changedKeys, []);
                }
                phase = request.stage;
              }
              if (!grant()) {
                throw new Error("Session entry patch admission expired");
              }
            },
            owner.attachment,
            hostScope,
          );
          const retainedGrant: (typeof grants)[number] = { admission: original };
          grants.push(retainedGrant);
          return {
            admission: original,
            nativeLocations: owner.nativeLocations,
            stage() {
              tentative = true;
              retainedGrant.tentative = true;
            },
            settle(outcome) {
              settlement = retainedGrant.settlement = outcome.settlement;
              const facts = original.committed?.facts;
              let committedPublication: SessionEntryReplacementPublication | undefined;
              if (facts !== undefined) {
                if (
                  !isRecord(facts) ||
                  facts.operationId !== operationId ||
                  facts.incarnation !== prepared?.incarnation ||
                  facts.databasePath !== execution.path ||
                  facts.sessionKey !== resolved.sessionKey ||
                  !isRecord(facts.result)
                ) {
                  throw new Error("Session entry receipt differs from its retained patch");
                }
                // SAFETY: the paired canonical patch kernel owns this result and its COMMIT receipt.
                receipt = facts.result as Mutation;
                if (facts.publication !== undefined) {
                  if (
                    !isRecord(facts.publication) ||
                    facts.publication.kind !== "session-entry-replacements"
                  ) {
                    throw new Error("Session entry COMMIT omitted its publication receipt");
                  }
                  // SAFETY: the original native patch kernel records these facts only after COMMIT.
                  committedPublication = facts.publication as SessionEntryReplacementPublication;
                }
              }
              published = publication?.settle(committedPublication, settlement.kind === "unknown");
              retainedGrant.consumed = true;
            },
          };
        };
      },
    };
    let value: SessionMetadataOperations[K]["output"] | undefined;
    let failure: { error: unknown } | undefined;
    try {
      native = host.beginNative();
      hostScope?.bindHostExecution(native.runHostStep);
      const command = {
        type: "database.domain.run" as const,
        input: {
          id: operationId,
          moduleUrl,
          input: undefined,
          command: { type, input },
          ...(hostScope ? { scoped: true as const } : {}),
        },
      };
      retainedOperation = execution.retainReadyOperation?.(source, { createIfMissing: true });
      // Preparation has its own grant. It cannot borrow the patch's transaction authority.
      if (!retainedOperation) {
        await execution.prepare({
          assertCurrent,
          requiresHostContinuation: false,
          createAdmission(owner) {
            return () => {
              const preparation = createSqliteWorkerOperationAdmission((request, grant) => {
                if (request.stage !== "open" && request.stage !== "prepare") {
                  throw new Error("Session entry preparation cannot grant a patch");
                }
                owner.authorize(request);
                assertCurrent();
                if (!grant()) {
                  throw new Error("Session entry preparation expired");
                }
              }, owner.attachment);
              const retainedGrant: (typeof grants)[number] = { admission: preparation };
              grants.push(retainedGrant);
              return {
                nativeLocations: owner.nativeLocations,
                admission: preparation,
                settle(outcome) {
                  retainedGrant.settlement = outcome.settlement;
                  retainedGrant.consumed = true;
                },
              };
            };
          },
        });
      }
      const result = await (retainedOperation
        ? retainedOperation.execute(command)
        : execution.runExisting(source, (writer) => writer.execute(command)));
      // The fixed metadata domain returns this original command's reply.
      // SAFETY: ok precedes use; receipt precedence and all-attempt cleanup remain intact.
      const response = result as SessionMetadataWorkerOperations[K]["output"] | undefined;
      if (!response?.ok) {
        throw new Error("Session entry execution did not return its original result");
      }
      value = response.value;
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await retainedOperation?.close();
      } catch (error) {
        failure = {
          error: failure
            ? new AggregateError(
                [failure.error, error],
                "Session entry execution and close failed",
                { cause: failure.error },
              )
            : error,
        };
      }
      try {
        if (
          grants.every(
            (grant) =>
              (grant.consumed &&
                (grant.settlement?.kind === "completed" ||
                  grant.settlement?.kind === "not-entered")) ||
              (grant.tentative && grant.admission.tentative),
          )
        ) {
          native?.settle();
        }
      } catch (error) {
        failure = {
          error: failure
            ? new AggregateError(
                [failure.error, error],
                "Session entry outcome and ownership failed",
                { cause: failure.error },
              )
            : error,
        };
      }
      try {
        hostScope?.close();
      } catch (error) {
        failure = {
          error: failure
            ? new AggregateError(
                [failure.error, error],
                "Session entry outcome and scope close failed",
                { cause: failure.error },
              )
            : error,
        };
      }
    }
    const hostFailure =
      failure && !receipt
        ? hostScope?.restoreHostFailure(failure.error, grants.at(-1)?.admission.settlement)
        : undefined;
    if (hostFailure) {
      failure = hostFailure;
    }
    return { value, receipt, tentative, failure, publication: () => published };
  };
  return {
    binding,
    async snapshot(selection: SessionEntryPatchSelection) {
      const result = await execute("session.metadata.entrySnapshot", { scope, selection });
      if (result.failure) {
        throw result.failure.error;
      }
      if (!result.value) {
        throw new Error("Session entry snapshot was not delivered");
      }
      assertSnapshot(result.value);
      prepared = result.value;
      return prepared.prepared;
    },
    async apply(
      input: Omit<
        Patch,
        "scope" | "operationId" | "incarnation" | "shouldCommit" | "assertCommitAllowed"
      >,
      callbacks: Pick<SessionEntryPatchOptions, "assertCommitAllowed"> & {
        shouldCommit?: () => boolean;
      },
      publish: (
        result: Mutation,
        publication: SettledPublication,
        databaseIdentity: string,
      ) => void,
    ) {
      if (!prepared) {
        throw new Error("Session entry patch has no original snapshot");
      }
      assertCurrent();
      const databaseIdentity = prepared.physical.identity;
      const result = await execute(
        "session.metadata.entryPatch",
        {
          ...input,
          scope,
          operationId: randomUUID(),
          incarnation: prepared.incarnation,
          shouldCommit: Boolean(callbacks.shouldCommit),
          assertCommitAllowed: Boolean(callbacks.assertCommitAllowed),
        },
        callbacks,
      );
      const mutation = result.receipt ?? result.value;
      if (mutation) {
        // Nested results stay tentative; read the canonical filtered identity only
        // when the original outer receipt has settled and publication can run.
        const publishCommitted = () => publish(mutation, result.publication(), databaseIdentity);
        if (result.tentative) {
          if (!deferSqliteWorkerCallerPublication(publishCommitted)) {
            throw new Error("Tentative session entry patch lost its original caller scope");
          }
        } else if (result.receipt) {
          publishCommitted();
        }
      } else {
        result.publication()?.publish();
      }
      if (result.failure) {
        throw result.failure.error;
      }
      if (!mutation) {
        throw new Error("Session entry patch has no native outcome");
      }
      return mutation.entry;
    },
    close: () => execution.release(),
  };
}
