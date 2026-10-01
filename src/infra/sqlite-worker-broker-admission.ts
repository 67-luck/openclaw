import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import { INCOGNITO_AGENT_SQLITE_BASENAME } from "../state/openclaw-agent-db.paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import {
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  type StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type {
  PreparedSqliteWorkerOpen,
  SqliteWorkerStoreOptions,
  Actor,
  Job,
  SqliteWorkerOpenCustody,
} from "./sqlite-worker-broker.types.js";
import { readDatabasePathIdentity, type DatabasePathIdentity } from "./sqlite-worker-identity.js";
import {
  createSqliteWorkerAdmissionFactory,
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import {
  captureSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "./sqlite-worker-state-context.js";

/** Queued and direct descendants retain the same captured maintenance/schema owner. */
export function bindSqliteWorkerDatabaseAuthority(
  admission: SqliteWorkerOperationAdmission,
  databasePath: string,
  maintenanceScope: OpenClawDatabaseMaintenanceScope | undefined,
  assertRequest: () => void,
  assertCurrent: () => void,
): void {
  let schemaLease: StateDatabaseSchemaLease | undefined;
  const assertAccess = () => {
    assertCurrent();
    maintenanceScope?.assertAdmission();
    assertStateDatabaseAccessAllowed(databasePath, { maintenanceScope, schemaLease });
  };
  admission.bindDatabaseAuthority({
    databasePath,
    assertRequest,
    assertAccess,
    acquireSchema() {
      assertAccess();
      const acquire = () => acquireStateDatabaseSchemaLease(databasePath);
      const lease = maintenanceScope ? maintenanceScope.run(acquire) : acquire();
      schemaLease = lease;
      maintenanceScope?.own(lease, "shared-resources", () => lease.release());
      return {
        assertCurrent() {
          assertAccess();
          lease.assertCurrent();
        },
        release: () => lease.release(),
      };
    },
  });
}

export function validateSqliteWorkerDatabaseLocator(databasePath: string): void {
  const basename = path.basename(databasePath);
  if (
    !databasePath ||
    databasePath.startsWith("file:") ||
    basename === ":memory:" ||
    basename === INCOGNITO_AGENT_SQLITE_BASENAME
  ) {
    throw new Error(
      "SQLite worker stores require a file-backed filesystem path; in-memory and incognito databases are not supported",
    );
  }
}

export function captureSqliteWorkerOpen(
  options: SqliteWorkerStoreOptions,
  stateContext?: SqliteWorkerStateContext,
  assertCurrent?: () => void,
  custody: SqliteWorkerOpenCustody = {},
): PreparedSqliteWorkerOpen {
  const { createAdmission, preparation, ...native } = custody;
  const inCaller = createAdmission ? AsyncLocalStorage.snapshot() : undefined;
  const ownedAdmission = options.admission;
  const assertOpening = ownedAdmission
    ? () => {
        assertCurrent?.();
        ownedAdmission.assertCurrent();
      }
    : assertCurrent;
  if (custody.volatile && (options.existingOnly || options.admission)) {
    throw new Error("Volatile SQLite admission cannot borrow a durable database owner");
  }
  if (custody.volatile && stateContext && !custody.stateDatabasePath) {
    throw new Error("Volatile lifecycle preparation requires its separate shared-state owner");
  }
  const databasePath = custody.volatile
    ? `volatile:${custody.volatile.id}`
    : path.resolve(options.databasePath);
  if (
    options.admission &&
    (!options.existingOnly || !options.admission.identity.startsWith("file:"))
  ) {
    throw new Error("Owned SQLite Worker admission requires an existing physical identity");
  }
  assertOpening?.();
  const carrier = resolveRuntimeProcessEntrypointUrl("sqliteStore");
  const carrierUrl = options.runtimeGeneration?.resolve(carrier) ?? carrier;
  // Normal Node actors share one serviced carrier from first open, including
  // durable actors opened before Gateway enrollment. Retained sources stay direct.
  const transport =
    custody.volatile || (!process.versions.bun && !options.runtimeGeneration)
      ? resolveRuntimeProcessEntrypointUrl("sqliteTransport")
      : undefined;
  return {
    ...native,
    maintenanceScope: custody.maintenanceScope ?? getOpenClawDatabaseMaintenanceScope(),
    ...(preparation !== undefined ? { preparation: serialize(preparation) } : {}),
    runtimeGeneration: options.runtimeGeneration,
    carrierUrl,
    transportUrl: transport && (options.runtimeGeneration?.resolve(transport) ?? transport),
    createAdmission:
      createAdmission && inCaller
        ? createSqliteWorkerAdmissionFactory(
            createAdmission.requiresHostContinuation,
            (operation) => inCaller(createAdmission, operation),
          )
        : undefined,
    assertCurrent: assertOpening,
    ...(options.admission
      ? {
          expectedIdentity: options.admission.identity,
          createOpenAdmission: createSqliteWorkerAdmissionFactory(false, () => {
            let granted = false;
            return {
              nativeLocations: [databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                if (granted || request.stage !== "open") {
                  throw new Error("SQLite Worker open admission requested out of order");
                }
                assertOpening!();
                if (!grant()) {
                  throw new Error("SQLite Worker open admission expired");
                }
                granted = true;
              }),
            };
          }),
        }
      : {}),
    moduleUrl: new URL(options.moduleUrl),
    databasePath,
    input: serialize(options.input),
    existingOnly: options.existingOnly === true,
    ...(stateContext ? { stateContext: captureSqliteWorkerStateContext(stateContext) } : {}),
  };
}

function validateSqliteWorkerModuleUrl(moduleUrl: URL): void {
  if (moduleUrl.protocol !== "file:" || moduleUrl.search || moduleUrl.hash) {
    throw new Error("SQLite worker backend must be a static local module URL");
  }
}

export async function prepareSqliteWorkerDatabaseAdmission(options: PreparedSqliteWorkerOpen) {
  validateSqliteWorkerModuleUrl(options.moduleUrl);
  const databasePath = options.volatile ? options.databasePath : path.resolve(options.databasePath);
  const inputHash = createHash("sha256").update(options.input).digest("hex");
  const identity = options.volatile
    ? { key: databasePath, canonicalPath: databasePath }
    : await readDatabasePathIdentity(databasePath);
  options.assertCurrent?.();
  if (options.expectedIdentity && identity.key !== options.expectedIdentity) {
    throw new Error("SQLite Worker path no longer matches its borrowed native owner");
  }
  return { databasePath, inputHash, identity };
}

export function captureSqliteWorkerAdmissionPaths(
  databasePath: string,
  identity: DatabasePathIdentity,
  actors: Iterable<Actor>,
): Set<string> {
  const admittedPaths = new Set([databasePath, identity.canonicalPath]);
  if (
    [...actors].some(
      (entry) =>
        entry.key !== identity.key &&
        [...admittedPaths].some((pathname) => entry.pathReferences.has(pathname)),
    )
  ) {
    throw new Error(
      "SQLite database pathname changed while its worker owner is active; close the existing store first",
    );
  }
  return admittedPaths;
}

export function retainSqliteWorkerAdmissionCleanup(
  actor: Actor,
  retain: PreparedSqliteWorkerOpen["retainCleanup"],
  close: () => Promise<void>,
): void {
  retain?.({
    get pending() {
      return actor.references === 0 && actor.cleanupState === "pending";
    },
    close: () => (actor.references === 0 ? close() : Promise.resolve()),
  });
}

export function retainSqliteWorkerAdmissionPathReferences(actor: Actor, paths: Set<string>) {
  for (const pathname of paths) {
    actor.pathReferences.set(pathname, (actor.pathReferences.get(pathname) ?? 0) + 1);
  }
  return () => {
    for (const pathname of paths) {
      const references = actor.pathReferences.get(pathname) ?? 0;
      if (references > 1) {
        actor.pathReferences.set(pathname, references - 1);
      } else {
        actor.pathReferences.delete(pathname);
      }
    }
  };
}

export async function resolveOpenedSqliteWorkerIdentity(
  databasePath: string,
  previous: DatabasePathIdentity,
  isOwnedElsewhere: (key: string) => boolean,
): Promise<string> {
  const openedIdentity = await readDatabasePathIdentity(databasePath);
  const physical = openedIdentity.key;
  if (openedIdentity.canonicalPath !== previous.canonicalPath) {
    throw new Error("SQLite database canonical pathname changed during open");
  }
  if (!physical.startsWith("file:")) {
    throw new Error("SQLite worker backend did not establish its database file");
  }
  if (isOwnedElsewhere(physical)) {
    throw new Error("SQLite database identity collided with an existing worker owner during open");
  }
  if (previous.key.startsWith("file:") && physical !== previous.key) {
    throw new Error("SQLite database file identity changed during open");
  }
  return physical;
}

export function findUnclaimedSharedStateActors(
  actors: Iterable<Actor>,
  databasePath: string,
): Actor[] {
  const pathname = path.resolve(databasePath);
  return [...actors].filter(
    (actor) =>
      actor.stateContext !== undefined &&
      actor.references === 0 &&
      actor.cleanupState === "pending" &&
      actor.databasePath === pathname,
  );
}

export async function closeUnclaimedSharedStateActors(
  actors: Iterable<Actor>,
  databasePath: string,
  close: (actor: Actor) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    findUnclaimedSharedStateActors(actors, databasePath).map(close),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "SQLite worker unclaimed cleanup failed", {
      cause: errors[0],
    });
  }
}

