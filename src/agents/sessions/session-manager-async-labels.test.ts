import { afterEach, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { openAsyncSessionFixture } from "./session-manager-async.test-support.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";

afterEach(() => vi.restoreAllMocks());

async function openColdLabelFixture(state: OpenClawTestState, incognito = false) {
  const { target, manager: source } = await openAsyncSessionFixture(state, "cold-label", incognito);
  const ids = Array.from({ length: 6 }, (_, index) =>
    source.appendMessage({ role: "user", content: `history ${index}`, timestamp: index }),
  );
  const manager = await SessionManager.openAsync(target, state.workspaceDir, {
    maxBytes: 4096,
    maxEvents: 2,
  });
  for (let index = 6; index < 8; index++) {
    await manager.appendMessageAsync({
      role: "user",
      content: `history ${index}`,
      timestamp: index,
    });
  }
  expect(manager.getEntry(ids[0]!)).toBeUndefined();
  expect(manager.getEntry(ids[4]!)).toBeUndefined();
  return { target, source, manager, labelTarget: ids[0]! };
}

it.each(["direct", "reloaded", "incognito"] as const)(
  "publishes a cold label target and preserves appended model context (%s)",
  async (mode) => {
    await withOpenClawTestState({ label: `async-cold-label-${mode}` }, async (state) => {
      const { manager, source, labelTarget } = await openColdLabelFixture(
        state,
        mode === "incognito",
      );
      const beforeContext = (await manager[sessionManagerPrepareHistoryRead]().readContext())
        .messages;
      const concurrent = { role: "user" as const, content: "concurrent user", timestamp: 9 };
      let injected = false;
      if (mode === "reloaded") {
        const withWorker = metadataRuntime.withSessionMetadataWorker;
        vi.spyOn(metadataRuntime, "withSessionMetadataWorker").mockImplementation(
          async (...args) => {
            if (!injected) {
              injected = true;
              source.appendMessage(concurrent);
            }
            return withWorker(...args);
          },
        );
      }

      const labelId = await manager.appendLabelChangeAsync(labelTarget, "cold bookmark");

      expect(manager.getLabel(labelTarget)).toBe("cold bookmark");
      expect(manager.getEntry(labelTarget)).toMatchObject({
        id: labelTarget,
        message: { content: "history 0" },
      });
      expect(manager.getEntry(labelId)).toMatchObject({ type: "label", targetId: labelTarget });
      expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
        mode === "reloaded" ? [...beforeContext, concurrent] : beforeContext,
      );
      expect(
        manager.getEntries().filter((entry) => entry.type === "message").length,
      ).toBeLessThanOrEqual(3);
      expect(injected).toBe(mode === "reloaded");

      const clearedId = await manager.appendLabelChangeAsync(labelTarget, undefined);
      expect(manager.getLabel(labelTarget)).toBeUndefined();
      expect(manager.getEntry(labelTarget)).toBeUndefined();
      expect(manager.getEntry(clearedId)).toMatchObject({ type: "label", targetId: labelTarget });
      expect(manager.getEntry(labelId)).toMatchObject({ label: "cold bookmark" });
      const tail = await manager.appendMessageAsync({
        role: "user",
        content: "after clear",
        timestamp: 10,
      });
      expect(manager.removeTrailingEntries((entry) => entry.id === tail)).toBe(1);
      expect(manager.getEntry(clearedId)).toMatchObject({ type: "label", targetId: labelTarget });
      expect(manager.getEntry(labelId)).toMatchObject({ label: "cold bookmark" });
      expect(manager.getEntry(labelTarget)).toBeUndefined();
      await manager.reloadPersistedTranscriptAsync();
      expect(manager.getEntry(clearedId)).toMatchObject({ type: "label", targetId: labelTarget });
      expect(manager.getEntry(labelId)).toMatchObject({ label: "cold bookmark" });
      expect(manager.getEntry(labelTarget)).toBeUndefined();
    });
  },
);

