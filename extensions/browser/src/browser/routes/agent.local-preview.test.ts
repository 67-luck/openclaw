import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { assertBrowserNavigationAllowed } from "../navigation-guard.js";
import { withBrowserRequestScope } from "../request-scope.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { browserNavigationPolicyForProfile } from "./agent.shared.js";

describe("local preview navigation policy", () => {
  const scope = {
    managedOnly: true as const,
    assertCurrent: async () => {},
    allowLocalLoopback: true,
  };
  function navigationPolicy(browser?: Parameters<typeof resolveBrowserConfig>[0]) {
    const resolved = resolveBrowserConfig(browser);
    const profile = expectDefined(resolveProfile(resolved, "openclaw"), "managed preview profile");
    const state: BrowserServerState = { port: 0, resolved, profiles: new Map() };
    const ctx = createBrowserRouteContext({ getState: () => state });
    return browserNavigationPolicyForProfile(ctx, ctx.forProfile(profile.name));
  }
  it.each(["http://127.0.0.1:49187/", "http://localhost:49187/", "http://[::1]:49187/"])(
    "allows an unrestricted local managed preview at %s",
    async (url) => {
      await withBrowserRequestScope(scope, async () => {
        await expect(
          assertBrowserNavigationAllowed({ url, ...navigationPolicy() }),
        ).resolves.toBeUndefined();
      });
    },
  );
  it("reports the host and policy without exposing URL secrets", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://127.0.0.1:49187/private-path?token=private-token",
        ...navigationPolicy(),
      }),
    ).rejects.toThrow('Browser navigation blocked for host "127.0.0.1": browser.ssrfPolicy');
    try {
      await assertBrowserNavigationAllowed({
        url: "http://127.0.0.1/private-path?token=private-token",
        ...navigationPolicy(),
      });
    } catch (error) {
      expect(String(error)).not.toMatch(/private-path|private-token/);
    }
  });
  it("expires an inherited asynchronous preview grant when the request ends", async () => {
    const resume = createDeferred<void>();
    let lateCheck: Promise<void> | undefined;
    await withBrowserRequestScope(scope, async () => {
      lateCheck = (async () => {
        await resume.promise;
        await expect(
          assertBrowserNavigationAllowed({ url: "http://127.0.0.1/", ...navigationPolicy() }),
        ).rejects.toThrow();
      })();
    });
    resume.resolve();
    await lateCheck;
  });
  it.each([
    { name: "explicit empty policy", browser: { ssrfPolicy: {} } },
    {
      name: "explicit strict policy",
      browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
    },
    {
      name: "explicit other allowlist",
      browser: { ssrfPolicy: { allowedHostnames: ["preview.example"] } },
    },
    { name: "explicit deny", browser: { ssrfPolicy: { blockedHostnames: ["127.0.0.1"] } } },
    {
      name: "remote CDP",
      browser: { profiles: { openclaw: { cdpUrl: "https://browser.example" } } },
    },
    { name: "loopback attach-only", browser: { attachOnly: true } },
    {
      name: "explicit browser proxy",
      browser: { extraArgs: ["--proxy-server=http://proxy.example"] },
    },
    {
      name: "existing session",
      browser: { profiles: { openclaw: { driver: "existing-session" as const } } },
    },
  ])("preserves $name", async ({ browser }) => {
    await withBrowserRequestScope(scope, async () => {
      await expect(
        assertBrowserNavigationAllowed({
          url: "http://127.0.0.1:49187/",
          ...navigationPolicy(browser),
        }),
      ).rejects.toThrow();
    });
  });
  it("does not leak the default into another request or the stored policy", async () => {
    const policy = navigationPolicy();
    await withBrowserRequestScope(scope, async () => {
      await assertBrowserNavigationAllowed({ url: "http://127.0.0.1/", ...navigationPolicy() });
    });
    await expect(
      assertBrowserNavigationAllowed({ url: "http://127.0.0.1/", ...policy }),
    ).rejects.toThrow();
    await expect(
      assertBrowserNavigationAllowed({ url: "http://127.0.0.1/", ...navigationPolicy() }),
    ).rejects.toThrow();
  });
  it.each([
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://[fd00::1]/",
    "http://127.0.0.2/",
  ])("keeps other protected addresses blocked: %s", async (url) => {
    await withBrowserRequestScope(scope, async () => {
      await expect(
        assertBrowserNavigationAllowed({ url, ...navigationPolicy() }),
      ).rejects.toThrow();
    });
  });
});
