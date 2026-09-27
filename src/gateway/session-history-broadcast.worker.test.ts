import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import * as projection from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createHandler,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  runtimeConfigState,
  sessionRow,
} from "./server-session-events.test-support.js";
import * as storeSources from "./session-utils-store-sources.js";

afterEach(() => vi.restoreAllMocks());

async function seedBroadcastHistory(storePath: string) {
  const readers = await vi.importActual<typeof import("./session-transcript-readers.js")>(
    "./session-transcript-readers.js",
  );
  readSessionMessageByIdAsyncMock.mockImplementation(readers.readSessionMessageByIdAsync);
  readSessionMessageCountAsyncMock.mockImplementation(readers.readSessionMessageCountAsync);
  runtimeConfigState.value = {};
  loadGatewaySessionRowMock.mockReturnValue(sessionRow);
  const target = {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  };
  const entry = { sessionId: target.sessionId, updatedAt: 1 };
  await replaceSessionEntry(target, entry);
  await replaceTranscriptEvents(target, [
    { type: "session", version: 3, id: target.sessionId },
    {
      type: "message",
      id: "question",
      parentId: null,
      message: { role: "user", content: "Stored question" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "question",
      message: { role: "assistant", content: "Stored answer" },
    },
  ]);
  await waitForSessionTranscriptProjection(target);
  loadAccessorSessionEntryReadOnlyMock.mockReturnValue(entry);
  return { target, ...createHandler(false) };
}

it.each(["by-id", "count"] as const)(
  "keeps the event loop available while broadcasting a stored %s read",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target, handler, broadcastToConnIds } = await seedBroadcastHistory(
        state.statePath("broadcast.sqlite"),
      );
      const snapshot = vi.spyOn(projection, "withCurrentProjectionSnapshot");
      let eventLoopProgress = false;
      const turn = setImmediate().then(() => {
        eventLoopProgress = true;
      });
      let progressedBeforeDelivery = false;
      broadcastToConnIds.mockImplementation(() => {
        progressedBeforeDelivery = eventLoopProgress;
      });
      try {
        await handler({
          target,
          ...(kind === "by-id" ? { messageId: "answer" } : {}),
          message: { role: "assistant", content: "Queued answer" },
        });
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "session.message",
          expect.objectContaining({
            messageSeq: 2,
            message: expect.objectContaining({
              content: kind === "by-id" ? "Stored answer" : "Queued answer",
            }),
          }),
          expect.any(Set),
        );
        expect(progressedBeforeDelivery).toBe(true);
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        await turn;
        snapshot.mockRestore();
      }
    });
  },
);

it.each(
  (["by-id", "count"] as const).flatMap((kind) =>
    (
      [
        "registry churn",
        "state retirement",
        "selected retirement",
        "selected replacement",
        "preparation failure",
      ] as const
    ).map((change) => ({ kind, change })),
  ),
)(
  "honors $change during selected $kind preparation before publication",
  async ({ kind, change }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { target, handler, broadcastToConnIds } = await seedBroadcastHistory(
        resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      );
      const sibling = openOpenClawAgentDatabase({ agentId: "other", env: state.env });
      const update = {
        target,
        ...(kind === "by-id" ? { messageId: "answer" } : {}),
        message: { role: "assistant", content: "Queued answer" },
      };
      await handler(update);
      broadcastToConnIds.mockClear();
      const registration = { agentId: "other", path: sibling.path, env: state.env };
      registerOpenClawAgentDatabase(registration);
      const held = createDeferredCore();
      const release = createDeferredCore();
      const preparationError = new Error("Selected-source preparation failed");
      const read = stateReads.executeExistingOpenClawStateRead;
      const registry = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation((...args) => {
          if (args[1].type === "agentDatabaseRegistry.read") {
            throw new Error("Unrelated registry is unavailable");
          }
          return read(...args);
        });
      const prepare = storeSources.prepareGatewaySessionStoreReadSourcesAsync;
      const preparation = vi
        .spyOn(storeSources, "prepareGatewaySessionStoreReadSourcesAsync")
        .mockImplementation(async (params) => {
          const prepared = await prepare(params);
          // Retain the real selected matcher and caller admission across this wait;
          // unrelated registry discovery is no longer part of raw publication.
          held.resolve();
          await release.promise;
          if (change === "preparation failure") {
            throw preparationError;
          }
          return prepared;
        });
      let closing: Promise<boolean> | undefined;
      const pending = handler(update);
      try {
        await Promise.race([
          held.promise,
          pending.then(() => {
            throw new Error("Publication completed before selected-source preparation");
          }),
        ]);
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        if (change === "state retirement") {
          await closeOpenClawStateDatabaseByPathAsync(openOpenClawStateDatabase().path);
          openOpenClawStateDatabase();
        } else if (change === "selected retirement") {
          closing = closeOpenClawAgentDatabaseByPathAsync(target.storePath, target.agentId);
        } else if (change === "selected replacement") {
          fs.copyFileSync(target.storePath, `${target.storePath}.replacement`);
          fs.renameSync(target.storePath, `${target.storePath}.previous`);
          fs.renameSync(`${target.storePath}.replacement`, target.storePath);
        } else if (change === "registry churn") {
          for (let index = 0; index < 3; index++) {
            registerOpenClawAgentDatabase(registration);
          }
        }
        release.resolve();
        if (change === "state retirement") {
          await expect(pending).rejects.toMatchObject({
            code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
          });
        } else if (change === "selected retirement") {
          await expect(pending).rejects.toThrow("revoked");
        } else if (change === "selected replacement") {
          await expect(pending).rejects.toThrow("Session store changed");
        } else if (change === "preparation failure") {
          await expect(pending).rejects.toBe(preparationError);
        } else {
          await pending;
          expect(broadcastToConnIds).toHaveBeenCalledWith(
            "session.message",
            expect.objectContaining({
              messageSeq: 2,
              message: expect.objectContaining({
                content: kind === "by-id" ? "Stored answer" : "Queued answer",
              }),
            }),
            expect.any(Set),
          );
        }
        if (change !== "registry churn") {
          expect(broadcastToConnIds).not.toHaveBeenCalled();
        }
        expect(
          registry.mock.calls.filter(
            ([, command]) => command.type === "agentDatabaseRegistry.read",
          ),
        ).toEqual([]);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        await closing;
        preparation.mockRestore();
        registry.mockRestore();
      }
    });
  },
);
