import path from "node:path";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { listActiveSessionPendingInputs } from "./session-accessor.sqlite-active-pending-inputs.js";
import { captureActiveSessionPendingInputs } from "./session-accessor.sqlite-pending-inputs.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export async function readActiveSessionPendingInputsInWorker(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  options: { before?: number; limit: number },
): Promise<ReturnType<typeof listActiveSessionPendingInputs>> {
  const captured = {
    ...scope,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
  const assertCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const incognito = isIncognitoSessionKey(captured.sessionKey);
  const resolved = incognito ? resolveSqliteScope(captured) : await prepareSqliteScope(captured);
  assertCurrent();
  const databaseOptions = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const custody = captureActiveSessionPendingInputs({
    databasePath,
    sessionKey: resolved.sessionKey,
    sessionId: captured.sessionId,
  });
  if (!custody.inputIds.length) {
    return { items: [] };
  }
  const input = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    sessionId: captured.sessionId,
    env: captured.env,
    inputIds: custody.inputIds,
    ...options,
  };
  const page = incognito
    ? (
        await import("./session-accessor.sqlite-active-pending-inputs.js")
      ).listActiveSessionPendingInputs(captured, { inputIds: custody.inputIds, ...options })
    : await withSessionHistoryWorkerDatabase({ ...databaseOptions, path: databasePath }, (owner) =>
        owner.readActivePendingInputs(input),
      );
  assertCurrent();
  // Finish, consumption, or lifecycle replacement during the read cannot resurrect a queue row.
  return { ...page, items: page.items.filter((item) => custody.isCurrent(item.id)) };
}
