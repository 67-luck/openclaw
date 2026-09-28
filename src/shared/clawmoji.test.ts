import { describe, expect, it } from "vitest";
import { AVATAR_MAX_DATA_URL_CHARS } from "./avatar-limits.js";
import {
  ClawmojiSchema,
  formatClawmojiSource,
  parseClawmojiSource,
  type Clawmoji,
} from "./clawmoji.js";

const source = "clawmoji:v1.ef4444.dc2626.111111.crown.droopy.mighty.sleepy.1.0";
const recipe: Clawmoji = {
  version: 1,
  shell: "#ef4444",
  claws: "#dc2626",
  eyes: "#111111",
  accessory: "crown",
  antennae: "droopy",
  clawSize: "mighty",
  personality: "sleepy",
  freckles: true,
  tailFan: false,
};
const avatar = `data:image/svg+xml;clawmoji=${source.slice("clawmoji:".length)};base64,PHN2Zy8+`;

describe("portable clawmoji sources", () => {
  it("shares one character across public metadata and the stored image", () => {
    expect(formatClawmojiSource(recipe)).toBe(source);
    expect(parseClawmojiSource(source)).toEqual(recipe);
    expect(parseClawmojiSource(avatar)).toEqual(recipe);
  });

  it.each([
    ["extra code", { ...recipe, code: "alert(1)" }],
    ["newline color", { ...recipe, shell: "#ef4444\n" }],
    ["unknown version", { ...recipe, version: 2 }],
  ])("rejects imported JSON with %s", (_label, input) => {
    expect(ClawmojiSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["plain PNG", "data:image/png;base64,PHN2Zy8+"],
    ["plain SVG", "data:image/svg+xml;base64,PHN2Zy8+"],
    ["remote image", `https://example.test/${source}`],
    ["unknown version", source.replace("v1.", "v2.")],
    ["invalid color", source.replace("ef4444", "url(x)")],
    ["unknown accessory", source.replace("crown", "script")],
    ["unknown personality", source.replace("sleepy", "malicious")],
    ["invalid boolean", source.replace(".1.0", ".true.0")],
    ["missing field", source.slice(0, -2)],
    ["extra field", `${source}.extra`],
    ["trailing newline", `${source}\n`],
    ["unbounded recipe", `clawmoji:${"a".repeat(129)}`],
    ["unbounded image", `${avatar}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS)}`],
    ["extra MIME parameter", avatar.replace(";base64,", ";secret=value;base64,")],
    ["wrong image type", avatar.replace("image/svg+xml", "text/html")],
    ["missing encoding", avatar.replace(";base64,", ",")],
  ])("does not enable character behavior for %s", (_label, input) => {
    expect(parseClawmojiSource(input)).toBeNull();
  });
});
