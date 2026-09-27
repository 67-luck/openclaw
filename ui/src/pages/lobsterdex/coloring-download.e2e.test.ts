import { readFile } from "node:fs/promises";
import { createEngine } from "clawpdf";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({ name: "Lobsterdex coloring downloads" });

suite.define(() => {
  it("downloads a real PDF and a complete ZIP without changing discoveries", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(suite.server.baseUrl + "settings/lobsterdex");
        const first = page.locator("#lobsterdex-crimson .lobsterdex-page__download");
        await first.waitFor();
        const storage = await page.evaluate(() =>
          localStorage.getItem("openclaw.control.lobsterdex.v1"),
        );
        const singlePromise = page.waitForEvent("download");
        await first.tap();
        const single = await singlePromise;
        expect(single.suggestedFilename()).toBe("lobsterdex-crimson-crimson.pdf");
        const singlePath = await single.path();
        expect(singlePath).not.toBeNull();
        const engine = await createEngine();
        try {
          const pdf = await engine.open(await readFile(singlePath!));
          expect(pdf.pageCount).toBe(1);
          expect(pdf.text()).toContain("crimson");
          pdf.destroy();
          const zipPromise = page.waitForEvent("download");
          await page.getByRole("button", { name: "Download all coloring sheets (ZIP)" }).tap();
          const download = await zipPromise;
          expect(download.suggestedFilename()).toBe("lobsterdex-coloring-sheets.zip");
          const zipPath = await download.path();
          const zip = await JSZip.loadAsync(await readFile(zipPath!), { checkCRC32: true });
          expect(Object.keys(zip.files)).toHaveLength(LOBSTER_PET_PALETTES.length);
          for (const palette of LOBSTER_PET_PALETTES) {
            const file = Object.values(zip.files).find((entry) =>
              entry.name.startsWith("lobsterdex-" + palette.id + "-"),
            );
            expect(file?.dir).toBe(false);
            const sheet = await engine.open(await file!.async("uint8array"));
            try {
              expect(sheet.pageCount, palette.id).toBe(1);
              expect(sheet.text()).toContain(lobsterPaletteName(palette.id));
              const printed = sheet.page(1);
              expect(printed.width).toBeCloseTo(595.28, 1);
              expect(printed.height).toBeCloseTo(841.89, 1);
              const image = printed.render({ width: 210 });
              // Count ink in the illustration, excluding the title. Reject blank
              // sheets and solid silhouettes with an independent PDFium renderer.
              let ink = 0;
              let colored = 0;
              for (let y = 55; y < 265; y++) {
                for (let x = 20; x < 190; x++) {
                  const offset = (y * image.width + x) * 4;
                  const r = image.rgba[offset]!;
                  if (image.rgba[offset + 1] !== r || image.rgba[offset + 2] !== r) {
                    colored++;
                  }
                  if (r < 128) {
                    ink++;
                  }
                }
              }
              expect(colored, palette.id).toBe(0);
              expect(ink, palette.id).toBeGreaterThan(80);
              expect(ink, palette.id).toBeLessThan(4_000);
            } finally {
              sheet.destroy();
            }
          }
        } finally {
          await engine.destroy();
        }
        expect(
          await page.evaluate(() => localStorage.getItem("openclaw.control.lobsterdex.v1")),
        ).toBe(storage);
        expect(await first.isEnabled()).toBe(true);
        expect(await page.getByRole("alert").count()).toBe(0);
      },
    );
  });
});
