import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  trackSqliteStatementExecutions,
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessage,
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { listActiveSessionPendingInputs } from "../../config/sessions/session-accessor.sqlite-active-pending-inputs.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { prepareActiveSessionPendingInputsInWorker } from "../../config/sessions/session-active-pending-inputs.js";
import * as historyWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import { saveCronJobsStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as userProfileList from "../../state/user-profile-list.js";
import { ensureProfileForEmail, setAvatar } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abortQueuedChatTurnById,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { prepareChatPendingInputs } from "./chat-pending-inputs.js";
import type { GatewayRequestContext } from "./types.js";

const readChatPendingInputs = async (...args: Parameters<typeof prepareChatPendingInputs>) =>
  (await prepareChatPendingInputs(...args))();
const readActiveSessionPendingInputsInWorker = async (
  ...args: Parameters<typeof prepareActiveSessionPendingInputsInWorker>
) => {
  const prepared = await prepareActiveSessionPendingInputsInWorker(...args);
  return { ...prepared.page, items: prepared.selectCurrent(prepared.page.items) };
};

describe("pending input read boundary", () => {
  it("prepares automation names once per pending page from the Gateway's selected partition", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:pending-automation",
        sessionId: "pending-automation",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const job: CronJob = {
        id: "report",
        name: "Wrong partition",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check the queue." },
        state: {},
      };
      await saveCronJobsStore(state.statePath("cron", "jobs.json"), { version: 1, jobs: [job] });
      const cronStorePath = state.statePath("selected-cron", "jobs.json");
      const context = await createHistoryReadContext({ cronStorePath });
      const receipts = [];
      try {
        for (let index = 0; index < 20; index += 1) {
          receipts.push(
            expectDefined(
              await stageSessionPendingInput(scope, {
                runId: `automation-${index}`,
                assertCurrent: () => {},
                message: {
                  role: "user",
                  content: "The queue is clear.",
                  timestamp: 1,
                  idempotencyKey: `automation-${index}:user`,
                  provenance: {
                    kind: "inter_session",
                    sourceTool: "sessions_send",
                    sourceSessionKey: "agent:main:cron:report:run:finished",
                  },
                },
              }),
              "pending automation receipt",
            ),
          );
        }
        for (const name of ["Selected automation", "Renamed automation", undefined]) {
          await saveCronJobsStore(cronStorePath, {
            version: 1,
            jobs: name ? [{ ...job, name }] : [],
          });
          const counter = trackSqliteStatementExecutions(
            openOpenClawStateDatabase().db,
            ["names", "selection"],
            (sql) =>
              /\bfrom\s+"?cron_jobs"?\b/iu.test(sql)
                ? "names"
                : sql.includes('"config_machine_state"')
                  ? "selection"
                  : null,
          );
          try {
            const expectedMessage = {
              role: "assistant",
              senderSession: expect.objectContaining({ label: name ?? "Automation" }),
            };
            const respond = vi.fn();
            await expectDefined(
              chatHistoryHandlers["chat.history"],
              "history handler",
            )({
              params: { sessionKey: scope.sessionKey },
              context,
              req: { type: "req", id: "history", method: "chat.history" },
              client: null,
              isWebchatConnect: () => false,
              respond,
            });
            expect(counter.counts).toEqual({ names: 0, selection: 0 });
            expect(respond).toHaveBeenLastCalledWith(
              true,
              expect.objectContaining({
                pendingInputs: expect.objectContaining({
                  total: 20,
                  items: Array.from({ length: 20 }, () =>
                    expect.objectContaining({ message: expect.objectContaining(expectedMessage) }),
                  ),
                }),
              }),
            );
            await expectDefined(
              chatMessageGetHandlers["chat.message.get"],
              "message handler",
            )({
              params: {
                sessionKey: scope.sessionKey,
                messageId: `pending:${expectDefined(receipts[0], "first automation receipt").inputId}`,
              },
              context,
              req: { type: "req", id: "message", method: "chat.message.get" },
              client: null,
              isWebchatConnect: () => false,
              respond,
            });
            expect(respond).toHaveBeenLastCalledWith(true, {
              ok: true,
              message: expect.objectContaining(expectedMessage),
            });
            expect(counter.counts).toEqual({ names: 0, selection: 0 });
          } finally {
            counter.restore();
          }
        }
      } finally {
        for (const receipt of receipts) {
          receipt.finish("interrupted");
        }
      }
    });
  });

  it("projects pending input acceptance times with fresh page-scoped sender displays", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
      const profile = ensureProfileForEmail("pending-sender@example.test");
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:pending-display-time",
        sessionId: "pending-display-time",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipts = [];
      const readDisplay = vi.spyOn(userProfileList, "getUserProfileDisplay");
      try {
        for (let index = 0; index < 20; index += 1) {
          now.mockReturnValue(2_000 + index);
          receipts.push(
            expectDefined(
              await stageSessionPendingInput(scope, {
                runId: `pending-display-run-${index}`,
                assertCurrent: () => {},
                message: {
                  role: "user",
                  content: `Pending input ${index}`,
                  timestamp: 1_000 + index,
                  idempotencyKey: `pending-display-run-${index}:user`,
                  __openclaw: {
                    senderIdentity: { type: "profile", id: profile.id },
                    senderName: "Historical sender",
                  },
                },
              }),
              "pending input receipt",
            ),
          );
        }
        const context = await createHistoryReadContext();
        for (const [index, overrides] of [
          {},
          { sessionId: "another-session" },
          { agentId: "another-agent" },
          {},
          {},
          {},
        ].entries()) {
          const controller = new AbortController();
          const runId = index === 5 ? "external-run-".repeat(30) : `pending-display-run-${index}`;
          expect(
            registerQueuedChatTurn({
              chatQueuedTurns: context.chatQueuedTurns,
              ...scope,
              ...overrides,
              runId,
              controller,
            }),
          ).toBe(true);
          if (index === 3) {
            retireQueuedChatTurnCancellation(context.chatQueuedTurns, runId, controller);
          } else if (index === 4) {
            controller.abort();
          }
        }
        const readPage = async () => {
          readDisplay.mockClear();
          let result: unknown;
          await expectDefined(
            chatHistoryHandlers["chat.history"],
            "history handler",
          )({
            params: { sessionKey: scope.sessionKey },
            context,
            req: { type: "req", id: "history", method: "chat.history" },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              result = payload;
            },
          });
          const page = expectDefined(asOptionalRecord(result), "history response");
          const pending = expectDefined(asOptionalRecord(page.pendingInputs), "pending inputs");
          expect(pending.total).toBe(20);
          expect(pending.queuedCount).toBe(1);
          expect(readDisplay.mock.calls.filter(([id]) => id === profile.id)).toHaveLength(1);
          return pending.items as Array<Record<string, unknown>>;
        };
        const initial = await readPage();
        expect(initial.filter((item) => item.queued).map((item) => item.runId)).toEqual([
          "pending-display-run-0",
        ]);
        expect(initial).toEqual(
          receipts.map((receipt, index) =>
            expect.objectContaining({
              id: receipt.inputId,
              acceptedAt: 2_000 + index,
              message: expect.objectContaining({
                content: `Pending input ${index}`,
                timestamp: 2_000 + index,
                __openclaw: expect.objectContaining({
                  senderIdentity: { type: "profile", id: profile.id },
                  senderName: "Historical sender",
                  senderProfileAvatarUrl: expect.stringContaining(profile.id),
                }),
              }),
            }),
          ),
        );
        const initialBytes = JSON.stringify(initial);
        expect(initialBytes).not.toContain("idempotencyKey");
        expect(setAvatar(profile.id, Buffer.from("updated avatar"), "image/png").ok).toBe(true);
        const updated = await readPage();
        const initialMessage = asOptionalRecord(initial[0]?.message);
        const updatedMessage = asOptionalRecord(updated[0]?.message);
        const initialAvatar = asOptionalRecord(
          initialMessage?.["__openclaw"],
        )?.senderProfileAvatarUrl;
        const updatedAvatar = asOptionalRecord(
          updatedMessage?.["__openclaw"],
        )?.senderProfileAvatarUrl;
        expect(updatedAvatar).not.toBe(initialAvatar);
        expect(updated).toEqual(
          initial.map((item) => {
            const message = expectDefined(asOptionalRecord(item.message), "pending message");
            return {
              ...item,
              message: {
                ...message,
                __openclaw: {
                  ...asOptionalRecord(message["__openclaw"]),
                  senderProfileAvatarUrl: updatedAvatar,
                },
              },
            };
          }),
        );
        expect(JSON.stringify(initial)).toBe(initialBytes);
      } finally {
        readDisplay.mockRestore();
        for (const receipt of receipts) {
          receipt.finish("interrupted");
        }
        now.mockRestore();
      }
    });
  });

  it("keeps cancelled input readable and sanitized without changing the transcript or crossing a reset", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:accepted",
        sessionId: "accepted-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "r".repeat(300),
          assertCurrent: () => {},
          message: {
            role: "user",
            content: "Accepted input ".repeat(2000),
            timestamp: 1,
            idempotencyKey: "queued:user",
            __openclaw: {
              media: [
                {
                  kind: "image",
                  data: "synthetic-inline-payload",
                  url: "https://example.test/image?credential=synthetic",
                },
              ],
            },
          },
        }),
        "pending receipt",
      );
      try {
        receipt.finish("cancelled");
        const page = await readChatPendingInputs(scope, { limit: 1, maxChars: 50 });
        const displayId = `pending:${receipt.inputId}`;
        expect(page).toMatchObject({
          total: 1,
          items: [
            { state: "cancelled", message: { __openclaw: { id: displayId, truncated: true } } },
          ],
        });
        expect(page.items[0]).not.toHaveProperty("runId");
        expect(JSON.stringify(page)).not.toContain("synthetic-inline-payload");
        expect(JSON.stringify(page)).not.toContain("credential=");
        expect(await loadTranscriptEvents(scope)).toEqual([]);
        const respond = vi.fn();
        const lookup = () =>
          expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { sessionKey: scope.sessionKey, messageId: displayId },
            respond,
            context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
            req: {} as never,
            client: null,
            isWebchatConnect: () => false,
          });
        await lookup();
        expect(respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            message: expect.objectContaining({ content: receipt.message.content }),
          }),
        );
        await upsertSessionEntryCore(scope, { sessionId: "replacement-session", updatedAt: 2 });
        await lookup();
        expect(respond).toHaveBeenLastCalledWith(true, {
          ok: false,
          unavailableReason: "not_found",
        });
      } finally {
        receipt.finish("interrupted");
      }
    });
  });

  it("does not reveal an input hidden by the canonical history visibility policy", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:hidden-input",
        sessionId: "hidden-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "hidden-run",
          assertCurrent: () => {},
          message: {
            role: "user",
            display: false,
            content: "Internal continuation",
            timestamp: 1,
            idempotencyKey: "hidden:user",
          },
        }),
        "hidden pending receipt",
      );
      try {
        expect((await readChatPendingInputs(scope, { limit: 20, maxChars: 100 })).items).toEqual(
          [],
        );
        const respond = vi.fn();
        await expectDefined(
          chatMessageGetHandlers["chat.message.get"],
          "message handler",
        )({
          params: { sessionKey: scope.sessionKey, messageId: `pending:${receipt.inputId}` },
          respond,
          context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
          req: {} as never,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_visible" });
      } finally {
        receipt.finish("interrupted");
      }
    });
  });
});

