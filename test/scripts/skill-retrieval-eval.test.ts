import { describe, expect, it } from "vitest";
import { summarizeSkillRetrieval } from "../../scripts/lib/skill-retrieval-eval.js";

describe("skill retrieval metrics", () => {
  it("separates partial multi-skill recall, rank, and false activation", () => {
    const result = summarizeSkillRetrieval(
      [
        { id: "multi", query: "a", relevant: ["a", "b"], returned: ["x", "a", "b"], elapsedMs: 4 },
        { id: "miss", query: "c", relevant: ["c"], returned: [], elapsedMs: 2 },
        { id: "none", query: "none", relevant: [], returned: ["x"], elapsedMs: 3 },
      ],
      2,
    );
    expect(result).toMatchObject({
      positiveQueries: 2,
      negativeQueries: 1,
      hitAt1: 0,
      recallAtK: 0.25,
      allRelevantAtK: 0,
      reciprocalRankAtK: 0.25,
      falsePositiveRate: 1,
      meanElapsedMs: 3,
    });
  });

  it("does not inflate recall with duplicates or invent measurements for absent query classes", () => {
    expect(
      summarizeSkillRetrieval(
        [{ id: "one", query: "a", relevant: ["a", "b"], returned: ["a", "a"], elapsedMs: 1 }],
        2,
      ),
    ).toMatchObject({ recallAtK: 0.5, allRelevantAtK: 0, falsePositiveRate: null });
    expect(summarizeSkillRetrieval([], 5)).toMatchObject({
      hitAt1: null,
      recallAtK: null,
      reciprocalRankAtK: null,
      falsePositiveRate: null,
      meanElapsedMs: null,
    });
  });
});
