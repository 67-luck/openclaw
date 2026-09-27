import { render } from "lit";
import type { LobsterPetPalette } from "../../components/lobster-pet-contract.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import lobsterStyles from "../../styles/lobster-pet.css?inline";

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

type PrintPaint = { fill: string; hidden: boolean };

// Both outputs share pruning, geometry, stroke widths, and occlusion. Only the
// opaque fill changes; a guide is the coloring sheet filled in, not a pet image.
function preparePrintArt(
  element: Element,
  mode: ColoringMode,
  paints: ReadonlyMap<Element, PrintPaint>,
  inheritedFill = "black",
): void {
  // Open paths and translucent windows stay unfilled in both versions so rear
  // geometry remains visible and no unexpected closing edge appears.
  const fill = element.hasAttribute("fill-opacity")
    ? "none"
    : (element.getAttribute("fill") ?? inheritedFill);
  for (const child of Array.from(element.children)) {
    const faintSheen = Number(child.getAttribute("opacity") ?? 1) <= 0.1;
    if (paints.get(child)?.hidden || faintSheen) {
      child.remove();
    } else {
      preparePrintArt(child, mode, paints, fill);
    }
  }
  for (const attribute of [
    "class",
    "style",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "filter",
    "stroke",
    "stroke-width",
  ]) {
    element.removeAttribute(attribute);
  }
  element.setAttribute(
    "fill",
    fill === "none" ? "none" : mode === "color" ? paints.get(element)!.fill : "white",
  );
  if (SHAPES.has(element.localName)) {
    element.setAttribute("stroke", "black");
    element.setAttribute("stroke-width", element.localName === "text" ? "0.25" : "0.85");
    element.setAttribute("stroke-linejoin", "round");
    element.setAttribute("stroke-linecap", "round");
  }
  if (element.hasAttribute("font-family")) {
    element.setAttribute("font-family", "courier");
  }
}

export function createColoringArt(
  palette: LobsterPetPalette,
  mode: ColoringMode = "outline",
): { svg: SVGSVGElement; dispose: () => void } {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:160px;height:160px;border:0;pointer-events:none";
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    if (!doc || !view) {
      throw new Error("Print document is unavailable");
    }
    // Resolve the real palette cascade in a static light document, without
    // inheriting or changing the user's theme, discovery state, or animation.
    doc.documentElement.dataset.themeMode = "light";
    const style = doc.createElement("style");
    style.textContent =
      lobsterStyles +
      "\n* { animation:none!important;transition:none!important;filter:none!important }";
    doc.head.append(style);
    const container = doc.createElement("div");
    const look = canonicalLobsterLook(palette);
    container.className = "lobster-pet lobster-pet--palette-" + palette.id;
    container.style.cssText =
      lobsterLookStyle(look) + ";position:static;transform:none;width:120px;height:105px";
    doc.body.append(container);
    render(renderLobsterSvg(look, { standalone: true }), container, { creationScope: doc });
    const svg = container.querySelector<SVGSVGElement>("svg");
    if (!svg) {
      throw new Error("Missing lobster artwork");
    }
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ink = canvas.getContext("2d", { willReadFrequently: true });
    if (!ink) {
      throw new Error("Print colors are unavailable");
    }
    const paints = new Map<Element, PrintPaint>();
    const collectPaint = (element: Element, parentOpacity: number): void => {
      const computed = view.getComputedStyle(element);
      const opacity = parentOpacity * Number(computed.opacity);
      // Flatten fill alpha onto paper white. Keeping translucent fills would
      // expose rear outlines in the guide that the blank sheet correctly hides.
      ink.globalAlpha = 1;
      ink.fillStyle = "white";
      ink.fillRect(0, 0, 1, 1);
      ink.globalAlpha = opacity * Number(computed.fillOpacity);
      ink.fillStyle = computed.fill === "none" ? "white" : computed.fill;
      ink.fillRect(0, 0, 1, 1);
      const [r, g, b] = ink.getImageData(0, 0, 1, 1).data;
      paints.set(element, {
        fill: "rgb(" + r + ", " + g + ", " + b + ")",
        hidden: computed.display === "none",
      });
      for (const child of Array.from(element.children)) {
        collectPaint(child, opacity);
      }
    };
    collectPaint(svg, 1);
    preparePrintArt(svg, mode, paints);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // Include the balloon string, tall antennae, and all shared outline strokes.
    const bounds = svg.getBBox();
    const x = Math.min(0, bounds.x) - 4;
    const y = Math.min(0, bounds.y) - 4;
    const width = Math.max(120, bounds.x + bounds.width) - x + 4;
    const height = Math.max(105, bounds.y + bounds.height) - y + 4;
    svg.setAttribute("viewBox", [x, y, width, height].join(" "));
    return {
      svg,
      dispose: () => {
        svg.remove();
        frame.remove();
      },
    };
  } catch (error) {
    frame.remove();
    throw error;
  }
}
