import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("shows task progress beside the conversation without replacing another panel", async () => {
    const sessionKey = "agent:main:progress-panel";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1440, height: 1000 } },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "example/demo-model",
          models: [
            { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
          ],
          featureMethods: [
            "browser.request",
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            "progressCard.put",
            "progressCard.refresh",
          ],
          historyMessages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Explain this change in simple terms, with a before and after.",
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: [
                    "The change stops rebuilding unchanged plugins whenever a new runtime is prepared. Instead, the runtime safely reuses the plugins already loaded by the Gateway.",
                    "### Before",
                    "Changing a model setting could trigger repeated work:",
                    "~~~text\nChange setting\n  → Prepare a new runtime\n  → Load separate plugin copies\n  → Inspect dependencies again\n  → Gateway waits while it works\n~~~",
                    "For small plugins, the extra work could go unnoticed. With large dependencies, it became expensive.",
                    "### After",
                    "~~~text\nChange setting\n  → Prepare a new runtime\n  → Check which plugins changed\n  → Reuse unchanged plugins\n  → Keep the Gateway responsive\n~~~",
                    "The remaining shutdown regression is tracked in task progress. The runtime fix is ready, but the change is not merged yet.",
                  ].join("\n\n"),
                },
              ],
            },
          ],
          methodResponses: {
            "browser.request": {
              cases: [
                { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
              ],
            },
            "progressCard.refresh": { runId: "progress-refresh", status: "accepted", revision: 1 },
            "progressCard.get": {
              card: {
                sessionKey,
                revision: 1,
                updatedAt: Date.now(),
                markdown:
                  "**Landing is paused, not merged.** The runtime fix is ready. Closing one Gateway can still interrupt a sibling that is serving requests. Repairing the shared publication boundary before landing.",
                steps: [
                  { step: "Repair and verify the remaining CI fixture", status: "completed" },
                  { step: "Repair the live-sibling shutdown regression", status: "in_progress" },
                  { step: "Verify remote merge and close task resources", status: "pending" },
                ],
              },
            },
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Plugin runtime reuse", updatedAt: 1 },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const card = page.locator('[data-progress-card-placement="composer"]');
        await expect.poll(() => card.isVisible()).toBe(true);
        await expect.poll(() => card.getAttribute("open")).toBe("");
        await page.evaluate(() => document.fonts.ready);
        await captureUiProof(suite, page, "progress-panel", "before.png");
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const savedLayouts = () =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "{}").sidebarSessionLayouts ?? {},
            settingsKey,
          );
        const originalLayouts = await savedLayouts();
        const settingsPage = await context.newPage();
        const settingsGateway = await installMockGateway(settingsPage, { sessionKey });
        await settingsPage.goto(
          suite.server.baseUrl +
            "settings/appearance?section=__appearance__#settings-appearance-chat",
        );
        await waitForControlUiSettingsTakeover(settingsPage);
        const row = (title: string) =>
          settingsPage
            .locator(".settings-row")
            .filter({ has: settingsPage.locator(".settings-row__title", { hasText: title }) })
            .first();
        const sidePreference = row("Show task progress in the side panel");
        await expect
          .poll(() =>
            sidePreference
              .locator("wa-switch")
              .evaluate((element) => Boolean((element as { checked?: boolean }).checked)),
          )
          .toBe(false);
        await sidePreference.click();
        const side = page.locator('[data-progress-card-placement="side"]');
        await expect.poll(() => side.isVisible()).toBe(true);
        expect(await card.count()).toBe(0);
        expect(await page.locator(".agent-chat__progress-float--loading").count()).toBe(0);
        expect(await savedLayouts()).toEqual(originalLayouts);
        await captureUiProof(suite, page, "progress-panel", "after.png");
        await settingsPage
          .locator("#settings-appearance-chat")
          .evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await captureUiProof(suite, settingsPage, "progress-panel", "setting.png");

        await side.getByRole("button", { name: "Refresh task progress", exact: true }).click();
        await expect.poll(() => gateway.getRequests("progressCard.refresh")).toHaveLength(1);
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey,
            revision: 2,
            updatedAt: Date.now(),
            markdown: "The latest shutdown check is in progress.",
            steps: [{ step: "Verify the shutdown boundary", status: "in_progress" }],
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect
          .poll(() => side.textContent())
          .toContain("The latest shutdown check is in progress.");

        await openChatSidePanelType(page, "Browser");
        const browser = page.locator("openclaw-browser-panel");
        await expect.poll(() => browser.isVisible()).toBe(true);
        await expect.poll(() => side.count()).toBe(0);
        expect(await card.count()).toBe(0);
        await captureUiProof(suite, page, "progress-panel", "browser-takes-priority.png");
        const browserIdentity = await browser.elementHandle();
        await page.setViewportSize({ width: 560, height: 900 });
        await expect.poll(() => browser.isVisible()).toBe(true);
        expect(await side.count()).toBe(0);
        expect(await card.count()).toBe(0);
        await page
          .locator('[data-region-header="side"]')
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect.poll(() => card.isVisible()).toBe(true);
        expect(await side.count()).toBe(0);
        await captureUiProof(suite, page, "progress-panel", "narrow-fallback.png");
        await page.setViewportSize({ width: 1440, height: 1000 });
        await expect.poll(() => side.isVisible()).toBe(true);
        expect(await card.count()).toBe(0);
        expect(await browserIdentity?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await browser.isVisible()).toBe(false);
        const closedBrowserLayout = await savedLayouts();
        await captureUiProof(suite, page, "progress-panel", "progress-restored.png");

        await page.getByRole("button", { name: "Hide task progress", exact: true }).click();
        await expect.poll(() => side.count()).toBe(0);
        expect(await card.count()).toBe(0);
        expect(await savedLayouts()).toEqual(closedBrowserLayout);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        await page.reload();
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        expect(await side.count()).toBe(0);
        expect(await card.count()).toBe(0);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        const preferences = await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          settingsKey,
        );
        expect(preferences.chatShowTaskProgress).toBe(false);
        expect(preferences.chatTaskProgressSidePanel).toBe(true);
        await row("Show task progress cards").click();
        await expect.poll(() => side.isVisible()).toBe(true);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await settingsGateway.getRequests("config.patch")).toHaveLength(0);
        await browserIdentity?.dispose();
        await settingsPage.close();
      },
    );
  });
});
