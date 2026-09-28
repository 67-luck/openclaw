import path from "node:path";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { listActiveSessionPendingInputs } from "./session-accessor.sqlite-active-pending-inputs.js";
import {
  captureActiveSessionPendingInputs,
  type SessionPendingInput,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type ActivePendingPage = ReturnType<typeof listActiveSessionPendingInputs>;

export async function prepareActiveSessionPendingInputsInWorker(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  options: { before?: number; limit: number; page?: ActivePendingPage },
) {
  const { page: providedPage, ...paging } = options;
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
  // A complete retained page already read this scope; do not repeat its database work.
  const resolved =
    incognito || providedPage ? resolveSqliteScope(captured) : await prepareSqliteScope(captured);
  assertCurrent();
  const databaseOptions = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const custody = captureActiveSessionPendingInputs({
    databasePath,
    sessionKey: resolved.sessionKey,
    sessionId: captured.sessionId,
    ...(providedPage ? { inputIds: providedPage.items.map((item) => item.id) } : {}),
  });
  let page: ActivePendingPage = providedPage ?? { items: [] };
  if (!providedPage && custody.inputIds.length) {
    const input = {
      agentId: resolved.agentId,
      sessionKey: resolved.sessionKey,
      sessionId: captured.sessionId,
      env: captured.env,
      inputIds: custody.inputIds,
      ...paging,
    };
    page = incognito
      ? (
          await import("./session-accessor.sqlite-active-pending-inputs.js")
        ).listActiveSessionPendingInputs(captured, { inputIds: custody.inputIds, ...paging })
      : await withSessionHistoryWorkerDatabase(
          { ...databaseOptions, path: databasePath },
          (owner) => owner.readActivePendingInputs(input),
        );
  }
  assertCurrent();
  return {
    page,
    // Projection and history preparation may await after the read. Borrow custody at publication.
    selectCurrent(items: SessionPendingInput[]) {
      assertCurrent();
      return items.filter((item) => item.state !== "queued" || custody.isCurrent(item.id));
    },
  };
}
