import type { Clawmoji } from "../../../src/shared/clawmoji.js";
import { canonicalLobsterLook } from "./lobster-pet-look.ts";

/** The existing rig owns both the avatar and every animated pose. */
export function clawmojiLook(recipe: Clawmoji) {
  return {
    ...canonicalLobsterLook({ id: "crimson", shell: recipe.shell, claw: recipe.claws }),
    accessory: recipe.accessory,
    antennae: recipe.antennae,
    clawSize: recipe.clawSize,
    personality: recipe.personality,
    freckles: recipe.freckles,
    tailFan: recipe.tailFan,
    glint: recipe.eyes,
  };
}