it.each(
  (["persistent", "incognito"] as const).flatMap((storage) =>
    (["message", "custom", "label"] as const).map((kind) => ({ storage, kind })),
  ),
)("keeps a cold $kind label target on $storage open and reload", async ({ storage, kind }) => {
  await withOpenClawTestState({ label: `cold-label-open-${storage}-${kind}` }, async (state) => {
    const { target, manager: source } = await openAsyncSessionFixture(
      state,
      `cold-label-open-${kind}`,
      storage === "incognito",
    );
    const coldEntry = {
      id: "labeled",
      parentId: null,
      ...(kind === "custom"
        ? {
            type: "custom",
            customType: "saved-state",
            data: { revision: 1, nested: { text: "complete target data" } },
          }
        : {
            type: "message",
            message: makeAgentAssistantMessage({
              content: [{ type: "text", text: "older answer" }],
            }),
          }),
    };
    const user = {
      type: "message",
      id: "newer-user",
      parentId: coldEntry.id,
      message: { role: "user", content: "newer question", timestamp: 2 },
    };
    const innerLabel = {
      type: "label",
      id: "inner-bookmark",
      parentId: user.id,
      targetId: coldEntry.id,
      label: "inner saved target",
    };
    const targetEntry = kind === "label" ? innerLabel : coldEntry;
    const label = {
      type: "label",
      id: "bookmark",
      parentId: kind === "label" ? innerLabel.id : user.id,
      targetId: targetEntry.id,
      label: "saved target",
    };
    const events = [
      source.getHeader(),
      coldEntry,
      user,
      ...(kind === "label" ? [innerLabel] : []),
      label,
    ];
    await replaceTranscriptEvents(target, events);
    await waitForSessionTranscriptProjection(target);
    const manager = await SessionManager.openAsync(target, state.workspaceDir, {
      maxBytes: 4096,
      maxEvents: 1,
    });

    for (const reload of [false, true]) {
      if (reload) {
        await manager.reloadPersistedTranscriptAsync();
      }
      if (kind === "label") {
        expect(manager.getEntry(innerLabel.id)).toMatchObject({
          type: "label",
          targetId: coldEntry.id,
          label: innerLabel.label,
        });
        expect(manager.getLabel(coldEntry.id)).toBe(innerLabel.label);
      }
      expect(manager.getEntry(coldEntry.id)).toEqual(coldEntry);
      expect(manager.getEntry(label.id)).toMatchObject({
        type: "label",
        targetId: targetEntry.id,
        label: label.label,
      });
      expect(manager.getLabel(targetEntry.id)).toBe(label.label);
      expect(manager.getLeafId()).toBe(label.id);
      expect(manager.buildSessionContext().messages).toEqual([]);
      expect((await manager[sessionManagerPrepareHistoryRead]().readContext()).messages).toEqual(
        [],
      );
    }
    expect(await loadTranscriptEvents(target)).toEqual(events);
  });
});

it.each(["commit", "view"] as const)(
  "settles cold label %s failures without retrying the write",
  async (failure) => {
    await withOpenClawTestState({ label: `async-cold-label-${failure}` }, async (state) => {
      const { target, manager, labelTarget } = await openColdLabelFixture(state);
      const beforeEntries = manager.getEntries();
      const beforeEvents = await loadTranscriptEvents(target);
      if (failure === "commit") {
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (admit, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === "commit") {
                throw new Error("cold label commit refused");
              }
              admit(request, grant);
            }, attachment),
        );
      } else {
        const prepare = transcriptHydration.prepareSessionTranscriptHydration;
        vi.spyOn(transcriptHydration, "prepareSessionTranscriptHydration").mockImplementation(
          (...args) => {
            const reader = prepare(...args);
            return {
              ...reader,
              readMaintenance: (request) => {
                if (request.operation === "history-page" && request.selection === "window") {
                  throw new Error("cold label view unavailable");
                }
                return reader.readMaintenance(request);
              },
            };
          },
        );
      }

      const pending = manager.appendLabelChangeAsync(labelTarget, "cold bookmark");
      if (failure === "commit") {
        await expect(pending).rejects.toThrow("cold label commit refused");
        expect(await loadTranscriptEvents(target)).toEqual(beforeEvents);
        expect(manager.getEntries()).toEqual(beforeEntries);
        expect(manager.getLabel(labelTarget)).toBeUndefined();
        expect(manager.getEntry(labelTarget)).toBeUndefined();
      } else {
        await expect(pending).rejects.toMatchObject({
          name: "SessionEntryCommittedError",
          cause: { message: "cold label view unavailable" },
        });
        const events = await loadTranscriptEvents(target);
        expect(events).toHaveLength(beforeEvents.length + 1);
        expect(events.at(-1)).toMatchObject({
          type: "label",
          targetId: labelTarget,
          label: "cold bookmark",
        });
        expect(() => manager.getEntries()).toThrow("Session entry committed");
      }
    });
  },
);