describe("pending input consumption receipts", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s returns only requested current-session receipts in pages and empty deltas",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:collected",
          sessionId: "collected",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const context = await createHistoryReadContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async (params: Record<string, unknown> = {}) => {
          let result: unknown;
          await handler({
            params: { sessionKey: scope.sessionKey, ...params },
            context,
            req: { type: "req", id: "history", method },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              result = payload;
            },
          });
          return expectDefined(asOptionalRecord(result), "history response");
        };
        const sources = [];
        for (const runId of ["source-a", "source-b"]) {
          sources.push(
            expectDefined(
              await stageSessionPendingInput(scope, {
                runId,
                assertCurrent: () => {},
                message: {
                  role: "user",
                  content: runId,
                  timestamp: 1,
                  idempotencyKey: `${runId}:user`,
                },
              }),
              "source receipt",
            ),
          );
        }
        const aggregate = expectDefined(
          bindSessionPendingInputSources(sources, {
            role: "user",
            content: "Collected inputs",
            timestamp: 2,
            idempotencyKey: "collect:batch",
          }),
          "aggregate receipt",
        );
        const retained = [];
        try {
          await aggregate.run(() => appendTranscriptMessage(scope, { message: aggregate.message }));
          await appendTranscriptMessage(scope, {
            message: { role: "assistant", content: "Later reply" },
          });
          const inputRunIds = ["source-a", "missing"];
          const page = await call({ inputRunIds, limit: 1 });
          const expected = [
            { runId: "source-a", state: "consumed", consumedByEventId: aggregate.inputId },
          ];
          expect(page.inputReceipts).toEqual(expected);
          expect(page.inputConsumptions).toEqual([
            { runId: "source-a", consumedByEventId: aggregate.inputId },
          ]);
          expect(page.pendingInputs).toEqual({ items: [], total: 0, queuedCount: 0 });
          expect(JSON.stringify(page.messages)).not.toContain("Collected inputs");
          const delta = await call({ inputRunIds, cursor: page.deltaCursor });
          expect(delta).toMatchObject({ kind: "delta", messages: [], inputReceipts: expected });
          for (let index = 0; index < 21; index += 1) {
            retained.push(
              expectDefined(
                await stageSessionPendingInput(scope, {
                  runId: `retained-${index}`,
                  assertCurrent: () => {},
                  message: {
                    role: "user",
                    content: `retained-${index}`,
                    timestamp: index + 3,
                    idempotencyKey: `retained-${index}:user`,
                  },
                }),
                "retained receipt",
              ),
            );
          }
          expect(
            registerQueuedChatTurn({
              chatQueuedTurns: context.chatQueuedTurns,
              ...scope,
              runId: "retained-0",
              controller: new AbortController(),
            }),
          ).toBe(true);
          const retainedPage = await call({ inputRunIds: ["retained-0", "retained-1"], limit: 1 });
          expect(retainedPage.inputReceipts).toEqual([
            { runId: "retained-0", state: "pending", queued: true },
            { runId: "retained-1", state: "pending" },
          ]);
          expect(retainedPage.inputConsumptions).toEqual([]);
          expect(retainedPage.pendingInputs).toMatchObject({
            total: 21,
            queuedCount: 1,
            items: [{ runId: "retained-20" }],
          });
          expect(
            abortQueuedChatTurnById(context.chatQueuedTurns, {
              runId: "retained-0",
              sessionKey: scope.sessionKey,
            }).aborted,
          ).toBe(true);
          retained[0]?.finish("cancelled");
          const cancelledPage = await call({ inputRunIds: ["retained-0"], limit: 1 });
          expect(cancelledPage.pendingInputs).toMatchObject({ queuedCount: 0 });
          expect(cancelledPage.inputReceipts).toEqual([
            { runId: "retained-0", state: "pending", cancelled: true },
          ]);
          const anchor = await call({
            inputRunIds,
            messageId: aggregate.inputId,
            sessionId: scope.sessionId,
          });
          expect(anchor.inputReceipts).toEqual([]);
          await upsertSessionEntryCore(scope, { sessionId: "replacement", updatedAt: 2 });
          expect((await call({ inputRunIds })).inputReceipts).toEqual([]);
        } finally {
          aggregate.finish("interrupted");
          for (const source of sources) {
            source.finish("interrupted");
          }
          for (const receipt of retained) {
            receipt.finish("interrupted");
          }
        }
      });
    },
  );
});

