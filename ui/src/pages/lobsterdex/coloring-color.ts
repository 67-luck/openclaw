import { render } from "lit";
import type { LobsterPetPalette } from "../../components/lobster-pet-contract.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import lobsterStyles from "../../styles/lobster-pet.css?inline";

const PAINT = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "fill-rule",
  "display",
  "visibility",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
] as const;

export function createColorGuideArt(palette: LobsterPetPalette): {
  svg: SVGSVGElement;
  dispose: () => void;
} {
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
    // An independent light document resolves :root selectors and palette CSS
    // variables without inheriting or changing the user's selected theme.
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
    const nodes = [svg, ...svg.querySelectorAll<SVGElement>("*")];
    const boxes = new Map<SVGElement, DOMRect>();
    for (const shape of svg.querySelectorAll<SVGGraphicsElement>(
      "path,rect,circle,ellipse,polygon,polyline,line",
    )) {
      boxes.set(shape, shape.getBBox());
    }
    // Snapshot the whole cascade before removing classes: later descendants
    // still need their inherited fills, split/chimera overrides and currentColor.
    const snapshots = nodes.map((node) => {
      const computed = view.getComputedStyle(node);
      const paint = PAINT.map(
        (property) => [property, computed.getPropertyValue(property)] as const,
      );
      const box = boxes.get(node);
      return {
        node,
        paint,
        contour:
          box &&
          box.width * box.height > 250 &&
          computed.stroke === "none" &&
          computed.fill !== "none" &&
          Number(computed.opacity) > 0.15 &&
          !["svg", "g", "text"].includes(node.localName),
      };
    });
    for (const { node, paint, contour } of snapshots) {
      node.removeAttribute("class");
      node.removeAttribute("style");
      node.removeAttribute("filter");
      for (const [property, value] of paint) {
        node.setAttribute(property, value);
      }
      if (node.localName === "text" || node.hasAttribute("font-family")) {
        node.setAttribute("font-family", "courier");
      }
      // A fine print contour keeps translucent and near-white silhouettes
      // visible on paper; their canonical colors and opacity remain intact.
      if (contour) {
        node.setAttribute("stroke", "#0a1014");
        node.setAttribute("stroke-width", "0.45");
        node.setAttribute("stroke-linejoin", "round");
      }
    }
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
