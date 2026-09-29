import { nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { ChatSavedInputs } from "./chat-saved-inputs.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";
import { renderSavedInputDetails } from "./components/chat-saved-input-details.ts";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/chat.ts";
import "../../styles/chat/composer-surface.css";

const container = document.createElement("div");
afterEach(() => {
  render(nothing, container);
  container.remove();
  container.removeAttribute("style");
  vi.restoreAllMocks();
});
it("copies saved content through the real hit target without mounting forwarded actions", async () => {
  document.body.append(container);
  container.className = "agent-chat__composer-shell";
  container.style.width = "600px";
  const input = {
    id: "saved",
    acceptedAt: 1,
    state: "interrupted",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Complete saved content" },
        {
          type: "clawhub",
          kind: "plugin",
          id: "ch_fixture",
          name: "Saved recommendation",
          official: true,
          installed: false,
        },
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_saved",
            url: "/__openclaw__/canvas/documents/cv_saved/index.html",
            title: "Saved widget",
            sandbox: "scripts",
            mcpApp: {
              viewId: "cv_saved",
              serverName: "fixture",
              toolName: "show",
              uiResourceUri: "ui://fixture/app.html",
              toolCallId: "saved-call",
            },
          },
        },
      ],
    },
  } as const;
  const saved: ChatSavedInputs = {
    items: [input],
    inspections: new Map([[input.id, { source: input }]]),
    onToggle: async () => {},
    error: undefined,
    loading: false,
    earlier: false,
    latest: false,
    canRead: true,
    onPage: () => {},
  };
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    renderChatQueue({
      queue: [],
      savedInputs: saved,
      renderSavedInput: (row) =>
        renderSavedInputDetails(row, undefined, createChatProps(), () => {}),
      onQueueRemove: () => {},
    }),
    container,
  );
  expect(
    container.querySelectorAll(
      "openclaw-chat-clawhub-card, iframe, .chat-tool-card__widget-host, .chat-clawhub-card button, .chat-clawhub-card a",
    ),
  ).toHaveLength(0);
  await expect.element(page.getByText("Saved recommendation", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy as markdown", exact: true }).click();
  expect(write).toHaveBeenCalledExactlyOnceWith("Complete saved content");
});

it.each(["Send", "Discard"])(
  "does not retarget click two after a saved %s removes its row",
  async (label) => {
    document.body.append(container);
    container.className = "agent-chat__composer-shell";
    container.style.cssText = "position:fixed;bottom:20px;left:20px;width:600px";
    let items = ["first", "second"].map((id) => ({
      id,
      acceptedAt: 1,
      state: "interrupted" as const,
      message: { role: "user", content: "Saved " + id },
    }));
    const action = vi.fn((input: ChatSavedInputs["items"][number]) => {
      items = items.filter((item) => item.id !== input.id);
      draw();
    });
    const draw = () => {
      const saved: ChatSavedInputs = {
        items,
        inspections: new Map(items.map((input) => [input.id, { source: input }])),
        onToggle: async () => {},
        error: undefined,
        loading: false,
        earlier: false,
        latest: false,
        canRead: true,
        onPage: () => {},
        actions: {
          items,
          busyIds: new Set(),
          error: undefined,
          canSend: true,
          onSend: async (input) => {
            action(input);
          },
          onDiscard: action,
        },
      };
      render(
        renderChatQueue({
          queue: [],
          savedInputs: saved,
          renderSavedInput: (row) =>
            renderSavedInputDetails(row, undefined, createChatProps(), () => {}),
          onQueueRemove: () => {},
        }),
        container,
      );
    };
    draw();
    const original = [
      ...container.querySelectorAll<HTMLButtonElement>(".chat-queue__saved-actions button"),
    ].findLast((button) => button.textContent?.trim() === label)!;
    const box = original.getBoundingClientRect();
    const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    await page.getByRole("button", { name: label, exact: true }).nth(1).click();
    expect(items.map((item) => item.id)).toEqual(["first"]);
    const target = document.elementFromPoint(point.x, point.y)?.closest("button");
    expect(target?.closest("[data-chat-saved-input]")?.getAttribute("data-chat-saved-input")).toBe(
      "first",
    );
    expect(target?.textContent?.trim()).toBe(label);
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(items.map((item) => item.id)).toEqual(["first"]);
  },
);
