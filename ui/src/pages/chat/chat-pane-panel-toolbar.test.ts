/* @vitest-environment jsdom */

import { html, render } from "lit";
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import { openSlot, promoteSidebarPanel, setSidebarOpen } from "./sidebar-layout.ts";

it("keeps main content actions and focus in the task toolbar across plugin panel swaps", () => {
  const { pane, state } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture(),
  });
  const slot = "plugin:fixture/notes";
  const refresh = vi.fn();
  const definitions: SidebarPanelDefinition[] = [
    ...sidebarPanelDefinitions(),
    {
      slot,
      label: "Fixture notes",
      icon: html``,
      available: true,
      content: html`Notes`,
      loading: html`Loading notes`,
      empty: { description: "No notes" },
      headerAction: html`<button aria-label="Refresh notes" @click=${refresh}>
        Refresh notes
      </button>`,
    },
  ];
  state.sidebarLayout = promoteSidebarPanel(openSlot({ columns: [] }, slot), slot);
  const container = document.createElement("div");
  const paint = () =>
    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        { key: state.sessionKey, kind: "direct", updatedAt: 0 },
        false,
        undefined,
        false,
        null,
        state.sidebarLayout,
        definitions,
      ),
      container,
    );
  const action = (label: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

  paint();
  expect(container.querySelectorAll(".chat-pane__header")).toHaveLength(1);
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  expect(action("Swap Fixture notes and Chat")).not.toBeNull();
  action("Refresh notes")!.click();
  expect(refresh).toHaveBeenCalledOnce();
  action("Focus")!.click();
  expect(state.sidebarLayout.expanded).toBe(true);
  state.connected = false;
  paint();
  expect(container.querySelector(".chat-panel-swap")).toBeNull();
  expect(action("Refresh notes")).not.toBeNull();
  expect(action("Restore split")!.matches(":disabled")).toBe(false);
  action("Restore split")!.click();
  expect(state.sidebarLayout.expanded).toBe(false);
  paint();
  expect(action("Swap Fixture notes and Chat")!.matches(":disabled")).toBe(false);
  action("Swap Fixture notes and Chat")!.click();
  paint();
  expect(action("Swap Chat and Fixture notes")).not.toBeNull();
  expect(action("Refresh notes")).toBeNull();

  state.sidebarLayout = setSidebarOpen({ columns: [] }, true);
  paint();
  expect(container.querySelector(".chat-panel-swap")).toBeNull();
  expect(container.querySelectorAll(".chat-side-panel-toggle")).toHaveLength(1);
  container.querySelector<HTMLButtonElement>(".chat-side-panel-toggle")!.click();
  expect(state.sidebarLayout.open).toBe(false);
});

it("focuses and restores progress without opening saved tabs or marking their toggle active", () => {
  const { pane, state } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture(),
  });
  state.sidebarLayout = {
    ...setSidebarOpen(openSlot({ columns: [] }, "browser"), false),
    resourceAutoOpenDismissed: true,
  };
  const saved = structuredClone(state.sidebarLayout);
  const container = document.createElement("div");
  const paint = (sideFallbackVisible: boolean) =>
    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        { key: state.sessionKey, kind: "direct", updatedAt: 0 },
        false,
        undefined,
        false,
        null,
        state.sidebarLayout,
        sidebarPanelDefinitions(),
        sideFallbackVisible,
      ),
      container,
    );
  paint(true);
  const toggle = () => container.querySelector<HTMLButtonElement>(".chat-side-panel-toggle")!;
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".chat-panel-swap")).toBeNull();
  container.querySelector<HTMLButtonElement>(".chat-panel-focus")!.click();
  expect(state.sidebarLayout).toEqual({ ...saved, expanded: true });
  paint(false);
  expect(container.querySelector(".chat-panel-focus")?.getAttribute("aria-pressed")).toBe("true");
  container.querySelector<HTMLButtonElement>(".chat-panel-focus")!.click();
  expect(state.sidebarLayout).toEqual({ ...saved, expanded: false });
  paint(true);
  toggle().click();
  expect(state.sidebarLayout.open).toBe(true);
  expect(state.sidebarLayout.columns[0]?.activePanelId).toBe(saved.columns[0]?.activePanelId);
});
