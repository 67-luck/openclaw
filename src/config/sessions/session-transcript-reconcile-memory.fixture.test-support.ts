import fs from "node:fs";
import { afterEach, beforeEach, expect } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";

export const agentId = "secondary";
export const sessionId = "memory-reconcile";
const sessionKey = "agent:secondary:dashboard:incognito-reconcile";
export const message = (id: string, content = id): TranscriptEvent => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "user", content },
});
export function useMemoryReconcileFixture(
  onSetup: (ambient: OpenClawTestState, explicit: OpenClawTestState) => void,
) {
  let ambient: OpenClawTestState;
  let explicit: OpenClawTestState;

  beforeEach(async () => {
    ambient = await createOpenClawTestState({ prefix: "memory-reconcile-ambient-" });
    explicit = await createOpenClawTestState({
      prefix: "memory-reconcile-explicit-",
      applyEnv: false,
    });

    onSetup(ambient, explicit);
  });

  afterEach(async () => {
    for (const state of [explicit, ambient]) {
      await waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir);
      closeOpenClawAgentDatabaseByPath(
        resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env }),
      );
      await state.cleanup();
    }
  });

  function target(env: NodeJS.ProcessEnv | undefined) {
    const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
    return {
      options: { agentId, env, path },
      scope: { agentId, env, sessionId, sessionKey, storePath: path },
    };
  }

  function expectNoDiskState() {
    expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    expect(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
  }

  function seedDelegatedManager(id: string) {
    const sessionTarget = {
      agentId: id,
      sessionId: id,
      sessionKey: `agent:${id}:dashboard:incognito-delegated`,
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: id, env: ambient.env }),
      env: ambient.env,
    };
    const manager = SessionManager.open(sessionTarget, ambient.workspaceDir);
    const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
    return {
      target: sessionTarget,
      manager,
      dirty() {
        manager.branch(root);
        return manager.appendCustomEntry("delegated-reconcile", { branch: root });
      },
    };
  }
  return { target, expectNoDiskState, seedDelegatedManager };
}
