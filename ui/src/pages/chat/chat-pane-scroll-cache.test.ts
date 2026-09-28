/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { stubAnimationFrames } from "./chat-view.test-helpers.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest<HTMLElement>(".chat-virtual-row");
    const thread = this.closest<HTMLElement>(".chat-thread");
    const top = row ? Number(row.dataset.index) * 100 - (thread?.scrollTop ?? 0) : 0;
    const height = row ? 100 : 600;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + height,
      width: 800,
      height,
      toJSON: () => ({}),
    };
  });
});
afterEach(resetTranscriptTestDom);

async function mountSession(paneId: string, sessionKey: string, viewportHeight = 600) {
  const flushFrames = stubAnimationFrames();
  const { pane, state } = createRefreshChatPane();
  pane.paneId = paneId;
  pane.presentationId = JSON.stringify([paneId, sessionKey]);
  state.sessionKey = sessionKey;
  state.chatMessages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}`,
    __openclaw: { id: `${sessionKey}:${index}` },
  }));
  pane.render();
  const props = expectDefined(pane.chatProps, "pane transcript props");
  const container = document.body.appendChild(document.createElement("div"));
  props.transcript.hostConnected();
  render(renderChatThread(props, props.transcript), container);
  const thread = expectDefined(container.querySelector<HTMLDivElement>(".chat-thread"), "thread");
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: viewportHeight },
    scrollHeight: { configurable: true, value: 3_000 },
  });
  // initialize() omits connectedCallback's viewport binding; use its real owner contract.
  state.chatScrollElement = () => props.transcript.scrollElement;
  state.chatIsProgrammaticScroll = () => props.transcript.isProgrammaticScroll;
  state.chatIsMaintenanceScroll = () => props.transcript.isMaintenanceScroll;
  state.chatCancelScroll = () => props.transcript.cancelScroll();
  thread.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      thread.scrollTop = Math.min(
        options.top ?? thread.scrollTop,
        thread.scrollHeight - thread.clientHeight,
      );
    }
  };
  for (let frame = 0; frame < 6; frame++) {
    props.transcript.hostUpdated();
    await Promise.resolve();
    await Promise.resolve();
    flushFrames();
    render(renderChatThread(props, props.transcript), container);
  }
  return {
    pane,
    state,
    transcript: props.transcript,
    thread,
    dispose: () => {
      pane.presented = false;
      props.transcript.hostUpdate();
      props.transcript.hostDisconnected();
      render(nothing, container);
      container.remove();
    },
  };
}

it("restores each physical pane's reader after visiting nine retained sessions", async () => {
  const firstSession = "agent:main:scroll-cache-0";
  const positions = [
    { paneId: "scroll-main", offset: 420 },
    { paneId: "scroll-detail", offset: 840 },
  ];
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    thread.scrollTop = offset;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    expect(thread.scrollTop).toBe(offset);
    dispose();
  }
  for (let index = 1; index < 9; index++) {
    const { thread, dispose } = await mountSession(
      "scroll-main",
      `agent:main:scroll-cache-${index}`,
    );
    thread.scrollTop = 200;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    expect.soft(thread.scrollTop).toBe(offset);
    dispose();
  }
});

it("restores explicit reader intent when a larger returning viewport clamps its bookmark to the end", async () => {
  const paneId = "clamped-bookmark";
  const sessionKey = "agent:main:clamped-bookmark";
  const first = await mountSession(paneId, sessionKey);
  first.thread.scrollTop = 840;
  first.thread.dispatchEvent(new Event("scroll"));
  first.pane.presented = false;
  first.transcript.hostUpdate();
  first.dispose();
  const returned = await mountSession(paneId, sessionKey, 2400);
  try {
    expect(returned.thread.scrollTop).toBe(600);
    expect(returned.state.chatFollowLocked).toBe(true);
    expect(returned.state.chatReadingHistory).toBe(true);
    // A delayed native event for restoration must not be mistaken for a user return.
    returned.thread.dispatchEvent(new Event("scroll"));
    expect(returned.state.chatFollowLocked).toBe(true);
    Object.defineProperty(returned.thread, "scrollHeight", { configurable: true, value: 3200 });
    expect(returned.transcript.scrollToEnd({ source: "auto" })).toBe(false);
    expect(returned.thread.scrollTop).toBe(600);
    returned.thread.scrollTop = 800;
    returned.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    expect(returned.state.chatFollowLocked).toBe(false);
  } finally {
    returned.dispose();
  }
});
