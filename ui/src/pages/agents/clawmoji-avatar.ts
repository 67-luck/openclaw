import { render, nothing } from "lit";
import { formatClawmojiSource, type Clawmoji } from "../../../../src/shared/clawmoji.js";
import { clawmojiLook } from "../../components/clawmoji-look.ts";
import { lobsterLookStyle, renderLobsterSvg } from "../../components/lobster-pet-look.ts";
import { AVATAR_EDITOR_MAX_DATA_URL_CHARS } from "./avatar-image.ts";

/** Freeze the canonical rig's styles so an avatar needs no surrounding page CSS. */
export function clawmojiAvatar(recipe: Clawmoji): string {
  const host = document.createElement("div");
  const look = clawmojiLook(recipe);
  host.style.cssText = `position:fixed;left:-10000px;width:120px;visibility:hidden;${lobsterLookStyle(look)};--lob-glint:${recipe.eyes}`;
  document.body.append(host);
  try {
    render(renderLobsterSvg(look, { standalone: true }), host);
    const svg = host.querySelector("svg")!;
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("viewBox", "-8 -8 136 120");
    svg.setAttribute("width", "96");
    svg.setAttribute("height", "96");
    for (const element of svg.querySelectorAll<SVGElement>("*")) {
      const computed = getComputedStyle(element);
      for (const property of ["fill", "stroke"] as const) {
        if (
          element.getAttribute(property)?.includes("var(") ||
          (property === "fill" && element.classList.contains("lob-tail"))
        ) {
          element.setAttribute(property, computed[property]);
        }
      }
      if (element.matches(".lob-claw > path")) {
        element.style.transform = computed.transform;
        element.style.transformOrigin = computed.transformOrigin;
        element.style.transformBox = "view-box";
      }
    }
    const walker = document.createTreeWalker(svg, NodeFilter.SHOW_COMMENT);
    const comments: Node[] = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    for (const comment of comments) comment.parentNode?.removeChild(comment);
    const artwork = new XMLSerializer().serializeToString(svg);
    const recipeToken = formatClawmojiSource(recipe).slice("clawmoji:".length);
    const avatar = `data:image/svg+xml;clawmoji=${recipeToken};base64,${btoa(artwork)}`;
    if (avatar.length > AVATAR_EDITOR_MAX_DATA_URL_CHARS) {
      throw new Error("Clawmoji artwork exceeds the avatar size limit.");
    }
    return avatar;
  } finally {
    render(nothing, host);
    host.remove();
  }
}
