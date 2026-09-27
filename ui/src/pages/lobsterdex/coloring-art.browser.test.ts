import { describe, expect, it } from "vitest";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { createColoringArt } from "./coloring-art.ts";

describe("Lobsterdex coloring artwork", () => {
  it("keeps every canonical shape printable, bounded, static, and theme-independent", () => {
    const theme = document.documentElement.getAttribute("data-theme-mode");
    try {
      for (const palette of LOBSTER_PET_PALETTES) {
        document.documentElement.setAttribute("data-theme-mode", "light");
        const light = createColoringArt(palette);
        document.documentElement.setAttribute("data-theme-mode", "dark");
        const dark = createColoringArt(palette);
        try {
          expect(dark.svg.outerHTML, palette.id).toBe(light.svg.outerHTML);
          expect(light.svg.querySelectorAll("[class], [style], [opacity], [filter]")).toHaveLength(
            0,
          );
          expect(light.svg.querySelectorAll("[stroke=black]").length, palette.id).toBeGreaterThan(
            4,
          );
          expect(
            [...light.svg.querySelectorAll("[fill]")].every((el) =>
              ["white", "none"].includes(el.getAttribute("fill") ?? ""),
            ),
          ).toBe(true);
          const bounds = light.svg.getBBox();
          const frame = light.svg.viewBox.baseVal;
          expect(bounds.width, palette.id).toBeGreaterThan(50);
          expect(bounds.height, palette.id).toBeGreaterThan(50);
          expect(bounds.x).toBeGreaterThan(frame.x);
          expect(bounds.y).toBeGreaterThan(frame.y);
          expect(bounds.x + bounds.width).toBeLessThan(frame.x + frame.width);
          expect(bounds.y + bounds.height).toBeLessThan(frame.y + frame.height);
          expect(light.svg.getAnimations({ subtree: true })).toHaveLength(0);
          if (palette.id === "ascii") {
            expect(light.svg.querySelector("[font-family]")?.getAttribute("font-family")).toBe(
              "courier",
            );
            expect(light.svg.textContent).toContain("(o)     (o)");
            expect(light.svg.textContent).not.toContain("(-)");
          }
        } finally {
          light.dispose();
          dark.dispose();
        }
        expect(light.svg.isConnected).toBe(false);
      }
    } finally {
      if (theme === null) {
        document.documentElement.removeAttribute("data-theme-mode");
      } else {
        document.documentElement.setAttribute("data-theme-mode", theme);
      }
    }
  });

  it("resolves canonical color paint in an isolated light document", () => {
    const previous = document.documentElement.getAttribute("data-theme-mode");
    try {
      for (const palette of LOBSTER_PET_PALETTES) {
        document.documentElement.setAttribute("data-theme-mode", "light");
        const light = createColoringArt(palette, "color");
        document.documentElement.setAttribute("data-theme-mode", "dark");
        const dark = createColoringArt(palette, "color");
        try {
          expect(dark.svg.outerHTML, palette.id).toBe(light.svg.outerHTML);
          expect(light.svg.outerHTML).not.toContain("var(");
          expect(light.svg.outerHTML).not.toContain("currentColor");
          expect(light.svg.querySelectorAll("[class], [style], [filter]")).toHaveLength(0);
          expect(light.svg.getAnimations({ subtree: true })).toHaveLength(0);
          if (palette.id === "split") {
            expect(light.svg.querySelector('path[d^="M100 42"]')?.getAttribute("fill")).toBe(
              "rgb(70, 83, 107)",
            );
          }
          if (palette.id === "chimera") {
            expect(light.svg.querySelector('path[d^="M20 42"]')?.getAttribute("fill")).toBe(
              "rgb(74, 125, 252)",
            );
          }
          if (palette.id === "ascii") {
            expect(light.svg.querySelector("text")?.getAttribute("fill")).toBe("rgb(70, 82, 94)");
          }
          if (palette.id === "mood") {
            expect(light.svg.querySelector('path[d^="M60 8"]')?.getAttribute("fill")).toBe(
              "rgb(127, 119, 221)",
            );
          }
          if (palette.id === "portal") {
            expect(light.svg.querySelector("ellipse")?.getAttribute("stroke")).toBe("black");
            expect(light.svg.querySelector('path[d^="M31 30"]')?.getAttribute("fill")).toBe(
              "rgb(176, 67, 47)",
            );
          }
        } finally {
          light.dispose();
          dark.dispose();
        }
        expect(light.svg.isConnected).toBe(false);
      }
    } finally {
      if (previous === null) {
        document.documentElement.removeAttribute("data-theme-mode");
      } else {
        document.documentElement.setAttribute("data-theme-mode", previous);
      }
    }
  });
  it("keeps every guide's geometry and opaque black linework identical to its blank sheet", () => {
    const linework = (svg: SVGSVGElement) => {
      const view = svg.ownerDocument.defaultView!;
      return [
        ...svg.querySelectorAll<SVGElement>("path,rect,circle,ellipse,polygon,polyline,line,text"),
      ]
        .filter((shape) => {
          for (let node: Element | null = shape; node; node = node.parentElement) {
            if (view.getComputedStyle(node).display === "none") {
              return false;
            }
          }
          return true;
        })
        .map((shape) => {
          const paint = view.getComputedStyle(shape);
          let opacity = 1;
          for (let node: Element | null = shape; node; node = node.parentElement) {
            opacity *= Number(view.getComputedStyle(node).opacity);
          }
          return {
            tag: shape.localName,
            geometry: [...shape.attributes]
              .filter((attr) =>
                [
                  "d",
                  "points",
                  "x",
                  "y",
                  "cx",
                  "cy",
                  "r",
                  "rx",
                  "ry",
                  "width",
                  "height",
                  "transform",
                ].includes(attr.name),
              )
              .map((attr) => [attr.name, attr.value])
              .toSorted(([a], [b]) => a!.localeCompare(b!)),
            stroke: paint.stroke,
            width: paint.strokeWidth,
            linecap: paint.strokeLinecap,
            linejoin: paint.strokeLinejoin,
            dash: paint.strokeDasharray,
            opacity: opacity * Number(paint.strokeOpacity),
            empty: paint.fill === "none",
          };
        });
    };
    for (const palette of LOBSTER_PET_PALETTES) {
      const blank = createColoringArt(palette, "outline");
      const guide = createColoringArt(palette, "color");
      try {
        const coloredLines = linework(guide.svg);
        expect(coloredLines, palette.id).toEqual(linework(blank.svg));
        expect(guide.svg.getAttribute("viewBox"), palette.id).toBe(
          blank.svg.getAttribute("viewBox"),
        );
        expect(
          coloredLines.every((line) => line.stroke === "rgb(0, 0, 0)" && line.opacity === 1),
          palette.id,
        ).toBe(true);
      } finally {
        blank.dispose();
        guide.dispose();
      }
    }
  });
});
