import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { hasAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

function supportsAgentDatabaseExecutionScope(options: OpenClawAgentDatabaseOptions): boolean {
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
    (!isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options) ||
      agentDatabaseLifecycle.gatewayExecution?.phase === "ready") &&
    supportsAgentDatabaseExecutionScope(options)
  );
}
