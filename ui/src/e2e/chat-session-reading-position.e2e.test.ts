import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session reading position" });
const sessions = ["reader-a", "reader-b", "reader-c", "reader-d"].map((name, index) => ({
  key: "agent:main:" + name,
  sessionId: name + ":backing",
  kind: "direct",
  label: "Reading session " + String.fromCharCode(65 + index),
  updatedAt: 100 - index,
}));
const first = sessions[0]!.key;
const second = sessions[1]!.key;
function history(key: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content:
      "Checkpoint " +
      index +
      ". " +
      "Reading position must remain stable. ".repeat(2 + (index % 9)) +
      "\n\n" +
      "Additional details and evidence.\n".repeat(index % 5),
    timestamp: 1_000 + index,
    __openclaw: { id: key + ":message:" + index, seq: index + 1 },
  }));
}
const thread = (page: Page) => page.locator(".chat-pane-cache__pane--active .chat-thread");
async function selectSession(page: Page, key: string) {
  await page
    .locator(
      '.sidebar-recent-session[data-session-key="' + key + '"] a.sidebar-recent-session__link',
    )
    .click();
  await expect
    .poll(() =>
      page
        .locator(".chat-pane-cache__pane--active")
        .evaluate((pane: HTMLElement & { sessionKey: string }) => pane.sessionKey),
    )
    .toBe(key);
  await waitForChatScrollIdle(page);
}
async function visibleReader(viewport: Locator) {
  return viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const bubble = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]")].find(
      (candidate) =>
        candidate.getBoundingClientRect().bottom > top &&
        candidate.getBoundingClientRect().top < element.getBoundingClientRect().bottom,
    );
    if (!bubble?.dataset.entryId) {
      throw new Error("Expected a visible persisted message");
    }
    return { id: bubble.dataset.entryId, offset: bubble.getBoundingClientRect().top - top };
  });
}
async function expectReader(viewport: Locator, reader: Awaited<ReturnType<typeof visibleReader>>) {
  const offset = await viewport.evaluate((element, id) => {
    const bubble = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]")].find(
      (candidate) => candidate.dataset.entryId === id,
    );
    return bubble ? bubble.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
  }, reader.id);
  expect(offset, "the same message stays mounted at the reading point").not.toBeNull();
  expect(
    Math.abs(offset! - reader.offset),
    "the same message retains its viewport offset",
  ).toBeLessThanOrEqual(2);
}
async function readHistory(page: Page, position: "middle" | "near-end") {
  const viewport = thread(page);
  const delta = await viewport.evaluate((element, where) => {
    const max = element.scrollHeight - element.clientHeight;
    return (where === "middle" ? max * 0.43 : max - 180) - element.scrollTop;
  }, position);
  await viewport.hover({ position: { x: 40, y: 120 } });
  await page.mouse.wheel(0, delta);
  await waitForChatScrollIdle(page);
  expect(
    await viewport.evaluate(
      (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
    ),
  ).toBeGreaterThan(8);
  return visibleReader(viewport);
}
async function withSessions(
  run: (page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) => Promise<void>,
) {
  await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
    const gateway = await installMockGateway(page, {
      sessionKey: first,
      sessions,
      sessionTranscripts: Object.fromEntries(
        sessions.map(({ key }, index) => [
          key,
          {
            messages: history(key, index === 0 ? 180 : 25),
          },
        ]),
      ),
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, first));
    await page.getByText("Checkpoint 179.", { exact: false }).waitFor();
    await waitForChatScrollIdle(page);
    await run(page, gateway);
  });
}

suite.define(() => {
  // Fixed scrollHeight mocks cannot exercise fresh virtual row estimates after eviction.
  for (const position of ["middle", "near-end"] as const) {
    it("preserves the reader after an evicted pane is rebuilt: " + position, async () => {
      await withSessions(async (page) => {
        const viewport = thread(page);
        const original = await viewport.elementHandle();
        const reader = await readHistory(page, position);
        for (const session of sessions.slice(1)) {
          await selectSession(page, session.key);
        }
        expect(await original!.evaluate((element) => element.isConnected)).toBe(false);
        await selectSession(page, first);
        await expectReader(viewport, reader);

        // A new reader gesture must replace the restored bookmark, not replay it.
        await viewport.hover({ position: { x: 40, y: 120 } });
        await page.mouse.wheel(0, -300);
        await waitForChatScrollIdle(page);
        const movedReader = await visibleReader(viewport);
        expect(movedReader).not.toEqual(reader);
        await selectSession(page, second);
        await selectSession(page, first);
        await expectReader(viewport, movedReader);
      });
    });
  }

  it("preserves a reader above the end while a hidden progress card changes the viewport", async () => {
    await withSessions(async (page, gateway) => {
      await gateway.setMethodResponse("progressCard.get", {
        cases: [
          {
            match: { sessionKey: first },
            response: {
              card: {
                sessionKey: first,
                revision: 1,
                updatedAt: 1_000,
                markdown:
                  "Reviewing the session.\n\n" +
                  "- Verify another result and its evidence.\n".repeat(25),
                steps: [{ step: "Verify reading position", status: "in_progress" }],
              },
            },
          },
          { match: { sessionKey: second }, response: { card: null } },
        ],
      });
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey: first, revision: 1 });
      const card = page.locator(
        '.chat-pane-cache__pane--active [data-progress-card-placement="composer"]',
      );
      await card.waitFor();
      if ((await card.getAttribute("open")) === null) {
        await card.locator("summary").click();
      }
      await card.locator(".session-progress-card__body").waitFor({ state: "visible" });
      await waitForChatScrollIdle(page);
      const viewport = thread(page);
      const original = await viewport.elementHandle();
      const reader = await readHistory(page, "near-end");
      expect(await card.getAttribute("open")).not.toBeNull();
      await selectSession(page, second);
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
      await selectSession(page, first);
      expect(await card.getAttribute("open")).not.toBeNull();
      await expectReader(viewport, reader);

      // Choosing latest still changes intent; it must not restore the earlier reader.
      await page.getByRole("button", { name: "Scroll to latest" }).click();
      await waitForChatScrollIdle(page);
      await selectSession(page, second);
      await selectSession(page, first);
      expect(
        await viewport.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      ).toBeLessThanOrEqual(8);
    });
  });
});
