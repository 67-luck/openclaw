import { resolveBrowserNavigationProxyMode } from "./browser-proxy-mode.js";
import {
  isLocalManagedProfile,
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
} from "./config.js";
import { withBrowserNavigationPolicy } from "./navigation-guard.js";
import { getBrowserRequestScope } from "./request-scope.js";

/** Resolve page policy without widening the stored config or CDP endpoint policy. */
export function resolveBrowserNavigationPolicy(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
) {
  const allowLocalLoopback =
    getBrowserRequestScope()?.allowLocalLoopback === true &&
    resolved.ssrfPolicyConfigured === false &&
    isLocalManagedProfile(profile);
  return withBrowserNavigationPolicy(
    allowLocalLoopback
      ? { ...resolved.ssrfPolicy, allowedHostnames: ["localhost", "127.0.0.1", "::1"] }
      : resolved.ssrfPolicy,
    { browserProxyMode: resolveBrowserNavigationProxyMode({ resolved, profile }) },
  );
}
