// User turn transcript tests cover transcript extraction for user turns.
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as pendingReceipts from "../config/sessions/session-accessor.pending-input-receipt.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createUserTurnTranscriptRecorder,
  completeUserTurnTranscriptProcessing,
  finishUserTurnPendingInput,
  joinUserTurnPendingInput,
} from "./user-turn-transcript.js";

describe("user turn transcript completion", () => {
  const unusedRecorderTarget = {
    agentId: "main",
    sessionEntry: undefined,
    sessionId: "unused-session",
    sessionKey: "agent:main:unused",
    storePath: "/tmp/openclaw-unused-sessions.json",
  };

  it("returns no-receipt processing completion synchronously", () => {
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "input" },
      target: unusedRecorderTarget,
    });
    const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
    expect(recorder.completeProcessing?.(outcome)).toBeUndefined();
    expect(completeUserTurnTranscriptProcessing(recorder, outcome)).toBeUndefined();
  });

  it("keeps native receipt join synchronous without revisiting collected sources", async () => {
    await withOpenClawTestState({ label: "recorder-native-join" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "recorder-native-join",
        sessionKey: "agent:main:recorder-native-join",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const join = pendingReceipts.joinSessionPendingInputReceipt;
      const receipts: Parameters<typeof join>[0][] = [];
      const results: ReturnType<typeof join>[] = [];
      let injectedFailure: Error | undefined;
      const observation = vi
        .spyOn(pendingReceipts, "joinSessionPendingInputReceipt")
        .mockImplementation((receipt) => {
          const result = join(receipt);
          receipts.push(receipt);
          results.push(result);
          if (injectedFailure) {
            throw injectedFailure;
          }
          return result;
        });
      const sources: ReturnType<typeof createUserTurnTranscriptRecorder>[] = [];
      let collected: ReturnType<typeof createUserTurnTranscriptRecorder> | undefined;
      const unexpected: Promise<void>[] = [];
      const failures: unknown[] = [];
      try {
        for (const index of [0, 1]) {
          const source = createUserTurnTranscriptRecorder({
            message: {
              role: "user",
              content: `source ${index}`,
              timestamp: 1,
              idempotencyKey: `native-join:source:${index}`,
            },
            target: { ...scope, sessionEntry: undefined },
          });
          sources.push(source);
          assert(source.stageApproved);
          expect(
            await source.stageApproved({
              runId: `native-join:${index}`,
              assertCurrent: () => {},
            }),
          ).toBe(true);
        }
        collected = createUserTurnTranscriptRecorder({
          message: {
            role: "user",
            content: "collected",
            timestamp: 2,
            idempotencyKey: "native-join:collected",
          },
          target: { ...scope, sessionEntry: undefined },
          pendingInputSources: sources,
        });
        await collected.resolveMessage();
        const result = joinUserTurnPendingInput(collected);
        if (result) {
          unexpected.push(result);
          void result.catch(() => undefined);
        }
        expect(result).toBeUndefined();
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.message.idempotencyKey).toBe("native-join:collected");
        expect(results).toEqual([undefined]);

        const failure = new Error("original native receipt join callback failed");
        injectedFailure = failure;
        let caught: { error: unknown } | undefined;
        try {
          const returned = joinUserTurnPendingInput(collected);
          if (returned) {
            unexpected.push(returned);
            void returned.catch(() => undefined);
          }
        } catch (error) {
          caught = { error };
        }
        expect(caught).toBeDefined();
        expect(caught?.error).toBe(failure);
        expect(receipts).toHaveLength(2);
        expect(receipts[1]).toBe(receipts[0]);
        expect(results).toEqual([undefined, undefined]);
      } catch (error) {
        failures.push(error);
      } finally {
        injectedFailure = undefined;
        try {
          for (const recorder of collected ? [collected] : sources) {
            try {
              await finishUserTurnPendingInput(recorder, "interrupted");
            } catch (error) {
              failures.push(error);
            }
          }
          for (const settlement of await Promise.allSettled(unexpected)) {
            if (settlement.status === "rejected") {
              failures.push(settlement.reason);
            }
          }
        } finally {
          observation.mockRestore();
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Native collected receipt join fixture failed");
      }
    });
  });

  it.each(["result", "write error"] as const)(
    "caches the first native completion %s without another write",
    async (kind) => {
      await withOpenClawTestState({ label: "recorder-completion" }, async (state) => {
        const scope = {
          agentId: "main",
          sessionId: "recorder-completion",
          sessionKey: "agent:main:recorder-completion",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const recorder = createUserTurnTranscriptRecorder({
          message: {
            role: "user",
            content: "accepted",
            timestamp: 1,
            idempotencyKey: "completion:user",
          },
          target: { ...scope, sessionEntry: undefined },
          trackInputCompletion: true,
        });
        await recorder.stageApproved!({ runId: "completion", assertCurrent: () => {} });
        const database = openOpenClawAgentDatabase({
          agentId: scope.agentId,
          path: scope.storePath,
        });
        const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
        let error: unknown;
        let committed: ReturnType<typeof buildAgentRunTerminalOutcome> | undefined;
        try {
          if (kind === "write error") {
            database.db.exec(
              "CREATE TRIGGER refuse_completion BEFORE INSERT ON session_input_completions BEGIN SELECT RAISE(ABORT, 'completion fixture refusal'); END",
            );
          }
          try {
            committed = recorder.completeProcessing!(outcome);
          } catch (caught) {
            error = caught;
          }
          if (kind === "write error") {
            expect(error).toBeInstanceOf(Error);
            database.db.exec("DROP TRIGGER refuse_completion");
            expect(
              database.db.prepare("SELECT count(*) AS n FROM session_input_completions").get(),
            ).toEqual({ n: 0 });
          } else {
            expect(committed).toEqual(outcome);
            expect(committed).not.toBeInstanceOf(Promise);
            expect(
              database.db.prepare("SELECT succeeded FROM session_input_completions").all(),
            ).toEqual([{ succeeded: 1 }]);
          }
          const sql = observeHostDataSql(state.env);
          const unexpected: Promise<unknown>[] = [];
          try {
            const later = buildAgentRunTerminalOutcome({ status: "error", error: "later failure" });
            if (kind === "write error") {
              for (const complete of [
                () => recorder.completeProcessing!(later),
                () => completeUserTurnTranscriptProcessing(recorder, later),
              ]) {
                let repeated: { error: unknown } | undefined;
                try {
                  const returned = complete();
                  if (returned instanceof Promise) {
                    unexpected.push(returned);
                    void returned.catch(() => undefined);
                  }
                } catch (caught) {
                  repeated = { error: caught };
                }
                expect(repeated).toBeDefined();
                expect(repeated?.error).toBe(error);
              }
            } else {
              expect(recorder.completeProcessing!(later)).toBe(committed);
              expect(completeUserTurnTranscriptProcessing(recorder, later)).toBe(committed);
            }
            expect(sql.queries).toEqual([]);
          } finally {
            await Promise.allSettled(unexpected);
            sql.restore();
          }
        } finally {
          recorder.finishPendingInput?.("interrupted");
        }
      });
    },
  );

  it("finishes every collected source after the first source reports a failure", async () => {
    const failure = new Error("first source finish failed");
    const order: number[] = [];
    const sources = [0, 1].map((index) => {
      const source = createUserTurnTranscriptRecorder({
        input: { text: `source ${index}` },
        target: unusedRecorderTarget,
      });
      source.finishPendingInput = () => {
        order.push(index);
        if (index === 0) {
          throw failure;
        }
      };
      return source;
    });
    const collected = createUserTurnTranscriptRecorder({
      input: { text: "collected" },
      target: unusedRecorderTarget,
      pendingInputSources: sources,
    });
    let caught: { error: unknown } | undefined;
    let unexpected: Promise<void> | undefined;
    try {
      try {
        unexpected = finishUserTurnPendingInput(collected, "interrupted");
        void unexpected?.catch(() => undefined);
      } catch (error) {
        caught = { error };
      }
      expect(caught).toBeDefined();
      assert(caught?.error instanceof AggregateError);
      expect(caught.error.errors).toHaveLength(1);
      expect(caught.error.errors[0]).toBe(failure);
      expect(order).toEqual([0, 1]);
    } finally {
      await Promise.allSettled(unexpected ? [unexpected] : []);
    }
  });
});
