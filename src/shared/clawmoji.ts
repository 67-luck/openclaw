import { z } from "zod";
import { AVATAR_MAX_DATA_URL_CHARS } from "./avatar-limits.js";

const color = z
  .string()
  .length(7)
  .regex(/^#[0-9a-f]{6}$/);
const RECIPE_MAX_CHARS = 128;
const CLAWMOJI_SOURCE_PREFIX = "clawmoji:";
const CLAWMOJI_AVATAR_PREFIX = "data:image/svg+xml;clawmoji=";

/** Recipes select built-in artwork; they never supply SVG, CSS, or code. */
export const ClawmojiSchema = z
  .object({
    version: z.literal(1),
    shell: color,
    claws: color,
    eyes: color,
    accessory: z.enum(["none", "crown", "sprout", "patch", "monocle", "party"]),
    antennae: z.enum(["perky", "droopy"]),
    clawSize: z.enum(["dainty", "regular", "mighty"]),
    personality: z.enum(["friendly", "sleepy", "zoomy", "showoff"]),
    freckles: z.boolean(),
    tailFan: z.boolean(),
  })
  .strict();

export type Clawmoji = z.infer<typeof ClawmojiSchema>;

export function formatClawmojiSource(recipe: Clawmoji): string {
  return `${CLAWMOJI_SOURCE_PREFIX}${[
    "v1",
    recipe.shell.slice(1),
    recipe.claws.slice(1),
    recipe.eyes.slice(1),
    recipe.accessory,
    recipe.antennae,
    recipe.clawSize,
    recipe.personality,
    Number(recipe.freckles),
    Number(recipe.tailFan),
  ].join(".")}`;
}

/** Read only the bounded recipe; never parse or execute the avatar's artwork. */
export function parseClawmojiSource(source: string | null | undefined): Clawmoji | null {
  if (!source || source.length > AVATAR_MAX_DATA_URL_CHARS) {
    return null;
  }
  const encoded = source.startsWith(CLAWMOJI_AVATAR_PREFIX)
    ? /^([^;]{1,128});base64,/.exec(
        source.slice(
          CLAWMOJI_AVATAR_PREFIX.length,
          CLAWMOJI_AVATAR_PREFIX.length + RECIPE_MAX_CHARS + 8,
        ),
      )?.[1]
    : source.startsWith(CLAWMOJI_SOURCE_PREFIX) &&
        source.length <= CLAWMOJI_SOURCE_PREFIX.length + RECIPE_MAX_CHARS
      ? source.slice(CLAWMOJI_SOURCE_PREFIX.length)
      : undefined;
  if (!encoded || /[^a-z0-9.]/.test(encoded)) {
    return null;
  }
  const parts = encoded.split(".");
  if (
    parts.length !== 10 ||
    parts[0] !== "v1" ||
    !/^[01]$/.test(parts[8] ?? "") ||
    !/^[01]$/.test(parts[9] ?? "")
  ) {
    return null;
  }
  const parsed = ClawmojiSchema.safeParse({
    version: 1,
    shell: `#${parts[1]}`,
    claws: `#${parts[2]}`,
    eyes: `#${parts[3]}`,
    accessory: parts[4],
    antennae: parts[5],
    clawSize: parts[6],
    personality: parts[7],
    freckles: parts[8] === "1",
    tailFan: parts[9] === "1",
  });
  return parsed.success ? parsed.data : null;
}
