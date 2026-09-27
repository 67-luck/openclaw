import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isPathInside } from "../infra/path-guards.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawAgentDatabaseAsyncResource = {
  agentId: string;
  path: string;
  revoke: () => void;
  close: () => Promise<void>;
};
export type OpenClawAgentDatabaseReadCandidateResource = Omit<
  OpenClawAgentDatabaseAsyncResource,
  "agentId"
> & { scope?: "sibling-family" };
type AgentDatabaseResource = (
  | (OpenClawAgentDatabaseAsyncResource & { ownership: "known"; closeSync?: () => void })
  | (OpenClawAgentDatabaseReadCandidateResource & {
      ownership: "unresolved";
      agentId?: never;
    })
) & { onRetirement?: (attempt: Promise<void>) => void };
export type AgentDatabaseCloseSelection = {
  path?: string;
  rootPath?: string;
  agentId?: string;
};

export class AgentDatabaseResourceAdmissionError extends Error {
  readonly retirements: readonly Promise<void>[] | undefined;

  constructor(pathname: string, retirements?: readonly Promise<void>[]) {
    super(`Agent database resources are closing: ${pathname}`);
    this.retirements = retirements && Object.freeze([...retirements]);
  }
}

const resources = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseAsyncResources"),
  () => ({
    active: new Set<AgentDatabaseResource>(),
    closing: new Map<AgentDatabaseResource, Promise<void> | undefined>(),
    selections: new Map<AgentDatabaseCloseSelection, Promise<void>>(),
  }),
);

/** CLI cleanup can skip loading native database owners when no Worker was admitted. */
export function hasOpenClawAgentDatabaseAsyncResources(): boolean {
  return resources.active.size > 0 || resources.closing.size > 0;
}

/** Observe an existing full close without revoking resources or selecting a successor. */
export function captureAgentDatabaseCloseFence(
  target: Pick<OpenClawAgentDatabaseAsyncResource, "agentId" | "path">,
): Promise<void> | undefined {
  const owned = { agentId: normalizeAgentId(target.agentId), path: path.resolve(target.path) };
  const pending = [...resources.selections].flatMap(([selection, completion]) =>
    matchesAgentDatabaseClose(selection, owned) ? [completion] : [],
  );
  return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
}

/** Match captured read custody without inspecting files or inferring their owners. */
export function matchesAgentDatabaseReadCandidatePath(
  candidate: Pick<OpenClawAgentDatabaseReadCandidateResource, "path" | "scope">,
  pathname: string,
): boolean {
  const capturedPath = path.resolve(candidate.path);
  const resolvedPath = path.resolve(pathname);
  if (capturedPath === resolvedPath) {
    return true;
  }
  if (candidate.scope !== "sibling-family") {
    return false;
  }
  const captured = path.parse(capturedPath);
  const selected = path.parse(resolvedPath);
  return (
    selected.dir === captured.dir &&
    selected.base.startsWith(`${captured.name}.`) &&
    selected.base.endsWith(captured.ext)
  );
}

export function matchesAgentDatabaseClose(
  selection: AgentDatabaseCloseSelection,
  resource:
    | { agentId: string; path: string; ownership?: "known" }
    | (Pick<OpenClawAgentDatabaseReadCandidateResource, "path" | "scope"> & {
        agentId?: never;
        ownership: "unresolved";
      }),
): boolean {
  return (
    (selection.path === undefined ||
      selection.path === resource.path ||
      (resource.ownership === "unresolved" &&
        matchesAgentDatabaseReadCandidatePath(resource, selection.path))) &&
    (selection.rootPath === undefined ||
      isPathInside(selection.rootPath, resource.path) ||
      (resource.ownership === "unresolved" &&
        matchesAgentDatabaseReadCandidatePath(resource, selection.rootPath))) &&
    (selection.agentId === undefined ||
      resource.ownership === "unresolved" ||
      selection.agentId === resource.agentId)
  );
}

/** Register before admitting a Worker; revocation is synchronous, native drainage is joined. */
export function registerOpenClawAgentDatabaseAsyncResource(
  resource: OpenClawAgentDatabaseAsyncResource,
  onRetirement?: (attempt: Promise<void>) => void,
): () => void {
  return registerAgentDatabaseResource({
    ...resource,
    ownership: "known",
    agentId: normalizeAgentId(resource.agentId),
    onRetirement,
  });
}

/** Native readers close synchronously, so successful retirement leaves no asynchronous barrier. */
export function registerOpenClawAgentDatabaseSyncResource(
  resource: Omit<OpenClawAgentDatabaseAsyncResource, "close"> & { close: () => void },
): () => void {
  return registerAgentDatabaseResource({
    ...resource,
    ownership: "known",
    agentId: normalizeAgentId(resource.agentId),
    close: async () => resource.close(),
    closeSync: resource.close,
  });
}

