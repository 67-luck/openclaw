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
  it("guards duplicate clicks, reports progress, and downloads only once", async () => {
    const pending = createDeferredCore<typeof result>();
    mocks.create.mockReturnValue(pending.promise);
    button().click();
    button().click();
    await settle();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    const [, signal, progress] = mocks.create.mock.calls[0]!;
    expect(signal.aborted).toBe(false);
    progress(1, 2);
    await page.updateComplete;
    expect(page.querySelector(".lobsterdex-page__export-status")?.textContent).toContain("1/2");
    pending.resolve(result);
    await settle();
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(result.filename, result.blob);
    expect(button().disabled).toBe(false);
    expect(page.textContent).toContain("Download started");
  });

  it("announces generation and download errors and allows retry", async () => {
    mocks.create.mockRejectedValueOnce(new Error("conversion failed")).mockResolvedValue(result);
    button().click();
    await settle();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    expect(button().disabled).toBe(false);
    mocks.download.mockImplementationOnce(() => {
      throw new Error("download failed");
    });
    button().click();
    await settle();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    button().click();
    await settle();
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.textContent).toContain("Download started");
  });

  it("aborts on navigation and does not let stale completion overwrite a new export", async () => {
    const old = createDeferredCore<typeof result>();
    const current = createDeferredCore<typeof result>();
    mocks.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    button().click();
    await settle();
    const [, signal, progress] = mocks.create.mock.calls[0]!;
    page.remove();
    expect(signal.aborted).toBe(true);
    document.body.append(page);
    await page.updateComplete;
    button().click();
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
