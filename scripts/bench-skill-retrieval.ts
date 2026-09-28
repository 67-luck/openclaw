import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createInstalledSkillTools } from "../src/agents/tools/installed-skill-tools.js";
import { summarizeSkillRetrieval, type RetrievalObservation } from "./lib/skill-retrieval-eval.js";

const { values } = parseArgs({
  options: {
    dataset: { type: "string" },
    sizes: { type: "string", default: "20,100,500" },
    limit: { type: "string", default: "5" },
  },
});
const raw = await readFile(
  values.dataset ?? new URL("../test/fixtures/skill-retrieval.json", import.meta.url),
  "utf8",
);
const dataset = z
  .object({
    skills: z
      .array(
        z.object({ name: z.string().min(1), description: z.string(), instructions: z.string() }),
      )
      .min(1),
    queries: z
      .array(
        z.object({
          id: z.string().min(1),
          query: z.string().min(1),
          relevant: z.array(z.string()),
        }),
      )
      .min(1),
  })
  .parse(JSON.parse(raw));
const names = new Set(dataset.skills.map((skill) => skill.name));
if (
  names.size !== dataset.skills.length ||
  new Set(dataset.queries.map((query) => query.id)).size !== dataset.queries.length ||
  dataset.queries.some((query) => query.relevant.some((name) => !names.has(name)))
) {
  throw new Error("Dataset identities must be unique and every relevant skill must exist.");
}
const sizes = values.sizes.split(",").map(Number);
const limit = Number(values.limit);
if (
  sizes.some((size) => !Number.isInteger(size) || size < dataset.skills.length || size > 10_000) ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 20
) {
  throw new Error("Use catalog sizes between the fixture size and 10000, and a limit of 1-20.");
}
const resultSchema = z.object({ skills: z.array(z.object({ name: z.string() })) });
const results = [];
for (const size of sizes) {
  // These unrelated entries measure catalog growth, not semantic hard-negative quality.
  const distractors = Array.from({ length: size - dataset.skills.length }, (_, index) => ({
    name: `catalog-distractor-${index}`,
    description: `Maintain synthetic inventory item ${index}.`,
    instructions: `# Inventory ${index}\nRecord the warehouse shelf identifier and stock quantity.`,
  }));
  if (distractors.some((skill) => names.has(skill.name))) {
    throw new Error("Dataset names conflict with generated distractors.");
  }
  const skills = [...dataset.skills, ...distractors]
    .toSorted((a, b) => a.name.localeCompare(b.name, "en"))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      location: `/skills/${skill.name}/SKILL.md`,
      source: { filePath: `/skills/${skill.name}/SKILL.md`, readContent: skill.instructions },
    }));
  const search = createInstalledSkillTools(skills).find((tool) => tool.name === "skills_search");
  if (!search) {
    throw new Error("Installed skill search is unavailable.");
  }
  const rssBefore = process.memoryUsage().rss;
  const coldStart = performance.now();
  await search.execute("cold", { query: "catalog initialization", limit });
  const coldMs = performance.now() - coldStart;
  const observations: RetrievalObservation[] = [];
  for (const query of dataset.queries) {
    const start = performance.now();
    const result = resultSchema.parse(
      (await search.execute(query.id, { query: query.query, limit })).details,
    );
    const returned = result.skills.map((skill) => skill.name);
    if (returned.length > limit || new Set(returned).size !== returned.length) {
      throw new Error("Search returned duplicate results or exceeded its requested limit.");
    }
    observations.push({ ...query, returned, elapsedMs: performance.now() - start });
  }
  results.push({
    size,
    limit,
    coldMs,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    metrics: summarizeSkillRetrieval(observations, limit),
    observations,
  });
}
console.log(
  JSON.stringify(
    {
      datasetSha256: createHash("sha256").update(raw).digest("hex"),
      kind: "synthetic-retrieval-only",
      results,
    },
    null,
    2,
  ),
);
