/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  getChatSessionScrollPosition,
  saveChatSessionScrollPosition,
  handleChatScroll,
  handleChatScrollTakeover,
  restoreChatScrollPosition,
} from "../scroll.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import type { TestContentRow } from "./chat-transcript.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function fixture(
  paneId: string,
  options: { saved?: boolean; ready?: boolean; omitMessage?: number } = {},
) {
  const flushFrames = stubAnimationFrames();
  const sessionKey = `agent:main:${paneId}`;
  const container = document.body.appendChild(document.createElement("div"));
  let presented = true;
  const policy = makeChatHost();
  let ready = options.ready ?? true;
  let height = 400;
  let requested = true;
  let scrollTop = 0;
  const heights = Array.from({ length: 80 }, (_, index) => 80 + (index % 5) * 45);
  let rows: TestContentRow[] = heights.map((_, index) => ({
    kind: "content",
    key: `row:${index}`,
    content: html`<div class="chat-bubble" data-message-id=${`message:${index}`}>
      Message ${index}
    </div>`,
  }));
  const allRows = rows;
  rows = rows.filter((row) => row.key !== `row:${options.omitMessage}`);
  const maxOffset = () => Math.max(0, container.scrollHeight - height);
  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: {
      configurable: true,
      get: () =>
        Number.parseFloat(
          container.querySelector<HTMLElement>(".chat-thread-inner--virtual")?.style.height ?? "0",
        ) || 0,
    },
    scrollTop: {
      configurable: true,
      get: () => Math.min(scrollTop, maxOffset()),
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, maxOffset()));
      },
    },
  });
  container.scrollTo = (scrollOptions?: ScrollToOptions | number) => {
    if (typeof scrollOptions === "object") {
      container.scrollTop = scrollOptions.top ?? container.scrollTop;
    }
  };
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("chat-virtual-row")
      ? (heights[Number(this.dataset.index)] ?? 100)
      : height;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest<HTMLElement>(".chat-virtual-row");
    let top = 0;
    if (row) {
      top =
        (Number.parseFloat(row.parentElement!.style.transform.replace("translateY(", "")) || 0) -
        container.scrollTop;
      for (
        let sibling = row.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      ) {
        top +=
          sibling instanceof HTMLElement
            ? sibling.classList.contains("chat-virtual-row")
              ? sibling.offsetHeight
              : Number.parseFloat(sibling.style.height) || 0
            : 0;
      }
    }
    const blockSize = row ? heights[Number(row.dataset.index)]! : height;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + blockSize,
      width: 800,
      height: blockSize,
      toJSON: () => ({}),
    };
  });
  if (!options.saved) {
    saveChatSessionScrollPosition(paneId, sessionKey, { scrollTop: 0, anchorToEnd: false });
  }
  const onReaderScroll = vi.fn((towardEnd?: boolean) => {
    handleChatScrollTakeover(policy, towardEnd);
  });
  const transcript = new ChatTranscriptController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: () => {
        requested = true;
      },
      updateComplete: Promise.resolve(true),
    },
    () => paneId,
    {
      visuallyPresented: () => presented,
      canFollowEnd: () => !policy.chatFollowLocked,
      onReaderScroll,
      onPositionRestored: (position) => restoreChatScrollPosition(policy, position),
    },
  );
  policy.chatScrollElement = () => transcript.scrollElement;
  policy.chatIsProgrammaticScroll = () => transcript.isProgrammaticScroll;
  policy.chatIsMaintenanceScroll = () => transcript.isMaintenanceScroll;
  container.addEventListener("scroll", (event) => handleChatScroll(policy, event));
  function commit() {
    requested = false;
    transcript.hostUpdate();
    render(
      transcript.renderSession(sessionKey, (session) => {
        session.setContentReady(ready);
        const messages = new Map(rows.map((row) => [row.key.replace("row:", "message:"), row.key]));
        session.syncMessageRows(messages, messages);
        return session.render(
          rows,
          (row) => (row.kind === "content" ? row.content : nothing),
          null,
          false,
        );
      }),
      container,
    );
    transcript.hostUpdated();
  }
  async function frames(count = 8) {
    for (let frame = 0; frame < count; frame++) {
      await Promise.resolve();
      await Promise.resolve();
      if (requested) {
        commit();
      }
      // Browser-delivered maintenance offsets retire their receipts after native delivery.
      container.dispatchEvent(new Event("scroll"));
      flushFrames();
    }
  }
  transcript.hostConnected();
  commit();
  return {
    container,
    transcript,
    sessionKey,
    onReaderScroll,
    frames,
    heights,
    allRows,
    get following() {
      return !policy.chatFollowLocked;
    },
    setReady(value: boolean) {
      ready = value;
      requested = true;
    },
    setRows(value: TestContentRow[]) {
      rows = value;
      requested = true;
    },
    setPresented(value: boolean) {
      presented = value;
      transcript.hostUpdate();
    },
    setHeight(value: number) {
      height = value;
      scrollTop = Math.max(0, Math.min(scrollTop, maxOffset()));
    },
    commit,
    readAt(offset: number) {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      container.scrollTop = offset;
      container.dispatchEvent(new Event("scroll"));
    },
    save() {
      transcript.saveScrollPosition(true);
      return getChatSessionScrollPosition(paneId, sessionKey)!;
    },
    dispose() {
      transcript.hostDisconnected();
      render(nothing, container);
      container.remove();
    },
  };
}

