import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { hasAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseGenerationClaim,
  AgentDatabaseNativeGeneration,
} from "./openclaw-agent-execution-contract.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

export function createAgentDatabaseFileReferenceGuard(params: {
  assertCurrent: () => void;
  borrowedPath: string;
  canonicalPath: string;
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  creatingTarget?: DatabasePathIdentity;
  readFileIdentity: () => AgentDatabaseExecutionFileIdentity | undefined;
}): (nativeIdentity?: AgentDatabaseExecutionFileIdentity) => void {
  const { borrowedPath, canonicalPath, expectedIdentity, creatingTarget } = params;
  return (nativeIdentity) => {
    params.assertCurrent();
    const fileIdentity = params.readFileIdentity();
    if (!fileIdentity || creatingTarget) {
      const current = readDatabasePathIdentitySync(borrowedPath);
      if (
        current.canonicalPath !== canonicalPath ||
        (creatingTarget?.key.startsWith("file:") &&
          (current.key !== creatingTarget.key || current.birthtime !== creatingTarget.birthtime))
      ) {
        throw new Error("Agent database borrower changed its originally observed target");
      }
    }
    if (
      fileIdentity &&
      expectedIdentity &&
      (fileIdentity.physicalIdentity !== expectedIdentity.physicalIdentity ||
        (fileIdentity.birthtime !== undefined &&
          expectedIdentity.birthtime !== undefined &&
          fileIdentity.birthtime !== expectedIdentity.birthtime))
    ) {
      throw new Error("Agent database borrower belongs to another physical file");
    }
    const file = fileIdentity ?? expectedIdentity;
    const birthtime = fileIdentity?.birthtime ?? expectedIdentity?.birthtime;
    if (file) {
      if (
        nativeIdentity &&
        (nativeIdentity.physicalIdentity !== file.physicalIdentity ||
          (birthtime !== undefined && nativeIdentity.birthtime !== birthtime))
      ) {
        throw new Error("Agent database borrower belongs to another physical file");
      }
      // The native owner validates its own path last; a borrowed alias has a separate lifetime.
      if (!nativeIdentity || borrowedPath !== nativeIdentity.nativeLocation) {
        assertExistingDatabaseIdentity(borrowedPath, `file:${file.physicalIdentity}`, birthtime);
      }
    }
  };
}

export function supportsAgentDatabaseExecutionScope(
  options: OpenClawAgentDatabaseOptions,
): boolean {
  return (
    getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance !== true &&
    !hasAgentDatabaseMaintenanceAuthority() &&
    !getAgentDeletionDatabaseCleanup(options)
  );
}

/** These native-only scopes still need their complete owning caller cutover. */
export function supportsOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
): boolean {
  return (
    !isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options) &&
    supportsAgentDatabaseExecutionScope(options)
  );
}

/** Bind a native claim to the same borrower and logical generation that captured it. */
export function captureBorrowedAgentDatabaseGenerationClaim(
  assertBorrowed: () => void,
  readGeneration: () => AgentDatabaseNativeGeneration | undefined,
): AgentDatabaseGenerationClaim {
  assertBorrowed();
  const captured = readGeneration();
  if (!captured) {
    throw new Error("Agent database execution has no admitted generation");
  }
  const claim = captured.captureClaim();
  return {
    identity: claim.identity,
    incarnation: claim.incarnation,
    assertCurrent() {
      assertBorrowed();
      if (readGeneration() !== captured) {
        throw new Error("Agent database execution generation was replaced");
      }
      claim.assertCurrent();
    },
  };
}