export async function resolveSqliteWorkerModuleUrl(sourceUrl: URL) {
  const modulePath = await realpath(fileURLToPath(sourceUrl));
  const moduleUrl = pathToFileURL(modulePath).href;
  if (!/\.[cm]?[jt]s$/.test(modulePath) || !(await stat(modulePath)).isFile()) {
    throw new Error("SQLite worker backend must identify a JavaScript or TypeScript file");
  }
  return { modulePath, moduleUrl };
}

function assertSqliteWorkerActorStateContext(
  actor: Actor,
  stateContext: SqliteWorkerStateContext | undefined,
): void {
  if (actor.stateContext?.existingSchemaPath !== stateContext?.existingSchemaPath) {
    throw new Error("Shared-state worker schema policy changed; close its actor first");
  }
}

export function assertSqliteWorkerActorReusable(
  actor: Actor,
  moduleUrl: string,
  inputHash: string,
  stateContext: SqliteWorkerStateContext | undefined,
): void {
  if (actor.slot.failed) {
    throw actor.slot.failed;
  }
  if (actor.moduleUrl !== moduleUrl || actor.inputHash !== inputHash) {
    throw new Error("SQLite database already belongs to another worker backend");
  }
  assertSqliteWorkerActorStateContext(actor, stateContext);
}

export function prepareSqliteWorkerActorContext(actor: Actor | undefined, job: Job): void {
  const { request } = job;
  const stateContext = request.stateContext ?? actor?.stateContext;
  // A drained actor retains native disposal custody after its caller loses admission.
  if (actor && request.type !== "close") {
    assertStateDatabaseAccessAllowed(actor.stateDatabasePath ?? actor.databasePath, {
      maintenanceScope: job.maintenanceScope,
    });
  }
  if (actor && stateContext) {
    assertSqliteWorkerActorStateContext(actor, stateContext);
    request.stateDatabasePath = actor.stateDatabasePath ?? actor.databasePath;
    request.stateContext = stateContext;
  }
}
