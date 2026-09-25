import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as entryExecution from "../../config/sessions/session-entry-execution.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { retainGatewaySessionBroker } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import {
  loadCurrentChatSendSession,
  prepareChatSendSession,
  qualifyChatSendSession,
} from "./chat-send-session.js";

it("reloads fresh borrowed volatile sources without accepting a replacement owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const broker = retainGatewaySessionBroker();
    const context = createDirectChatContext({ getRuntimeConfig });
    const target = {
      agentId: "main",
      sessionId: "borrowed-chat",
      sessionKey: "agent:main:dashboard:incognito-borrowed-chat",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      env,
    };
    const request = normalizeChatSendRequest({
      params: {
        sessionKey: target.sessionKey,
        message: "retained input",
        idempotencyKey: "borrowed-chat",
      },
      client: null,
    });
    if (!request.ok) {
      throw new Error(request.error);
    }
    const load = () => {
      const loaded = prepareChatSendSession({ request: request.value, context, client: null });
      if (!loaded.ok) {
        throw new Error(typeof loaded.error === "string" ? loaded.error : loaded.error.message, {
          cause: loaded.error,
        });
      }
      return loaded.value;
    };
    const prepared: ReturnType<typeof qualifyChatSendSession>[] = [];
    const closeEntered = createDeferred();
    const closeGate = createDeferred();
    let retirement: Promise<void> | undefined;
    let restoreClose: (() => void) | undefined;
    try {
      await broker.ready;
      SessionManager.open(target).appendMessage({
        role: "user",
        content: "original",
        timestamp: 1,
      });
      const loaded = load();
      const session = qualifyChatSendSession(loaded);
      prepared.push(session);
      const first = loadCurrentChatSendSession(session);
      const second = loadCurrentChatSendSession(session);
      expect(first.entry?.sessionId).toBe(target.sessionId);
      expect(second.entry?.sessionId).toBe(target.sessionId);
      if (!first.capturedReadSource || !second.capturedReadSource) {
        throw new Error("Expected real native captured Chat sources");
      }
      const a = entryExecution.retainWorkerSessionEntrySource(first.capturedReadSource);
      const b = entryExecution.retainWorkerSessionEntrySource(second.capturedReadSource);
      expect(first.capturedReadSource).toMatchObject({
        path: second.capturedReadSource.path,
        databaseIdentity: second.capturedReadSource.databaseIdentity,
        databaseBirthtime: second.capturedReadSource.databaseBirthtime,
      });
      expect(a.incarnation).toBe(b.incarnation);
      expect(a.execution.incarnation).toBe(b.execution.incarnation);
      expect(a.execution.borrow).not.toBe(b.execution.borrow);
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      expect(() => session.assertSessionTargetCurrent()).toThrow();
      SessionManager.open(target).appendMessage({
        role: "user",
        content: "replacement",
        timestamp: 2,
      });
      // The target is still explicitly active: refusal must come from its old owner.
      expect(() => loadCurrentChatSendSession(session)).toThrow();
      const freshLoaded = load();
      const capture = entryExecution.captureSessionEntryReadExecution;
      const heldClose = vi
        .spyOn(entryExecution, "captureSessionEntryReadExecution")
        .mockImplementationOnce((...args) => {
          const reader = capture(...args);
          if (!reader) {
            return reader;
          }
          return {
            ...reader,
            async close() {
              closeEntered.resolve();
              await closeGate.promise;
              await reader.close();
            },
          };
        });
      restoreClose = () => heldClose.mockRestore();
      const fresh = qualifyChatSendSession(freshLoaded);
      prepared.push(fresh);
      expect(loadCurrentChatSendSession(fresh).entry?.sessionId).toBe(target.sessionId);
      expect(
        entryExecution.retainWorkerSessionEntrySource(fresh.readSource!).execution.incarnation,
      ).not.toBe(a.execution.incarnation);
      await session.closeSessionTarget();
      retirement = broker.stop();
      let closed = false;
      const closing = fresh.closeSessionTarget().then(() => {
        closed = true;
      });
      await closeEntered.promise;
      expect(closed).toBe(false);
      closeGate.resolve();
      await closing;
      await retirement;
      heldClose.mockRestore();
      restoreClose = undefined;
    } finally {
      closeGate.resolve();
      restoreClose?.();
      try {
        await Promise.all(prepared.map((session) => session.closeSessionTarget()));
      } finally {
        await (retirement ?? broker.stop());
      }
    }
  });
});
