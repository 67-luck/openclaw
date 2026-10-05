/** @internal Awaited publishers retain the navigation owner's completed selection. */
export const sessionManagerNavigate: unique symbol = Symbol.for(
  "openclaw.session-manager.navigate",
);
