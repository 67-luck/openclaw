import { render } from "lit";
import type { LobsterPetPalette } from "../../components/lobster-pet-contract.ts";
import { canonicalLobsterLook, renderLobsterSvg } from "../../components/lobster-pet-look.ts";
import { createColorGuideArt } from "./coloring-color.ts";

export type ColoringMode = "outline" | "color";

const SHAPES = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "line",
  "text",
]);

// Read presentation inheritance before replacing it. In particular, filling an
// open antenna/stitch path white would close it with an unwanted straight edge.
function outline(element: SVGElement, inheritedFill = "black"): void {
  // Explicit translucent windows (such as portal rings) must not erase the
  // geometry visible through them when their color is removed.
  const fill = element.hasAttribute("fill-opacity")
    ? "none"
    : (element.getAttribute("fill") ?? inheritedFill);
  for (const child of Array.from(element.children)) {
    if (child instanceof SVGElement) {
      // The canonical art uses very faint paint for specular sheen, not
      // physical markings. Leave those highlights as white coloring space.
      const faintSheen = Number(child.getAttribute("opacity") ?? 1) <= 0.1;
      if (child.style.display === "none" || faintSheen) {
        child.remove();
      } else {
        outline(child, fill);
      }
    }
  }
  // Export the curated template, not computed pet CSS: no discovery silhouette,
  // theme tint, blink, translucency, blur, or animation belongs on paper.
  for (const attribute of [
    "class",
    "style",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "filter",
  ]) {
    element.removeAttribute(attribute);
  }
  element.removeAttribute("stroke");
  element.removeAttribute("stroke-width");
  element.setAttribute("fill", fill === "none" ? "none" : "white");
  if (SHAPES.has(element.localName)) {
    element.setAttribute("stroke", "black");
    element.setAttribute("stroke-width", element.localName === "text" ? "0.25" : "0.85");
    element.setAttribute("stroke-linejoin", "round");
    element.setAttribute("stroke-linecap", "round");
  }
  if (element.hasAttribute("font-family")) {
    // jsPDF's built-in Courier matches the terminal art without loading fonts.
    element.setAttribute("font-family", "courier");
  }
}

export function createColoringArt(
  palette: LobsterPetPalette,
  mode: ColoringMode = "outline",
): {
  svg: SVGSVGElement;
  dispose: () => void;
} {
  if (mode === "color") {
    const art = createColorGuideArt(palette);
    return fitArt(art.svg, art.dispose);
  }
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:120px;height:120px;pointer-events:none";
  // A shadow boundary prevents even global SVG rules from changing conversion.
  const root = host.attachShadow({ mode: "closed" });
  render(renderLobsterSvg(canonicalLobsterLook(palette), { standalone: true }), root);
  const svg = root.querySelector("svg");
  if (!svg) {
    throw new Error("Missing lobster artwork");
  }
  outline(svg);
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  document.body.append(host);
  return fitArt(svg, () => host.remove());
}

function fitArt(svg: SVGSVGElement, dispose: () => void) {
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  try {
    // Some replacement sprites extend beyond the pet viewport (balloon string,
    // tall antennae). Measure their actual geometry, then include stroke padding.
    const bounds = svg.getBBox();
    const x = Math.min(0, bounds.x) - 4;
    const y = Math.min(0, bounds.y) - 4;
    const width = Math.max(120, bounds.x + bounds.width) - x + 4;
    const height = Math.max(105, bounds.y + bounds.height) - y + 4;
    svg.setAttribute("viewBox", [x, y, width, height].join(" "));
    return { svg, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
