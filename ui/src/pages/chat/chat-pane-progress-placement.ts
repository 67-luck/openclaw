import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  sidebarMainPanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

/** Presentation only: resource panels retain exclusive ownership of the saved layout. */
export function resolveChatProgressPlacement(params: {
  showProgress: boolean;
  preferSidePanel: boolean;
  layout: SidebarLayout;
  paneWidth: number;
  compact: boolean;
}): "composer" | "side" | "hidden" {
  if (!params.showProgress) {
    return "hidden";
  }
  if (!params.preferSidePanel) {
    return "composer";
  }
  // Explicit panels (even an empty selector), main-panel promotion and focus
  // take priority before responsive fallback to the composer.
  if (
    params.layout.open ||
    params.layout.expanded ||
    (sidebarMainPanel(params.layout)?.slot ?? "conversation") !== "conversation"
  ) {
    return "hidden";
  }
  return params.compact || params.paneWidth < SIDEBAR_NARROW_BREAKPOINT_PX ? "composer" : "side";
}
