/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { nothing, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings, patchSettings, saveSettings } from "../../app/settings.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import {
  openSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  SIDEBAR_NARROW_BREAKPOINT_PX,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

const card: ProgressCard = {
  sessionKey: "agent:main:progress-placement",
  revision: 1,
  updatedAt: 1_800_000_000_000,
  markdown: "Verifying the implementation",
};

function fixture() {
  const request = vi.fn().mockResolvedValue({});
  const { pane, state, context } = createRefreshChatPane(
    createGatewayBrowserClientFixture({ request }),
  );
  pane.sessionKey = state.sessionKey = card.sessionKey;
  state.settings = {
    ...state.settings,
    chatShowTaskProgress: true,
    chatTaskProgressSidePanel: true,
  };
  // The retained controller is covered by progress-history tests. Exercise its
  // presentation at the actual pane render entry, including composer loading.
  Object.defineProperties(pane, {
    progressCardPresentation: {
      configurable: true,
      get: () => ({ card, identity: card.sessionKey }),
    },
    progressCardInitialLoading: { configurable: true, get: () => true },
  });
  Object.assign(pane, { paneWidth: 1200 });
  return { pane, state, request, context };
}

const slots: SidebarSlotId[] = [
  "browser",
  "terminal",
  "desktop",
  "workspace",
  "detail",
  "companion",
  "discussion",
  "portal",
  "link-reader",
  "plugin:fixture/inspector",
];

const promoted = openSlot({ columns: [] }, "workspace");
const workspaceId = promoted.columns[0]!.panels.find((panel) => panel.slot === "workspace")!.id;
const cases: Array<{ name: string; layout: SidebarLayout }> = [
  ...slots.map((slot) => ({ name: slot, layout: openSlot({ columns: [] }, slot) })),
  { name: "empty selector", layout: setSidebarOpen({ columns: [] }, true) },
  { name: "focused conversation", layout: { columns: [], expanded: true } },
  {
    name: "non-conversation main",
    layout: setSidebarOpen(promoteSidebarPanel(promoted, workspaceId), false),
  },
];

describe("chat pane task progress placement", () => {
  it.each(cases)("gives $name priority over progress at both widths", ({ layout }) => {
    const { pane, state } = fixture();
    state.sidebarLayout = layout;
    for (const paneWidth of [1200, SIDEBAR_NARROW_BREAKPOINT_PX - 1]) {
      Object.assign(pane, { paneWidth });
      pane.render();
      expect(pane.chatProps?.progressCard).toBeNull();
      expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
      expect(pane.sideFallback).toBe(nothing);
      expect(state.sidebarLayout).toBe(layout);
    }
  });

  it("shows initial read feedback without opening an empty side panel or covering another panel", () => {
    const { pane, state } = fixture();
    let loaded = false;
    Object.defineProperty(pane, "progressCardPresentation", {
      get: () => (loaded ? { card, identity: card.sessionKey } : null),
    });
    pane.render();
    expect(pane.chatProps?.progressCardInitialLoading).toBe(true);
    expect(pane.sideFallback).toBe(nothing);
    state.sidebarLayout = openSlot({ columns: [] }, "browser");
    pane.render();
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
    state.sidebarLayout = setSidebarOpen(state.sidebarLayout, false);
    loaded = true;
    pane.render();
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
    expect(pane.sideFallback).not.toBe(nothing);
  });

  it("uses the board-resolved presentation without changing the saved layout", () => {
    const { pane, state, context } = fixture();
    context.gateway.snapshot.hello = gatewayHelloForMethods(["board.get"]);
    Object.assign(pane, { routeFace: "dashboard" });
    const saved = state.sidebarLayout;
    expect(saved.columns).toEqual([]);
    pane.render();
    expect(pane.renderedSidebarLayout?.open).toBe(true);
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
    expect(pane.sideFallback).toBe(nothing);
    expect(state.sidebarLayout).toBe(saved);
    expect(saved.columns).toEqual([]);
  });

  it("uses one side surface, returns to the composer when narrow, and leaves closed tabs intact", () => {
    const { pane, state } = fixture();
    const layout = setSidebarOpen(openSlot({ columns: [] }, "browser"), false);
    state.sidebarLayout = layout;
    const saved = structuredClone(layout);
    pane.render();
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
    expect(pane.sideFallback).not.toBe(nothing);
    expect(state.sidebarLayout).toEqual(saved);

    Object.assign(pane, { paneWidth: SIDEBAR_NARROW_BREAKPOINT_PX - 1 });
    pane.render();
    expect(pane.chatProps?.progressCard).toBe(card);
    expect(pane.sideFallback).toBe(nothing);

    Object.assign(pane, { paneWidth: 1200, compact: true });
    pane.render();
    expect(pane.chatProps?.progressCard).toBe(card);
    expect(pane.sideFallback).toBe(nothing);
  });

  it("keeps the default composer behavior with an open panel and suppresses disabled loading", () => {
    const { pane, state } = fixture();
    state.settings.chatTaskProgressSidePanel = false;
    state.sidebarLayout = openSlot({ columns: [] }, "browser");
    pane.render();
    expect(pane.chatProps?.progressCard).toBe(card);
    expect(pane.sideFallback).toBe(nothing);
    state.settings.chatShowTaskProgress = false;
    pane.render();
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
  });

  it("closes locally without clearing progress or changing the saved panel layout", () => {
    const { pane, state, request } = fixture();
    const previous = loadSettings();
    const mount = document.body.appendChild(document.createElement("div"));
    onTestFinished(() => {
      render(nothing, mount);
      mount.remove();
      saveSettings(previous);
    });
    state.settings = patchSettings({
      chatShowTaskProgress: true,
      chatTaskProgressSidePanel: true,
      chatCollapseTaskProgress: true,
    });
    const layout = state.sidebarLayout;
    const requestUpdate = vi.spyOn(state, "requestUpdate");
    pane.render();
    render(pane.sideFallback, mount);
    const close = mount.querySelector<HTMLButtonElement>('button[aria-label="Hide task progress"]');
    expect(mount.querySelector('[data-progress-card-placement="side"]')).not.toBeNull();
    expect(close).not.toBeNull();
    close!.click();
    expect(loadSettings()).toMatchObject({
      chatShowTaskProgress: false,
      chatTaskProgressSidePanel: true,
      chatCollapseTaskProgress: true,
    });
    expect(state.sidebarLayout).toBe(layout);
    expect(requestUpdate).toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "progressCard.put")).toEqual([]);
    pane.render();
    expect(pane.sideFallback).toBe(nothing);
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
  });
});
