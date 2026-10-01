import { expect, it } from "vitest";
import { selectControlUiRoutePreloads } from "../../../src/gateway/control-ui-route-preloads.ts";
import { captureControlUiBoot } from "../test-helpers/control-ui-boot-capture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat boot preload coverage" });

suite.define(() => {
  it.each([false, true])(
    "covers foreground boot JS before chat.startup (default landing: %s)",
    async (mainSession) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const preloaded = new Set<string>();
        await page.route("**/*", async (route) => {
          if (!route.request().isNavigationRequest()) {
            await route.fallback();
            return;
          }
          const response = await route.fetch();
          const source = await response.text();
          expect(source).toContain('<template data-openclaw-route-preloads="chat">');
          const html = selectControlUiRoutePreloads(source, "chat");
          const headEnd = html.indexOf("</head>");
          if (headEnd < 0) {
            throw new Error("Built Control UI document has no head");
          }
          const head = html.slice(0, headEnd);
          for (const match of head.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+\.js)"/g)) {
            const href = match[1];
            if (href === undefined) {
              throw new Error("Built JavaScript preload has no asset URL");
            }
            const url = new URL(href, route.request().url());
            if (url.origin === new URL(suite.server.baseUrl).origin) {
              preloaded.add(url.pathname.slice(url.pathname.indexOf("/assets/")));
            }
          }
          await route.fulfill({ response, body: html });
        });
        const capture = await captureControlUiBoot(page, suite.server.baseUrl, { mainSession });
        expect(preloaded.size).toBeGreaterThan(0);
        expect(capture.beforeStartup.size).toBeGreaterThan(0);
        expect(
          [...capture.beforeStartup].filter((asset) => !preloaded.has(asset)).toSorted(),
          "Uncovered chat boot JS; run pnpm ui:boot-manifest:gen and check the performance budget",
        ).toEqual([]);
      });
    },
  );
});
