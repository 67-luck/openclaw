import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { estimateContextTokens } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { AgentSession } from "./agent-session.js";
import { sessionManagerPrepareHistoryRead } from "./session-manager-history.js";
import { canonicalTarget } from "./session-manager-hydration.test-support.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

function measuredUsage(input: number, output = 0) {
  return {
    ...createZeroUsageFixture(),
    input,
    output,
    totalTokens: input + output,
    contextUsage: { state: "available" as const, promptTokens: input, totalTokens: input + output },
  };
}

const compaction = {
  type: "compaction",
  id: "compact-1",
  parentId: null,
  timestamp: "2026-07-05T00:00:00.000Z",
  summary: "summary",
  firstKeptEntryId: "assistant-exact",
  tokensBefore: 120_000,
};

function messageEntry(id: string, message: AgentMessage) {
  return { type: "message", id, parentId: "compact-1", message };
}

describe("AgentSession context usage", () => {
  it("reports unknown usage after a provider checkpoint until a later measured response", () => {
    const owner = makeAgentAssistantMessage({
      content: [{ type: "text", text: "covered" }],
      usage: measuredUsage(90_000),
    });
    owner.providerReplay = {
      v: 1,
      type: "openai-responses-retained-compaction",
      data: "opaque",
      provider: owner.provider,
      api: owner.api,
      model: owner.model,
      baseUrlHash: "hash",
    };
    const messages: AgentMessage[] = [owner];
    const branchEntries = [messageEntry("checkpoint-owner", owner)];
    const session = {
      model: { contextWindow: 100_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession;
    expect(AgentSession.prototype.getContextUsage.call(session)).toEqual({
      tokens: null,
      contextWindow: 100_000,
      percent: null,
    });
    const later = makeAgentAssistantMessage({
      content: [{ type: "text", text: "later" }],
      usage: measuredUsage(8_000),
    });
    messages.push(later);
    branchEntries.push(messageEntry("later", later));
    expect(AgentSession.prototype.getContextUsage.call(session)?.tokens).toBe(8_000);
  });

  it.each([
    {
      name: "unavailable usage before any compaction",
      compacted: false,
      usage: {
        ...createZeroUsageFixture(),
        input: 12,
        output: 8,
        cacheRead: 180_000,
        totalTokens: 180_020,
        contextUsage: { state: "unavailable" as const },
      },
    },
    {
      name: "unavailable usage after compaction",
      compacted: true,
      usage: { ...measuredUsage(180_000, 10_000), contextUsage: { state: "unavailable" as const } },
    },
    { name: "zero usage after compaction", compacted: true, usage: measuredUsage(0) },
  ])("preserves an earlier exact snapshot before $name", ({ compacted, usage: latestUsage }) => {
    const exact = makeAgentAssistantMessage({
      content: [{ type: "text", text: "exact answer" }],
      usage: measuredUsage(180_000, 10_000),
    });
    const later = makeAgentAssistantMessage({
      content: latestUsage.totalTokens === 0 ? [] : [{ type: "text", text: "small answer" }],
      usage: latestUsage,
    });
    const messages: AgentMessage[] = [
      exact,
      { role: "user", content: "small follow-up", timestamp: 1 },
      later,
    ];
    const branchEntries = compacted
      ? [compaction, messageEntry("assistant-exact", exact), messageEntry("assistant-later", later)]
      : [];
    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession);

    expect(usage?.tokens).toBeGreaterThan(190_000);
  });

  it("uses a content estimate after compaction when provider context usage is unavailable", () => {
    const unavailableUsage = {
      ...createZeroUsageFixture(),
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      totalTokens: 927_907,
      contextUsage: { state: "unavailable" as const },
    };
    const retained = makeAgentAssistantMessage({
      content: [{ type: "text", text: "retained answer" }],
      usage: {
        ...unavailableUsage,
        contextUsage: { state: "available", promptTokens: 120_000, totalTokens: 125_000 },
      },
    });
    const later = makeAgentAssistantMessage({
      content: [{ type: "text", text: "new answer" }],
      usage: unavailableUsage,
    });
    const messages: AgentMessage[] = [
      retained,
      { role: "user", content: "new prompt", timestamp: 1 },
      later,
    ];
    const branchEntries = [compaction, messageEntry("assistant-new", later)];
    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession);

    expect(usage?.tokens).not.toBeNull();
    expect(usage?.tokens).toBeLessThan(1_000);
  });
});

