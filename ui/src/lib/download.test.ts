import { afterEach, expect, it, vi } from "vitest";
import { downloadBlobFile } from "./download.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([false, true])("releases the URL after download dispatch (failure: %s)", (fails) => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn(() => "blob:test-download");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.download).toBe("sheet.pdf");
    expect(this.href).toBe("blob:test-download");
    if (fails) {
      throw new Error("dispatch failed");
    }
  });
  const blob = new Blob(["pdf"], { type: "application/pdf" });
  if (fails) {
    expect(() => downloadBlobFile("sheet.pdf", blob)).toThrow("dispatch failed");
  } else {
    downloadBlobFile("sheet.pdf", blob);
  }
  expect(createObjectURL).toHaveBeenCalledWith(blob);
  expect(click).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:test-download");
});
