import { expect, it, vi } from "vitest";
import { renderConfigView } from "./config-view.test-support.ts";

it("renders the external-link preference off by default and applies a personal change", () => {
  const setOpenLinksExternally = vi.fn();
  const { container } = renderConfigView({
    activeSection: "__appearance__",
    includeSections: ["__appearance__"],
    setOpenLinksExternally,
  });
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) =>
      candidate.querySelector(".settings-row__title")?.textContent?.trim() ===
      "Open links in external browser",
  );
  const toggle = row?.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  expect(toggle?.checked).toBe(false);
  expect(row?.textContent).toContain("Stored in this browser only");
  row?.click();
  expect(setOpenLinksExternally).toHaveBeenCalledWith(true);
});
