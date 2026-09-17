import { describe, expect, it } from "vitest";
import { scanFenceSpans } from "../../packages/markdown-core/src/fences.js";
import { protectBreakIndex, scanUnbreakableSpans } from "./embedded-agent-link-spans.js";

describe("embedded agent link spans", () => {
  it("merges nested protected spans before resolving a break", () => {
    const text = "[a[b](y)](z)";
    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);

    expect(spans).toEqual([{ start: 0, end: text.length, complete: true }]);
    expect(protectBreakIndex(spans, 5, 0, false)).toBe(text.length);
  });

  it("does not protect a label that starts inside fenced code", () => {
    const text = `prose
\`\`\`
code [label
\`\`\`
](https://example.com/${"a".repeat(40)})`;

    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);
    expect(spans.every((span) => span.start >= text.indexOf("https://"))).toBe(true);
  });

  it("does not protect a label that crosses fenced code", () => {
    const text = `Choose [a
\`\`\`js
${"code".repeat(20)}
\`\`\`
b](https://example.com/x) tail`;

    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);
    expect(spans.every((span) => span.start >= text.indexOf("https://"))).toBe(true);
  });

  it("ignores brackets inside inline code while finding a link label", () => {
    const text = `See [use \`]\` here](https://example.com/${"a".repeat(40)})`;

    expect(scanUnbreakableSpans(text, [], 30)).toEqual([
      { start: text.indexOf("["), end: text.length, complete: true },
    ]);
  });

  it("does not treat a label spanning a blank line as a link", () => {
    const text = `[label

paragraph](https://example.com/${"a".repeat(40)})`;

    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);
    expect(spans.every((span) => span.start >= text.indexOf("https://"))).toBe(true);
  });

  it("does not complete a bare URL merely because the streamed suffix ends in >", () => {
    const text = `https://example.com/${"a".repeat(40)}>`;

    expect(scanUnbreakableSpans(text, [], 30)).toEqual([
      { start: 0, end: text.length, complete: false },
    ]);
  });
});
