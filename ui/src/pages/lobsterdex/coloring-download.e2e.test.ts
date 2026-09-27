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
  it("reveals the icon on hover/focus and opens its keyboard menu without layout shifts", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(suite.server.baseUrl + "settings/lobsterdex");
      const card = page.locator("#lobsterdex-crimson");
      const trigger = card.getByRole("button", { name: "Download PDFs for crimson", exact: true });
      await trigger.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(0, 0);
      const opacity = () => trigger.evaluate((button) => getComputedStyle(button).opacity);
      await expect.poll(opacity).toBe("0");
      const bounds = await card.boundingBox();
      await card.locator("h3").hover();
      await expect.poll(opacity).toBe("1");
      expect(await card.boundingBox()).toEqual(bounds);
      await page.mouse.move(0, 0);
      await expect.poll(opacity).toBe("0");
      await card.getByRole("button", { name: "Copy link" }).focus();
      await expect.poll(opacity).toBe("1");
      await page.keyboard.press("Tab");
      expect(await trigger.evaluate((button) => button.matches(":focus-visible"))).toBe(true);
      // Native button activation opens Web Awesome; arrows navigate its open menu.
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Color guide (PDF)", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
      expect(await card.boundingBox()).toEqual(bounds);
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Color guide (PDF)", exact: true }).waitFor();
      await page.keyboard.press("ArrowDown");
      const pending = page.waitForEvent("download");
      await page.keyboard.press("Enter");
      const download = await pending;
      expect(download.suggestedFilename()).toBe("lobsterdex-crimson-crimson-color-guide.pdf");
      expect(await download.failure()).toBeNull();
      await page.setViewportSize({ width: 390, height: 844 });
      await trigger.evaluate((button) => button.blur());
      await page.mouse.move(0, 0);
      await expect.poll(opacity).toBe("1");
    });
  });

  it("keeps the icon visible on a wide touch screen", async () => {
    await suite.withPage(
      { viewport: { width: 1024, height: 900 }, hasTouch: true },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(suite.server.baseUrl + "settings/lobsterdex");
        const trigger = page.locator("#lobsterdex-crimson .lobsterdex-page__download");
        await trigger.waitFor();
        expect(await trigger.evaluate((button) => getComputedStyle(button).opacity)).toBe("1");
        await trigger.tap();
        await page.getByRole("menuitem", { name: "Color guide (PDF)", exact: true }).waitFor();
      },
    );
  });

  it.each(["outline", "color"] as const)(
    "downloads a real %s PDF and complete ZIP without changing discoveries",
    async (mode) => {
      await suite.withPage(
        { viewport: { width: 390, height: 844 }, hasTouch: true },
        async ({ page }) => {
          await installMockGateway(page);
          await page.addInitScript(() => {
            localStorage.setItem(
              "openclaw.control.lobsterdex.v1",
              JSON.stringify({
                crimson: { name: "Ruby", firstSeenAt: 1783684800000, shinySeenAt: 1783771200000 },
              }),
            );
          });
          await page.goto(suite.server.baseUrl + "settings/lobsterdex");
          const first = page.locator("#lobsterdex-crimson .lobsterdex-page__download");
          await first.waitFor();
          expect(await first.evaluate((button) => getComputedStyle(button).opacity)).toBe("1");
          const target = await first.boundingBox();
          const dates = await page
            .locator("#lobsterdex-crimson .lobsterdex-page__dates")
            .boundingBox();
          const card = page.locator("#lobsterdex-crimson");
          const bounds = await card.boundingBox();
          const link = await card.getByRole("button", { name: "Copy link" }).boundingBox();
          expect(target!.width).toBe(link!.width);
          expect(target!.height).toBe(link!.height);
          expect(target!.y).toBe(link!.y);
          expect(bounds!.x + bounds!.width - target!.x - target!.width).toBeCloseTo(
            link!.x - bounds!.x,
          );
          expect(target!.y + target!.height).toBeLessThan(dates!.y);
          expect(await card.evaluate((el) => getComputedStyle(el).paddingBottom)).toBe("13px");
          const storage = await page.evaluate(() =>
            localStorage.getItem("openclaw.control.lobsterdex.v1"),
          );
          const singlePromise = page.waitForEvent("download");
          await first.tap();
          await page
            .getByRole("menuitem", {
              name: mode === "color" ? "Color guide (PDF)" : "Coloring sheet (PDF)",
              exact: true,
            })
            .click();
          const single = await singlePromise;
          expect(single.suggestedFilename()).toBe(
            mode === "color"
              ? "lobsterdex-crimson-crimson-color-guide.pdf"
              : "lobsterdex-crimson-crimson.pdf",
          );
          const singlePath = await single.path();
          expect(singlePath).not.toBeNull();
          const engine = await createEngine();
          try {
            const pdf = await engine.open(await readFile(singlePath!));
            expect(pdf.pageCount).toBe(1);
            expect(pdf.text()).toContain("crimson");
            pdf.destroy();
            const zipPromise = page.waitForEvent("download");
            await page.getByRole("button", { name: "Download all (ZIP)", exact: true }).tap();
            await page
              .getByRole("menuitem", {
                name: mode === "color" ? "Color guides (ZIP)" : "Coloring sheets (ZIP)",
                exact: true,
              })
              .click();
            const download = await zipPromise;
            expect(download.suggestedFilename()).toBe(
              mode === "color" ? "lobsterdex-color-guides.zip" : "lobsterdex-coloring-sheets.zip",
            );
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
                if (mode === "outline") {
                  expect(colored, palette.id).toBe(0);
                  expect(ink, palette.id).toBeGreaterThan(80);
                  expect(ink, palette.id).toBeLessThan(4_000);
                } else {
                  expect(colored, palette.id).toBeGreaterThan(80);
                }
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
    },
  );
});
