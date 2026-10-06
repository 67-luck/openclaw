// Advisory SKILL.md feedback for skill_workshop writes; never blocks a write.
import {
  parseFrontmatterBlock,
  stripFrontmatterBlock,
} from "../../../packages/markdown-core/src/frontmatter.js";

const MAX_DESCRIPTION_BYTES = 160;
const MAX_BODY_LINES = 250;
const MAX_BODY_BYTES = 12_000;
const MIN_NEGATION_LINES = 3;
const MAX_ADVISORIES = 3;
// Jaccard over name+description content words. Restated duplicates score ~0.8; siblings
// that share a tool, domain, or sentence shape score ~0.1-0.5.
const OVERLAP_THRESHOLD = 0.55;

const NO_OP_WORDS =
  /\b(?:powerful|comprehensive|robust|seamless(?:ly)?|cutting-edge|state-of-the-art|be thorough|make sure to)\b/gi;
const SHOUTING = /\bIMPORTANT\b/g;
const NEGATION_LINE = /^(?:[-*+]|\d+[.)])?\s*(?:\*\*)?(?:never|don['’]t|do not)\b/i;
const NARRATIVE_LINE = /^(?:[-*+]\s*)?(?:\*\*)?(?:UPDATE|NOTE|EDIT)\b|\b20\d\d-\d\d-\d\d\b/;
const STOPWORD =
  /^(?:an|and|any|are|as|at|be|by|for|from|in|into|is|it|its|of|on|or|that|the|this|to|use|used|using|when|where|which|while|with|without|you|your|user|asks?|asked|skills?|tasks?)$/;

type SkillLintFinding = { rule: string; message: string };

type SkillSummary = { name: string; description: string };

function readDescription(content: string): string {
  return (parseFrontmatterBlock(content).description ?? "").trim();
}

/** Authoring-convention findings for one SKILL.md, most useful first. */
export function lintSkillMarkdown(content: string): SkillLintFinding[] {
  const description = readDescription(content);
  const body = stripFrontmatterBlock(content);
  // Code is quoted material; only prose carries authoring style.
  const prose = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .map((line) => line.trim());
  const descriptionBytes = Buffer.byteLength(description);
  const bodyLines = body.split("\n").length;
  const bodyBytes = Buffer.byteLength(body);
  const styled = [description, ...prose].join("\n");
  const noOps = [
    ...new Set([...(styled.match(NO_OP_WORDS) ?? []), ...(styled.match(SHOUTING) ?? [])]),
  ];
  const negations = prose.filter((line) => NEGATION_LINE.test(line)).length;
  const checks: Array<[rule: string, message: string | false]> = [
    [
      "description-length",
      descriptionBytes > MAX_DESCRIPTION_BYTES &&
        `description is ${descriptionBytes} bytes; trim it to ≤${MAX_DESCRIPTION_BYTES} with the trigger first.`,
    ],
    [
      "description-identity",
      /^(?:this|a|the) skill\b/i.test(description) &&
        'description opens with "This skill"; open with the situation that triggers it.',
    ],
    [
      "sprawl",
      (bodyLines > MAX_BODY_LINES || bodyBytes > MAX_BODY_BYTES) &&
        `SKILL.md body is ${bodyLines} lines (${bodyBytes} bytes); move reference only some runs need into references/ and point to it from its step.`,
    ],
    [
      "no-op",
      noOps.length > 0 &&
        `cut no-op emphasis (${noOps.slice(0, 3).join(", ")}); plain steps carry the same weight.`,
    ],
    [
      "negation",
      negations >= MIN_NEGATION_LINES &&
        `${negations} lines start with Never/Don't; state the behavior to produce instead.`,
    ],
    [
      "narrative",
      prose.some((line) => NARRATIVE_LINE.test(line)) &&
        "found an update note or date; fold the lesson into the step it changes.",
    ],
  ];
  return checks.flatMap(([rule, message]) => (message ? [{ rule, message }] : []));
}

function overlapTokens(skill: SkillSummary): Set<string> {
  const words = `${skill.name} ${skill.description}`.toLowerCase().split(/[^a-z0-9]+/);
  return new Set(
    words
      .filter((word) => word.length > 1 && !STOPWORD.test(word))
      .map((word) => (word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word)),
  );
}

/** Jaccard similarity of name+description content words. */
export function skillOverlapScore(a: SkillSummary, b: SkillSummary): number {
  const left = overlapTokens(a);
  const right = overlapTokens(b);
  const shared = [...left].filter((token) => right.has(token)).length;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Advisory lines for a successful SKILL.md write: the closest other live skill when the
 * description changed, then lint rules this write introduced (standing ones stay quiet).
 */
export function skillWriteAdvisories(params: {
  name: string;
  before: string;
  after: string;
  others: readonly SkillSummary[];
}): string[] {
  const advisories: string[] = [];
  const description = readDescription(params.after);
  if (description !== readDescription(params.before)) {
    const self = { name: params.name, description };
    const closest = params.others
      .filter((other) => other.name !== params.name)
      .map((other) => ({ name: other.name, score: skillOverlapScore(self, other) }))
      .toSorted((a, b) => b.score - a.score)[0];
    if (closest && closest.score >= OVERLAP_THRESHOLD) {
      advisories.push(
        `Advisory (not blocking): overlaps "${closest.name}". If both cover the same class of task, merge them: patch the broader skill, then archive the other with absorbed_into=<broader>.`,
      );
    }
  }
  const standing = new Set(lintSkillMarkdown(params.before).map((finding) => finding.rule));
  for (const finding of lintSkillMarkdown(params.after)) {
    if (!standing.has(finding.rule)) {
      advisories.push(`Advisory (not blocking): ${finding.message} Fix with action=patch.`);
    }
  }
  return advisories.slice(0, MAX_ADVISORIES);
}
