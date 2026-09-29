import { lstatSync, type BigIntStats } from "node:fs";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { pinDirectory } from "../infra/directory-durability.js";
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

/** Pins the admitted object until all add effects have settled. */
export async function pinAdoptedWorkspace(workspace: string, workspaceState: BigIntStats) {
  const pin = await pinDirectory({
    path: workspace,
    realPath: workspace,
    identity: workspaceState,
  });
  return {
    assertCurrent: () => assertAdoptedWorkspaceCurrent(workspace, workspaceState),
    close: () => pin.close(),
  };
}

// The retained directory handle prevents inode reuse; timestamps can change on child writes.
function assertAdoptedWorkspaceCurrent(workspace: string, workspaceState: BigIntStats): void {
  assertWorkspacePathUnchanged(workspace);
  let current: BigIntStats | undefined;
  try {
    current = lstatSync(workspace, { bigint: true });
  } catch {
    // Missing or unreadable roots cannot authorize filesystem or config effects.
  }
  if (
    !current?.isDirectory() ||
    current.dev !== workspaceState.dev ||
    current.ino !== workspaceState.ino
  ) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Adoptable workspace ${JSON.stringify(workspace)} changed after admission.`,
    );
  }
}
