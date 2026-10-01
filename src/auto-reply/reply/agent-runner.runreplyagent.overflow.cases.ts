import { expect, it } from "vitest";
import type { ReplyOverflowFixture } from "./agent-runner.runreplyagent.e2e.test.js";

export function registerOverflowPresentationCases({
  createMinimalRun,
  state,
}: ReplyOverflowFixture) {
  it("surfaces overflow fallback when embedded run returns empty payloads", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [],
      meta: {
        durationMs: 1,
        error: {
          kind: "context_overflow",
          message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        },
      },
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payload = Array.isArray(res) ? res[0] : res;
    if (!payload) {
      throw new Error("expected payload");
    }
    expect(payload.text).toContain("Auto-compaction could not recover this turn");
    expect(payload.text).toContain("fresh session or using a model with a larger context window");
    expect(payload.text).toContain("/new");
  });

  it("surfaces overflow fallback when embedded payload text is whitespace-only", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
      payloads: [{ text: "   \n\t  ", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "context_overflow",
          message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        },
      },
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payload = Array.isArray(res) ? res[0] : res;
    if (!payload) {
      throw new Error("expected payload");
    }
    expect(payload.text).toContain("Auto-compaction could not recover this turn");
    expect(payload.text).toContain("fresh session or using a model with a larger context window");
    expect(payload.text).toContain("/new");
  });
}
