import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function registerParallelBatchOutcomeTest(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  captureToolActivityProof: (page: Page, name: string) => Promise<void>,
  getArtifactDir: () => string | undefined,
) {
  it("pairs a canonical parallel batch and renders per-file patch sections", async () => {
    const artifactDir = getArtifactDir();
    const context = await suite.browser.newContext({
      locale: "en-US",
      viewport: { height: 900, width: 1200 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1200 } } }
        : {}),
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "/repo/src/a.ts", offset: 3, limit: 20 },
            },
            {
              type: "toolCall",
              id: "call-patch",
              name: "apply_patch",
              arguments: {
                input: [
                  "*** Begin Patch",
                  "*** Update File: src/a.ts",
                  "@@",
                  "-const before = true;",
                  "+const after = true;",
                  "*** Add File: src/b.ts",
                  "+export const created = true;",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
          activity: [
            {
              itemId: "tool:call-read",
              toolCallId: "call-read",
              kind: "tool",
              phase: "end",
              status: "completed",
              title: "Read source",
            },
            {
              itemId: "tool:call-patch",
              toolCallId: "call-patch",
              kind: "tool",
              phase: "end",
              status: "completed",
              title: "Apply patch",
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: "A_ONLY_fixture" }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-patch",
          toolName: "apply_patch",
          content: [{ type: "text", text: "Applied patch" }],
          timestamp: 3,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const activity = page.locator(".chat-group--activity .chat-activity-group__summary");
    await activity.waitFor();
    expect(await activity.textContent()).toContain("2 other operations");
    const activityGeometry = await activity.evaluate((node) => {
      const container = node.closest<HTMLElement>(".chat-activity-group");
      const label = node.querySelector<HTMLElement>(".chat-activity-group__label");
      const chevron = node.querySelector<HTMLElement>(".chat-tool-row__chevron");
      if (!container || !label || !chevron) {
        throw new Error("Expected compact activity disclosure parts");
      }
      const containerRect = container.getBoundingClientRect();
      const summaryRect = node.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const chevronRect = chevron.getBoundingClientRect();
      return {
        containerWidth: containerRect.width,
        summaryWidth: summaryRect.width,
        chevronGap: chevronRect.left - labelRect.right,
      };
    });
    expect(activityGeometry.summaryWidth).toBeLessThan(activityGeometry.containerWidth);
    expect(activityGeometry.chevronGap).toBeLessThanOrEqual(8);
    await activity.hover();
    expect(await activity.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    if ((await activity.getAttribute("aria-expanded")) !== "true") {
      await activity.click();
    }
    await activity.locator("..").locator(".chat-activity-group__body").waitFor();

    const rows = page.locator(".chat-activity-group__body .chat-tool-msg-summary");
    expect(await rows.count()).toBe(2);
    expect(await rows.locator(".chat-tool-row__chevron").count()).toBe(2);
    expect(await page.locator(".chat-tool-msg-summary__label", { hasText: "Tool" }).count()).toBe(
      0,
    );
    // File rows put the workspace link inside the row, so toggle from the icon
    // edge instead of the row centre to avoid opening the linked file.
    await rows.first().click({ position: { x: 4, y: 4 } });
    await rows.first().locator("..").locator(".chat-tool-msg-body").waitFor();
    expect(await page.getByText("offset:", { exact: true }).count()).toBe(1);
    expect(await page.getByText("limit:", { exact: true }).count()).toBe(1);
    const patchRow = rows.filter({ hasText: "2 files" });
    await patchRow.click();
    await patchRow.locator("..").locator(".chat-tool-msg-body").waitFor();

    expect(await page.locator(".chat-diff__row--file .chat-diff__text").allTextContents()).toEqual([
      "Update src/a.ts",
      "Add src/b.ts",
    ]);
    expect(await page.locator(".chat-diff__row--del .chat-diff__text").allTextContents()).toContain(
      "const before = true;",
    );
    expect(await page.locator(".chat-diff__row--add .chat-diff__text").allTextContents()).toEqual(
      expect.arrayContaining(["const after = true;", "export const created = true;"]),
    );
    await page.getByRole("tab", { name: "Raw" }).click();
    await page.getByText("Applied patch", { exact: true }).waitFor();
    await captureToolActivityProof(page, "parallel-multifile-expanded");
    await context.close();
  });
}
