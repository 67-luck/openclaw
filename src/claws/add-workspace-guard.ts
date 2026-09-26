import { lstatSync, type Stats } from "node:fs";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { ClawAddMutationError } from "./add-errors.js";

function workspacePathKey(value: string): string {
  return process.platform === "win32" ? normalizeWindowsPathForComparison(value) : value;
}

/** Reject ancestry changes since planning. */
export function assertWorkspacePathUnchanged(workspace: string): void {
  const canonicalWorkspace = resolvePathViaExistingAncestorSync(workspace);
  if (workspacePathKey(canonicalWorkspace) !== workspacePathKey(workspace)) {
    throw new ClawAddMutationError(
      "workspace_path_changed",
      `Workspace ancestry changed after planning: expected ${JSON.stringify(workspace)}, resolved ${JSON.stringify(canonicalWorkspace)}.`,
    );
  }
}

/** Revalidates the admitted directory immediately before filesystem or config effects. */
export function assertAdoptedWorkspaceCurrent(
  workspace: string,
  workspaceState: Stats | undefined,
): void {
  assertWorkspacePathUnchanged(workspace);
  let current: Stats | undefined;
  try {
    current = lstatSync(workspace);
  } catch {
    // Missing or unreadable roots cannot authorize filesystem or config effects.
  }
  if (
    !current?.isDirectory() ||
    !workspaceState ||
    current.dev !== workspaceState.dev ||
    current.ino !== workspaceState.ino ||
    current.birthtimeMs !== workspaceState.birthtimeMs
  ) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Adoptable workspace ${JSON.stringify(workspace)} changed after admission.`,
    );
  }
}