const activeScope = {
  agentId: "main",
  sessionKey: "agent:main:active-queue",
  sessionId: "active-queue",
};
const activeMessage = (id: string) => ({
  role: "user" as const,
  content: id,
  timestamp: 100,
  idempotencyKey: id + ":user",
  provenance: { kind: "inter_session" as const, sourceTool: "sessions_send" },
});
const stageActive = async (id: string, target = activeScope, message = activeMessage(id)) =>
  expectDefined(
    await stageSessionPendingInput(target, {
      runId: id,
      requestFingerprint: id,
      message,
      assertCurrent: () => {},
    }),
    "pending input",
  );

describe("active pending input display", () => {
  it.each(["sessions_send", "cron"])(
    "keeps %s provenance when a full active page exceeds its display budget",
    async (sourceTool) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(activeScope, {
          sessionId: activeScope.sessionId,
          updatedAt: 1,
        });
        const provenance =
          sourceTool === "cron"
            ? {
                kind: "internal_system" as const,
                sourceTool,
                sourceSessionKey: "agent:main:cron:daily:run:first",
                jobId: "daily",
                runId: "first",
              }
            : { kind: "inter_session" as const, sourceTool, sourceSessionKey: "agent:main:helper" };
        const receipts = [];
        try {
          for (let index = 0; index < 20; index++) {
            const id = "budget-" + index;
            receipts.push(
              expectDefined(
                await stageSessionPendingInput(activeScope, {
                  runId: id,
                  assertCurrent: () => {},
                  message: { ...activeMessage(id), provenance, content: "😀".repeat(2000) },
                }),
                "budgeted pending receipt",
              ),
            );
          }
          const page = await readChatPendingInputs(activeScope, {
            before: 1,
            limit: 20,
            maxChars: 8000,
          });
          expect(page.items).toEqual([]);
          expect(page.queue?.items).toHaveLength(20);
          for (const item of page.queue?.items ?? []) {
            expect(item).not.toHaveProperty("queued");
            expect(item.message).toMatchObject({
              provenance,
              senderSession: { sessionKey: provenance.sourceSessionKey, agentId: "main" },
              __openclaw: { truncated: true },
            });
          }
          expect(Buffer.byteLength(JSON.stringify(page.queue))).toBeLessThan(128 * 1024);
        } finally {
          receipts.forEach((receipt) => receipt.finish("interrupted"));
        }
      });
    },
  );

  it.each(
    [undefined, 100].flatMap((before) =>
      ["cancelled", "consumed", "lifecycle"].map((ended) => ({ before, ended })),
    ),
  )(
    "does not publish $ended custody after history preparation (before=$before)",
    async ({ before, ended }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(activeScope, {
          sessionId: activeScope.sessionId,
          updatedAt: 1,
        });
        const receipt = await stageActive("late-cancel-".repeat(30));
        const original = historyPages.readChatHistoryPage;
        const read = vi
          .spyOn(historyPages, "readChatHistoryPage")
          .mockImplementation(async (...args) => {
            const result = await original(...args);
            if (ended === "consumed") {
              await receipt.run(() =>
                appendTranscriptMessage(activeScope, { message: receipt.message }),
              );
            } else if (ended === "lifecycle") {
              rotateAgentEventLifecycleGeneration();
            } else {
              receipt.finish("cancelled");
            }
            return result;
          });
        try {
          const context = await createHistoryReadContext();
          const respond = vi.fn();
          await expectDefined(
            chatHistoryHandlers["chat.history"],
            "history handler",
          )({
            params: {
              sessionKey: activeScope.sessionKey,
              ...(before ? { pendingBefore: before } : {}),
            },
            context,
            respond,
            req: { type: "req", id: "late-cancel", method: "chat.history" },
            client: null,
            isWebchatConnect: () => false,
          });
          expect(read).toHaveBeenCalled();
          expect(respond).toHaveBeenLastCalledWith(
            true,
            expect.objectContaining({
              pendingInputs: expect.objectContaining({
                items: [],
                ...(before ? { queue: { items: [] } } : {}),
              }),
            }),
          );
        } finally {
          read.mockRestore();
          receipt.finish("interrupted");
        }
      });
    },
  );
  it("continues past a fully hidden active page without exposing internal input", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(activeScope, { sessionId: activeScope.sessionId, updatedAt: 1 });
      const visible = await stageActive("visible-oldest");
      const receipts = [visible];
      try {
        for (let index = 0; index < 20; index++) {
          const id = "hidden-" + index;
          receipts.push(
            expectDefined(
              await stageSessionPendingInput(activeScope, {
                runId: id,
                message: { ...activeMessage(id), display: false },
                assertCurrent: () => {},
              }),
              "hidden receipt",
            ),
          );
        }
        const first = await readChatPendingInputs(activeScope, { limit: 20, maxChars: 1000 });
        expect(first.items).toEqual([]);
        expect(first.queue?.items).toEqual([]);
        expect(JSON.stringify(first)).not.toContain("hidden-");
        const next = await readChatPendingInputs(activeScope, {
          limit: 20,
          maxChars: 1000,
          queueBefore: expectDefined(first.queue?.nextBefore, "hidden page continuation"),
        });
        expect(next.queue?.items.map((item) => item.id)).toEqual([visible.inputId]);
        expect(next.queue?.nextBefore).toBeUndefined();
      } finally {
        receipts.forEach((receipt) => receipt.finish("interrupted"));
      }
    });
  });

  it("bounds active worker payloads without truncating or skipping an oversized page", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(activeScope, { sessionId: activeScope.sessionId, updatedAt: 1 });
      const content = "x".repeat(Math.floor(MAX_PAYLOAD_BYTES / 2));
      const receipts = [];
      try {
        for (const id of ["large-oldest", "large-newest"]) {
          receipts.push(await stageActive(id, activeScope, { ...activeMessage(id), content }));
        }
        const first = await readActiveSessionPendingInputsInWorker(activeScope, { limit: 20 });
        expect(first.items.map((item) => item.id)).toEqual([receipts[1]?.inputId]);
        expect(first.items[0]?.message.content === content).toBe(true);
        const older = await readActiveSessionPendingInputsInWorker(activeScope, {
          limit: 20,
          before: expectDefined(first.nextBefore, "byte-limited continuation"),
        });
        expect(older.items.map((item) => item.id)).toEqual([receipts[0]?.inputId]);
        expect(older.items[0]?.message.content === content).toBe(true);
        expect(older.nextBefore).toBeUndefined();
        const display = await readChatPendingInputs(activeScope, { limit: 20, maxChars: 1000 });
        expect(display.queue?.items).toHaveLength(1);
        expect(Buffer.byteLength(JSON.stringify(display))).toBeLessThan(128 * 1024);
      } finally {
        receipts.forEach((receipt) => receipt.finish("interrupted"));
      }
    });
  });
  it("does not publish an owner that ended while its worker read was in flight", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(activeScope, { sessionId: activeScope.sessionId, updatedAt: 1 });
      const receipt = await stageActive("finishing");
      const original = historyWorker.withSessionHistoryWorkerDatabase;
      const read = vi
        .spyOn(historyWorker, "withSessionHistoryWorkerDatabase")
        .mockImplementation((options, run) =>
          original(options, async (owner) => {
            const result = await run(owner);
            receipt.finish("cancelled");
            return result;
          }),
        );
      try {
        const page = await readChatPendingInputs(activeScope, {
          limit: 20,
          maxChars: 1000,
          before: 100,
        });
        expect(read).toHaveBeenCalled();
        expect(page.queue?.items).toEqual([]);
      } finally {
        read.mockRestore();
        receipt.finish("interrupted");
      }
    });
  });

  it("keeps incognito active input on its process-owned database", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const target = { ...activeScope, sessionKey: "agent:main:dashboard:incognito-active-queue" };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        incognito: true,
      });
      const receipt = await stageActive("private-input", target);
      try {
        const page = await readChatPendingInputs(target, {
          limit: 20,
          maxChars: 1000,
          before: 100,
        });
        expect(page.queue?.items.map((item) => item.id)).toEqual([receipt.inputId]);
      } finally {
        receipt.finish("interrupted");
      }
    });
  });

  it("finds old and re-admitted queue entries without reading terminal payloads or querying active rows on the host", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(activeScope, { sessionId: activeScope.sessionId, updatedAt: 1 });
      const id = "long-agent-id-".repeat(30);
      let receipt = await stageActive(id);
      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteScope(activeScope)),
      );
      // Seed only this fixture's retained terminal backlog; the live input uses real admission.
      database.db
        .prepare(
          "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4000) " +
            "INSERT INTO session_pending_inputs(input_id,session_key,session_id,idempotency_key,run_id,request_hash,message_json,lifecycle_generation,state,accepted_at) " +
            "SELECT 'terminal-'||i,session_key,session_id,'terminal-'||i,'terminal-'||i,request_hash,message_json,lifecycle_generation,'cancelled',accepted_at " +
            "FROM n CROSS JOIN session_pending_inputs WHERE input_id=?",
        )
        .run(receipt.inputId);
      try {
        const context = await createHistoryReadContext();
        const respond = vi.fn();
        const hostSql = observeHostDataSql();
        try {
          await expectDefined(
            chatHistoryHandlers["chat.history"],
            "history handler",
          )({
            params: { sessionKey: activeScope.sessionKey },
            context,
            respond,
            req: { type: "req", id: "queue", method: "chat.history" },
            client: null,
            isWebchatConnect: () => false,
          });
          expect(hostSql.queries.filter((sql) => sql.includes("json_each"))).toEqual([]);
        } finally {
          hostSql.restore();
        }
        expect(respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({
            pendingInputs: expect.objectContaining({
              total: 4001,
              queue: { items: [expect.objectContaining({ id: receipt.inputId, state: "queued" })] },
            }),
          }),
        );
        const pending = await readChatPendingInputs(activeScope, { limit: 20, maxChars: 1000 });
        expect(pending.items).toHaveLength(20);
        expect(pending.queue?.items).toHaveLength(1);
        expect(pending.queue?.items[0]).not.toHaveProperty("runId");
        expect(pending.queue?.items[0]).not.toHaveProperty("queued");

        const sql = observeSqliteReadSql(Object.getPrototypeOf(database.db.prepare("SELECT 1")));
        let metadataSql: string;
        try {
          expect(
            listActiveSessionPendingInputs(activeScope, { inputIds: [receipt.inputId], limit: 20 })
              .items,
          ).toHaveLength(1);
          metadataSql = expectDefined(
            sql.queries.find(
              (query) => query.includes("OCTET_LENGTH") && query.includes("active_inputs"),
            ),
            "metadata query",
          );
        } finally {
          sql.restore();
        }
        const plan = database.db
          .prepare("EXPLAIN QUERY PLAN " + metadataSql)
          .all(
            JSON.stringify([receipt.inputId]),
            activeScope.sessionKey,
            activeScope.sessionId,
            "queued",
            21,
          );
        expect(
          plan.some(
            (row) =>
              String(row.detail).includes("SEARCH session_pending_inputs") &&
              String(row.detail).includes("input_id=?"),
          ),
        ).toBe(true);
        expect(plan.some((row) => String(row.detail).includes("SCAN session_pending_inputs"))).toBe(
          false,
        );

        const originalId = receipt.inputId;
        receipt.finish("interrupted");
        expect(
          (await readChatPendingInputs(activeScope, { limit: 20, maxChars: 1000 })).queue?.items,
        ).toEqual([]);
        rotateAgentEventLifecycleGeneration();
        receipt = await stageActive(id);
        expect(receipt.inputId).toBe(originalId);
        expect(
          (
            await readChatPendingInputs(activeScope, { limit: 20, maxChars: 1000 })
          ).queue?.items.map((item) => item.id),
        ).toEqual([originalId]);
        await receipt.run(() => appendTranscriptMessage(activeScope, { message: receipt.message }));
        expect(
          (await readChatPendingInputs(activeScope, { limit: 20, maxChars: 1000 })).queue?.items,
        ).toEqual([]);
        console.log(
          "Active queue proof: 4,000 retained terminal rows, 1 active row, exact-ID index lookups, no active SQL on Gateway host.",
        );
      } finally {
        receipt.finish("interrupted");
      }
    });
  });

  it("paginates only active inputs and scopes them to the physical session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(activeScope, { sessionId: activeScope.sessionId, updatedAt: 1 });
      const receipts = [];
      try {
        for (let index = 0; index < 23; index++) {
          receipts.push(await stageActive("agent-" + index));
        }
        const first = await readChatPendingInputs(activeScope, { limit: 20, maxChars: 1000 });
        expect(first.queue?.items.map((item) => item.id)).toEqual(
          receipts.slice(3).map((receipt) => receipt.inputId),
        );
        const before = expectDefined(first.queue?.nextBefore, "queue cursor");
        const older = await readChatPendingInputs(activeScope, {
          limit: 20,
          maxChars: 1000,
          queueBefore: before,
        });
        expect(older.queue?.items.map((item) => item.id)).toEqual(
          receipts.slice(0, 3).map((receipt) => receipt.inputId),
        );
        expect(older.queue?.nextBefore).toBeUndefined();
        const foreign = await readChatPendingInputs(
          { ...activeScope, sessionId: "other-session" },
          { limit: 20, maxChars: 1000, queueBefore: before },
        );
        expect(foreign.queue?.items).toEqual([]);
        receipts[0]?.finish("cancelled");
        const cancelled = await readChatPendingInputs(activeScope, {
          limit: 20,
          maxChars: 1000,
          queueBefore: before,
        });
        expect(cancelled.queue?.items.map((item) => item.id)).toEqual(
          receipts.slice(1, 3).map((receipt) => receipt.inputId),
        );
      } finally {
        for (const receipt of receipts) {
          receipt.finish("interrupted");
        }
      }
    });
  });
});
