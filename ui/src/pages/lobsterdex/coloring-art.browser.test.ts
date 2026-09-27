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
});
