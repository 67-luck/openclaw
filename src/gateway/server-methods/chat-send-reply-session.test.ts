import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareQualifiedSessionEntryTarget } from "../../config/sessions/session-accessor.entry.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { createChatReplySessionReader } from "./chat-send-reply-session.js";
import { createChatSendWorkAdmission } from "./chat-send-work-admission.js";

it("rereads a borrowed reply source without rediscovery and refuses release during its read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:reply-source" };
    replaceSessionEntrySync(scope, { sessionId: "reply-session", updatedAt: 1 });
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: {},
      key: scope.sessionKey,
      agentId: scope.agentId,
    });
    const qualified = prepareQualifiedSessionEntryTarget(
      {
        ...loaded,
        requestedKey: scope.sessionKey,
        storeKey: loaded.canonicalKey,
        readSource: loaded.capturedReadSource,
      },
      loaded.capturedReadSources,
    );
    const work = createChatSendWorkAdmission({
      admission: { release: vi.fn() },
      releaseCallerAuthority: qualified.release,
      logGateway: { warn: vi.fn() },
    });
    const reader = createChatReplySessionReader(
      {
        ...loaded,
        ...scope,
        cfg: {},
        clientRunId: "reply-run",
        backingSessionId: "reply-session",
        sessionLoadOptions: { agentId: scope.agentId },
        sessionTarget: qualified.target,
        assertSessionTargetCurrent: qualified.assertCurrent,
      },
      () => {
        if (!work.isActive()) {
          throw new Error("reply work ended");
        }
      },
    );
    const run = historyLane.pool.run.bind(historyLane.pool);
    const reading = createDeferred();
    const resume = createDeferred();
    let hold = false;
    let inventories = 0;
    const spy = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
      const reply = await run(...args);
      if (
        reply.ok &&
        typeof reply.value === "object" &&
        reply.value !== null &&
        "kind" in reply.value
      ) {
        if (reply.value.kind === "session-target-inventory") {
          inventories += 1;
        }
        if (hold && reply.value.kind === "session-exact-entries") {
          reading.resolve();
          await resume.promise;
        }
      }
      return reply;
    });
    try {
      for (const updatedAt of [2, 3]) {
        replaceSessionEntrySync(scope, { sessionId: "reply-session", updatedAt });
        const host = observeHostDataSql();
        try {
          expect((await reader.readCurrentSession()).entry?.updatedAt).toBe(updatedAt);
          expect(host.queries).toEqual([]);
        } finally {
          host.restore();
        }
      }
      hold = true;
      const pending = reader.readCurrentSession();
      const refusal = expect(pending).rejects.toThrow("reply work ended");
      await reading.promise;
      work.release();
      resume.resolve();
      await refusal;
      expect(inventories).toBe(0);
    } finally {
      resume.resolve();
      work.release();
      spy.mockRestore();
    }
  });
});