/** Retain discovery until the known owner is registered, then release this candidate. */
export function registerOpenClawAgentDatabaseReadCandidateResource(
  resource: OpenClawAgentDatabaseReadCandidateResource,
): () => void {
  return registerAgentDatabaseResource({ ...resource, ownership: "unresolved" });
}

function registerAgentDatabaseResource(resource: AgentDatabaseResource): () => void {
  const owned = {
    ...resource,
    path: path.resolve(resource.path),
  };
  const selected = [...resources.selections.keys()].some((selection) =>
    matchesAgentDatabaseClose(selection, owned),
  );
  const blockers = [...resources.closing]
    .filter(
      ([closing]) =>
        (closing.path === owned.path ||
          (closing.ownership === "unresolved" &&
            matchesAgentDatabaseReadCandidatePath(closing, owned.path)) ||
          (owned.ownership === "unresolved" &&
            matchesAgentDatabaseReadCandidatePath(owned, closing.path))) &&
        (closing.ownership === "unresolved" ||
          owned.ownership === "unresolved" ||
          closing.agentId === owned.agentId),
    )
    .map(([, attempt]) => attempt);
  if (selected || blockers.length > 0) {
    // Only existing individual attempts can release this refusal. Active drains and
    // failed custody require their owner, not an admission-triggered cleanup retry.
    throw new AgentDatabaseResourceAdmissionError(
      owned.path,
      !selected && blockers.every((attempt) => attempt !== undefined) ? blockers : undefined,
    );
  }
  const unregister = () => resources.active.delete(owned);
  getOpenClawDatabaseMaintenanceScope()?.own(unregister, "agent-resources", () =>
    closeAgentDatabaseResource(owned),
  );
  resources.active.add(owned);
  return unregister;
}

function closeAgentDatabaseResource(
  resource: AgentDatabaseResource,
  onCloseError?: (pathname: string, error: unknown) => void,
): Promise<void> {
  if (resource.ownership === "known" && resource.closeSync) {
    resources.closing.set(resource, undefined);
    try {
      resource.revoke();
      resource.closeSync();
      resources.active.delete(resource);
      resources.closing.delete(resource);
      return Promise.resolve();
    } catch (error) {
      if (onCloseError) {
        onCloseError(resource.path, error);
      }
      const failed = Promise.reject<void>(toErrorObject(error, "Agent database cleanup failed"));
      void failed.catch(() => {});
      return failed;
    }
  }
  let operation = resources.closing.get(resource);
  if (!operation) {
    operation = Promise.resolve()
      .then(() => resource.close())
      .then(
        () => {
          resources.active.delete(resource);
          resources.closing.delete(resource);
        },
        (error: unknown) => {
          // Keep exact custody even if the actor unregisters while its close fails.
          resources.closing.set(resource, undefined);
          throw error;
        },
      );
    resources.closing.set(resource, operation);
    void operation.catch(() => {});
  }
  if (onCloseError) {
    void operation.catch((error: unknown) => onCloseError(resource.path, error)).catch(() => {});
  }
  // Publish the exact barrier-removing attempt before revoke can schedule a successor.
  try {
    resource.onRetirement?.(operation);
  } finally {
    resource.revoke();
  }
  return operation;
}

export function revokeAgentDatabaseResources(
  selection: AgentDatabaseCloseSelection,
  onCloseError?: (pathname: string, error: unknown) => void,
): Promise<void>[] {
  const closing = new Set([...resources.active, ...resources.closing.keys()]);
  const pending: Promise<void>[] = [];
  for (const resource of closing) {
    if (!matchesAgentDatabaseClose(selection, resource)) {
      continue;
    }
    pending.push(closeAgentDatabaseResource(resource, onCloseError));
  }
  return pending;
}

export async function drainAgentDatabaseResources<T>(
  selection: AgentDatabaseCloseSelection,
  closeNative: () => Promise<T>,
): Promise<T> {
  const ownedSelection = { ...selection };
  const completion = createDeferredCore();
  // A close may have no observer; its caller still receives the original failure.
  void completion.promise.catch(() => {});
  resources.selections.set(ownedSelection, completion.promise);
  try {
    const results = await Promise.allSettled(revokeAgentDatabaseResources(ownedSelection));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent database resource drainage failed");
    }
    const result = await closeNative();
    completion.resolve();
    return result;
  } catch (error) {
    completion.reject(error);
    throw error;
  } finally {
    resources.selections.delete(ownedSelection);
  }
}