it.each([
  { kind: "client", usageKind: "positive unavailable", stopReason: "stop" },
  { kind: "client", usageKind: "legacy duplicate kind", stopReason: "stop" },
  { kind: "provider", usageKind: "checkpoint", stopReason: "stop" },
  { kind: "client", usageKind: "zero unavailable", stopReason: "stop" },
  { kind: "client", usageKind: "legacy CLI", stopReason: "aborted" },
  { kind: "provider", usageKind: "zero unavailable", stopReason: "stop" },
] as const)(
  "preserves $kind compaction usage evidence through eviction and bounded replacements ($usageKind, $stopReason)",
  async ({ kind, usageKind, stopReason }) => {
    const label = `context-usage-evidence-${kind}`;
    await withOpenClawTestState({ label }, async (state) => {
      const scope = canonicalTarget(state, label);
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source =
        usageKind === "legacy duplicate kind"
          ? SessionManager.fromEntries([
              {
                type: "session",
                id: scope.sessionId,
                version: CURRENT_SESSION_VERSION,
                timestamp: new Date(0).toISOString(),
                cwd: state.workspaceDir,
              },
            ])
          : SessionManager.open(scope);
      const hasBarrier = usageKind === "zero unavailable" || usageKind === "legacy CLI";
      const userId = source.appendMessage(makeUserMessage("retained question", 1));
      if (kind === "client") {
        source.appendCompaction("summary", userId, 200_000);
      }
      const measured = makeAgentAssistantMessage({
        content: [{ type: "text", text: "measured response" }],
      });
      const tokens = kind === "client" ? 190_000 : 90_000;
      measured.usage = {
        ...measured.usage,
        input: tokens,
        totalTokens: tokens,
        contextUsage: { state: "available", promptTokens: tokens, totalTokens: tokens },
      };
      if (kind === "provider") {
        measured.providerReplay = {
          v: 1,
          type: "openai-responses-retained-compaction",
          data: "synthetic-checkpoint",
          provider: measured.provider,
          api: measured.api,
          model: measured.model,
          baseUrlHash: "0123456789abcdef",
        };
      }
      let witnessId = source.appendMessage(measured);
      if (kind === "provider") {
        expect(source.getEntry(witnessId)).toMatchObject({
          message: {
            providerReplay: {
              type: "openai-responses-retained-compaction",
              data: "synthetic-checkpoint",
            },
          },
        });
        if (hasBarrier) {
          witnessId = source.appendMessage({ ...measured, providerReplay: undefined });
        }
      }
      if (usageKind === "legacy duplicate kind") {
        await seedUnindexedTranscriptForTest({
          ...scope,
          entry: { sessionId: scope.sessionId, updatedAt: 1 },
          events: source.getPersistedEntries().map((event, seq) => ({
            session_id: scope.sessionId,
            seq,
            event_json:
              isRecord(event) && event.id === witnessId
                ? '{"type":"custom",' + JSON.stringify(event).slice(1)
                : JSON.stringify(event),
            created_at: seq,
          })),
        });
      }
      const messages = source.buildSessionContext().messages;
      await waitForSessionTranscriptProjection(scope);
      const manager = await SessionManager.openBoundedAsync(scope, {
        maxBytes: 4096,
        maxEvents: 4,
      });
      let barrierId: string | undefined;
      if (usageKind !== "checkpoint") {
        const unavailable = makeAgentAssistantMessage({
          content: [{ type: "text", text: "usage unavailable" }],
          ...(usageKind === "legacy CLI" ? { api: "cli" } : {}),
          stopReason,
          usage:
            usageKind === "legacy CLI"
              ? { ...measured.usage, contextUsage: undefined }
              : {
                  ...(hasBarrier ? createZeroUsageFixture() : measured.usage),
                  contextUsage: { state: "unavailable" },
                },
        });
        const unavailableId = await manager.appendMessageAsync(unavailable);
        if (hasBarrier) {
          barrierId = unavailableId;
        }
        messages.push(unavailable);
        const followUp = makeUserMessage("question after usage became unavailable", 2);
        await manager.appendMessageAsync(followUp);
        messages.push(followUp);
      }
      const resultIds: string[] = [];
      for (let index = 0; index < 6; index++) {
        const result = {
          role: "toolResult" as const,
          toolCallId: `usage-result-${index}`,
          toolName: "read",
          content: [{ type: "text" as const, text: "small completed result" }],
          isError: false,
          timestamp: index + 2,
        };
        const resultId = await manager.appendMessageAsync(result);
        if (resultId === undefined) {
          throw new Error("Expected a committed tool result");
        }
        resultIds.push(resultId);
        messages.push(result);
      }
      const originalMessages = structuredClone(messages);
      const readUsage = () =>
        AgentSession.prototype.getContextUsage.call({
          model: { contextWindow: 200_000 },
          messages,
          sessionManager: manager,
        });
      expect(manager.getEntry(resultIds[0]!)).toBeUndefined();
      for (const phase of ["append", "sync reload", "reload", "navigation"] as const) {
        if (phase === "sync reload") {
          manager.reloadPersistedTranscript();
        } else if (phase === "reload") {
          await manager.reloadPersistedTranscriptAsync();
        } else if (phase === "navigation") {
          await manager.branchAsync(resultIds.at(-1)!);
        }
        expect(manager.getEntry(hasBarrier ? barrierId! : witnessId), phase).toBeDefined();
        if (hasBarrier) {
          const residentMessages = manager
            .getBranch()
            .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
          expect(estimateContextTokens(residentMessages).usageTokens, phase).toBe(0);
          expect(manager.getEntry(witnessId), phase).toBeUndefined();
        }
        if (kind === "provider") {
          expect(readUsage()?.tokens).toBeNull();
        } else if (hasBarrier) {
          expect(readUsage()?.tokens).toBeLessThan(1_000);
        } else {
          expect(readUsage()?.tokens).toBeGreaterThan(190_000);
        }
        if (phase === "reload" || phase === "navigation") {
          const context = await manager[sessionManagerPrepareHistoryRead]().readContext();
          expect(context.messages.some((message) => message.role === "assistant")).toBe(false);
        }
        expect(messages).toEqual(originalMessages);
      }
      if (hasBarrier) {
        const replacement = makeAgentAssistantMessage({
          content: [{ type: "text", text: "new measured response" }],
          usage: {
            ...createZeroUsageFixture(),
            input: 8_000,
            totalTokens: 8_000,
            contextUsage: { state: "available", promptTokens: 8_000, totalTokens: 8_000 },
          },
        });
        await manager.appendMessageAsync(replacement);
        messages.push(replacement);
        expect(manager.getEntry(barrierId!)).toBeUndefined();
        expect(readUsage()?.tokens).toBe(8_000);
      }
    });
  },
);
