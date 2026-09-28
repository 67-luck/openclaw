type RetrievalQuery = {
  id: string;
  query: string;
  relevant: string[];
};

export type RetrievalObservation = RetrievalQuery & {
  returned: string[];
  elapsedMs: number;
};

/** Score relevance independently of the retriever's scores or ordering implementation. */
export function summarizeSkillRetrieval(observations: RetrievalObservation[], limit: number) {
  const positive = observations.filter((row) => row.relevant.length > 0);
  const negative = observations.filter((row) => row.relevant.length === 0);
  const mean = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  const hits = (row: RetrievalObservation) =>
    new Set(row.returned.slice(0, limit).filter((name) => row.relevant.includes(name)));
  return {
    queries: observations.length,
    positiveQueries: positive.length,
    negativeQueries: negative.length,
    hitAt1: mean(positive.map((row) => Number(row.relevant.includes(row.returned[0] ?? "")))),
    recallAtK: mean(positive.map((row) => hits(row).size / new Set(row.relevant).size)),
    allRelevantAtK: mean(
      positive.map((row) => Number(hits(row).size === new Set(row.relevant).size)),
    ),
    reciprocalRankAtK: mean(
      positive.map((row) => {
        const rank = row.returned.slice(0, limit).findIndex((name) => row.relevant.includes(name));
        return rank < 0 ? 0 : 1 / (rank + 1);
      }),
    ),
    falsePositiveRate: mean(negative.map((row) => Number(row.returned.length > 0))),
    meanElapsedMs: mean(observations.map((row) => row.elapsedMs)),
  };
}
