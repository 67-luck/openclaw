// Profile logout uses authenticated bootstrap metadata, not connected-account actions.
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
  type ControlUiMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Profile logout", startServerBeforeBrowser: true });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("profile-logout");
  }
});
const basePath = "/wilfred";
const profilePath = `${basePath}/settings/profile`;
const testProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["test@example.com"],
  githubIdentity: null,
  hasAvatar: false,
};
const testPresenceUsers: NonNullable<ControlUiMockGatewayScenario["presenceUsers"]> = [
  { self: true, id: testProfile.id, name: testProfile.displayName, email: testProfile.emails[0] },
];

suite.define(() => {
  async function openProfilePage(
    page: Page,
    methodResponses: Record<string, unknown> = {},
    presenceUsers = testPresenceUsers,
  ) {
    const gateway = await installMockGateway(page, {
      basePath,
      presenceUsers,
      methodResponses: {
        "users.self": { profile: testProfile },
        "agents.list": {
          defaultId: "clipper",
          agents: [{ id: "clipper", name: "Clipper" }],
        },
        ...methodResponses,
      },
    });
    const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
    expect(response?.status()).toBe(200);
    return gateway;
  }

  it("logs out through Cloudflare outside the UI base path without disconnecting linked accounts", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      await openProfilePage(page);
      await page.route("**/control-ui-config.json", async (route) => {
        await route.fulfill({
          json: {
            ...createControlUiMockBootstrapConfig({ basePath }),
            logout: { provider: "cloudflare-access", path: "/cdn-cgi/access/logout" },
          },
        });
      });
      await page.reload();
      const logout = page.getByRole("button", { name: "Log out", exact: true });
      await expect(logout).toBeVisible();
      await expect(page.getByText("Your profile on this gateway.")).toBeVisible();
      await expect(
        page.getByText(/Log out of Cloudflare Access across its protected apps/u),
      ).toBeVisible();
      if (captureUiProof) {
        await logout.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(proofDir, "profile-logout-after.png"),
          animations: "disabled",
        });
      }
      await page.evaluate(() => {
        window.addEventListener(
          "beforeunload",
          () => {
            const mock = (window as Window & { openclawControlUiE2eGateway: ControlUiMockGateway })
              .openclawControlUiE2eGateway;
            sessionStorage.setItem(
              "logout-proof-methods",
              JSON.stringify(mock.requests.map((request) => request.method)),
            );
          },
          { once: true },
        );
      });
      await page.route("**/cdn-cgi/access/logout", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<h1>Cloudflare Access logout</h1>",
        });
      });
      await logout.click();
      await expect(page).toHaveURL(new URL("/cdn-cgi/access/logout", suite.server.baseUrl).href);
      const methodsAtLogout: string[] = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("logout-proof-methods") ?? "[]"),
      );
      expect(methodsAtLogout).toContain("users.self");
      expect(methodsAtLogout.some((method) => /disconnect|logout|revoke/iu.test(method))).toBe(
        false,
      );
    });
  });

  it("does not show logout without an authenticated ingress capability", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      await openProfilePage(page);
      const usage = page.getByRole("button", { name: /Usage statistics/u });
      await expect(usage).toBeVisible();
      await expect(page.getByRole("button", { name: "Log out", exact: true })).toHaveCount(0);
      if (captureUiProof) {
        await usage.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(proofDir, "profile-logout-before.png"),
          animations: "disabled",
        });
      }
    });
  });
});
