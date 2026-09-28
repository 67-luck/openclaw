# Installed Skill Retrieval Evaluation

Run the real `skills_search` tool against a fixed synthetic catalog:

```sh
pnpm exec tsx scripts/bench-skill-retrieval.ts
pnpm exec tsx scripts/bench-skill-retrieval.ts --sizes 20,100,1000 --limit 10
```

The JSON report includes the fixture digest, catalog size, cold search latency,
warm query latency, process RSS delta, returned identities, top-1 hit rate,
recall at the requested limit, complete multi-skill recall, reciprocal rank,
and the false-positive rate on queries with no relevant skill. Missing query
classes produce `null`, not a perfect score. RSS is an observation, not a stable
performance threshold.

The fixtures cover exact names, body-only terms, paraphrases, a non-English
query, related skills, multiple required skills, and no-match requests.
Generated inventory entries measure catalog growth. They are not semantic hard
negatives. All supplied relevant skills remain in every catalog size.

Use `--dataset path/to/dataset.json` for a separately curated catalog. Its format
matches `test/fixtures/skill-retrieval.json`. Keep query labels fixed before
changing a retriever. Compare revisions with the same dataset digest, catalog
sizes, result limit, and environment. Preserve per-query results; aggregate
recall alone can hide regressions.

This is not SkillsBench and does not measure task completion, successful skill
application, or safety. There are no model calls, external services, or reads
of operator-installed skills. Semantic providers must be evaluated separately
before their gains, cost, or latency can be claimed.
