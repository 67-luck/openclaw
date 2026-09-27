import type { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { i18n } from "../../i18n/index.ts";

const mocks = vi.hoisted(() => ({
  create: vi.fn<typeof import("./coloring-export.ts").createColoringDownload>(),
  download: vi.fn<typeof import("../../lib/download.ts").downloadBlobFile>(),
}));
vi.mock("./coloring-export.ts", () => ({ createColoringDownload: mocks.create }));
vi.mock("../../lib/download.ts", () => ({ downloadBlobFile: mocks.download }));
await import("./lobsterdex-page.ts");

let page: LitElement;
const result = { filename: "sheet.pdf", blob: new Blob(["pdf"], { type: "application/pdf" }) };
async function settle() {
  await vi.dynamicImportSettled();
  await page.updateComplete;
}
function choose(mode: "outline" | "color" = "outline") {
  button()
    .closest("wa-dropdown")!
    .dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: { value: mode } }, bubbles: true }),
    );
}
function button() {
  return page.querySelector<HTMLButtonElement>(".lobsterdex-page__download")!;
}

beforeEach(async () => {
  mocks.create.mockReset();
  mocks.download.mockReset();
  await i18n.setLocale("en");
  page = document.createElement("openclaw-lobsterdex-page") as LitElement;
  document.body.append(page);
  await page.updateComplete;
});
afterEach(() => page.remove());

describe("Lobsterdex export lifecycle", () => {
  it.each(["outline", "color"] as const)(
    "guards duplicate selections and reports progress for %s",
    async (mode) => {
      const pending = createDeferredCore<typeof result>();
      mocks.create.mockReturnValue(pending.promise);
      choose(mode);
      choose(mode);
      await settle();
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.create.mock.calls[0]?.slice(0, 2)).toEqual(["crimson", mode]);
      expect(button().disabled).toBe(true);
      expect(button().getAttribute("aria-busy")).toBe("true");
      expect(button().querySelector("svg")).not.toBeNull();
      const [target, selectedMode, signal, progress] = mocks.create.mock.calls[0]!;
      expect(target).toBe("crimson");
      expect(["outline", "color"]).toContain(selectedMode);
      expect(signal.aborted).toBe(false);
      progress(1, 2);
      await page.updateComplete;
      expect(page.querySelector(".lobsterdex-page__export-status")?.textContent).toContain("1/2");
      pending.resolve(result);
      await settle();
      expect(mocks.download).toHaveBeenCalledExactlyOnceWith(result.filename, result.blob);
      expect(button().disabled).toBe(false);
      expect(button().getAttribute("aria-busy")).toBe("false");
      expect(page.textContent).toContain("Download started");
    },
  );

  it("announces generation and download errors and allows retry", async () => {
    mocks.create.mockRejectedValueOnce(new Error("conversion failed")).mockResolvedValue(result);
    choose();
    await settle();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    expect(button().disabled).toBe(false);
    mocks.download.mockImplementationOnce(() => {
      throw new Error("download failed");
    });
    choose();
    await settle();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    choose();
    await settle();
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.textContent).toContain("Download started");
  });

  it("aborts on navigation and does not let stale completion overwrite a new export", async () => {
    const old = createDeferredCore<typeof result>();
    const current = createDeferredCore<typeof result>();
    mocks.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    choose();
    await settle();
    const [target, selectedMode, signal, progress] = mocks.create.mock.calls[0]!;
    expect(target).toBe("crimson");
    expect(["outline", "color"]).toContain(selectedMode);
    page.remove();
    expect(signal.aborted).toBe(true);
    document.body.append(page);
    await page.updateComplete;
    choose();
    await settle();
    old.resolve(result);
    progress(99, 99);
    await settle();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
    expect(page.textContent).not.toContain("99/99");
    current.resolve(result);
    await settle();
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });
});