it("restores the same bubble after eviction discards variable-height row measurements", async () => {
  const first = fixture("evicted-reader");
  await first.frames();
  first.readAt(4500);
  await first.frames();
  const nativeGeometryReads = vi.spyOn(first.container, "querySelectorAll");
  first.transcript.saveScrollPosition();
  expect(nativeGeometryReads).not.toHaveBeenCalled();
  const before = first.save();
  expect(before.messageAnchor).toBeDefined();
  first.dispose();

  const returned = fixture("evicted-reader", { saved: true });
  try {
    await returned.frames();
    const bubble = [...returned.container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
      (node) => node.dataset.messageId === before.messageAnchor!.messageKey,
    )!;
    expect(bubble).toBeDefined();
    expect(bubble.getBoundingClientRect().top).toBeCloseTo(before.messageAnchor!.offset, 0);
    // Old absolute pixels are not a bookmark when unmounted rows have new estimates.
    expect(returned.container.scrollTop).not.toBe(before.scrollTop);
    expect(returned.transcript.isProgrammaticScroll).toBe(false);
    returned.readAt(returned.container.scrollTop - 90);
    const takenOver = returned.container.scrollTop;
    await returned.frames();
    expect(returned.container.scrollTop).toBe(takenOver);
  } finally {
    returned.dispose();
  }
});

it.each([false, true])(
  "holds hidden presentation geometry without changing follow intent, following=%s",
  async (following) => {
    const view = fixture(`hidden-reader-${following}`);
    try {
      await view.frames();
      view.readAt(view.container.scrollHeight - 400 - 180);
      await view.frames();
      if (following) {
        view.transcript.scrollToEnd({ behavior: "auto" });
        view.container.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
      }
      const before = view.save();
      view.setPresented(false);
      // The progress card disappears after hostUpdate, enlarging the viewport and clamping it.
      view.setHeight(740);
      view.container.dispatchEvent(new Event("scroll"));
      view.transcript.saveScrollPosition();
      view.commit();
      await view.frames();
      expect(getChatSessionScrollPosition(`hidden-reader-${following}`, view.sessionKey)).toEqual(
        before,
      );
      view.setPresented(true);
      view.setHeight(400);
      view.commit();
      await view.frames();
      if (following) {
        expect(view.container.scrollTop).toBeCloseTo(view.container.scrollHeight - 400, 0);
      } else {
        const bubble = [...view.container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
          (node) => node.dataset.messageId === before.messageAnchor!.messageKey,
        )!;
        expect(bubble.getBoundingClientRect().top).toBeCloseTo(before.messageAnchor!.offset, 0);
      }
      expect(view.following).toBe(following);
    } finally {
      view.dispose();
    }
  },
);

it.each(["arrives", "deleted", "reader takeover"] as const)(
  "keeps a preload bookmark until its message %s",
  async (outcome) => {
    const paneId = "preload-" + outcome;
    const position = {
      scrollTop: 420,
      anchorToEnd: false,
      messageAnchor: { messageKey: "message:40", offset: -20 },
    };
    saveChatSessionScrollPosition(paneId, "agent:main:" + paneId, position);
    const view = fixture(paneId, { saved: true, ready: false, omitMessage: 40 });
    try {
      await view.frames();
      expect(view.onReaderScroll).not.toHaveBeenCalled();
      expect(getChatSessionScrollPosition(paneId, view.sessionKey)).toEqual(position);
      if (outcome === "reader takeover") {
        view.readAt(200);
      }
      const takenOver = view.container.scrollTop;
      if (outcome !== "deleted") {
        view.setRows(view.allRows);
      }
      view.setReady(true);
      view.commit();
      await view.frames();
      expect(view.transcript.isProgrammaticScroll).toBe(false);
      if (outcome === "arrives") {
        const bubble = view.container.querySelector<HTMLElement>('[data-message-id="message:40"]')!;
        expect(bubble.getBoundingClientRect().top).toBeCloseTo(-20, 0);
      } else if (outcome === "deleted") {
        expect(getChatSessionScrollPosition(paneId, view.sessionKey)).toEqual({
          scrollTop: 420,
          anchorToEnd: false,
        });
      } else {
        expect(view.container.scrollTop).toBe(takenOver);
      }
    } finally {
      view.dispose();
    }
  },
);
