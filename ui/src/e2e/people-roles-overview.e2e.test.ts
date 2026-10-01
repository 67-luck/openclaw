import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const baseProfile = {
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
  githubIdentity: null,
  hasAvatar: false,
};
const profiles = [
  { ...baseProfile, id: "alice", displayName: "Alice", role: "guest" },
  { ...baseProfile, id: "bob", displayName: "Bob", role: "maintainer" },
  { ...baseProfile, id: "charlie", displayName: "Charlie" },
];
const roles = {
  default: "guest",
  definitions: {
    guest: {
      sessions: { others: "view" },
      agents: ["main"],
      sandbox: "required",
      scopes: ["operator.sessions.read", "operator.sessions.write"],
    },
    maintainer: {
      sessions: { others: "write" },
      agents: "*",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    },
  },
};
const responses = {
  "users.list": { profiles },
  "config.get": {
    exists: true,
    valid: true,
    config: {},
    sourceConfig: {},
    runtimeConfig: { gateway: { roles } },
  },
};

suite.define(() => {
  it("switches between People and Roles using the same authorized facts", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1100 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { methodResponses: responses });
        const proof = captureUiProofEnabled
          ? createControlUiE2eArtifactDir("people-roles-overview")
          : undefined;
        await page.goto(suite.server.baseUrl + "settings/people?person=alice");
        const view = page.locator("openclaw-people-page");
        await view.getByText("Required", { exact: true }).waitFor();
        const listReads = await gateway.getRequests("users.list");
        const configReads = await gateway.getRequests("config.get");
        if (proof) {
          await page.screenshot({
            path: path.join(proof, "people-view.png"),
            animations: "disabled",
          });
        }
        await view
          .getByRole("group", { name: "View access by" })
          .getByRole("button", { name: "Roles", exact: true })
          .click();
        await view.getByRole("heading", { name: /^Configured roles/ }).waitFor();
        await view.getByRole("heading", { name: /^Assigned people/ }).waitFor();
        await view.getByRole("heading", { name: /^Default-fallback people/ }).waitFor();
        expect(await view.textContent()).toContain(
          "Named profile roles come from Gateway configuration.",
        );
        expect(await view.textContent()).toContain("not members' live connection grants");
        expect(await view.getByRole("button", { name: /^Alice/ }).count()).toBe(1);
        expect(await view.getByRole("button", { name: /^Charlie/ }).count()).toBe(1);
        expect(await view.getByRole("button", { name: /^Bob/ }).count()).toBe(0);
        expect(await gateway.getRequests("users.list")).toEqual(listReads);
        expect(await gateway.getRequests("config.get")).toEqual(configReads);
        if (proof) {
          await page.screenshot({
            path: path.join(proof, "roles-view.png"),
            animations: "disabled",
          });
        }
        await view.getByRole("button", { name: /^maintainer/ }).click();
        await view.getByRole("button", { name: /^Bob/ }).waitFor();
        expect(await view.getByRole("button", { name: /^Alice/ }).count()).toBe(0);
        await view.getByRole("button", { name: /^Bob/ }).click();
        await view.getByText("Assigned role", { exact: true }).waitFor();
        expect(page.url()).toContain("person=bob");
        expect(
          await view
            .getByRole("button", { name: "People", exact: true })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(await gateway.getRequests("users.setRole")).toHaveLength(0);
        await page.setViewportSize({ width: 390, height: 844 });
        await view
          .getByRole("group", { name: "View access by" })
          .getByRole("button", { name: "Roles", exact: true })
          .click();
        await view.getByRole("heading", { name: /^Assigned people/ }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          390,
        );
        if (proof) {
          await page.screenshot({
            path: path.join(proof, "roles-view-phone.png"),
            animations: "disabled",
          });
        }
      },
    );
  });

  it("does not read broad role configuration or membership for a session-only guest", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: responses,
        operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
        presenceUsers: [
          {
            id: "guest-self",
            identity: { type: "profile", id: "guest-self" },
            name: "Jamie",
            self: true,
          },
        ],
      });
      await page.goto(suite.server.baseUrl + "settings/people?view=roles&role=maintainer");
      const view = page.locator("openclaw-people-page");
      await view
        .getByText(
          "Configured roles are unavailable with your current access. Your own connection permissions remain available in People.",
          { exact: true },
        )
        .waitFor();
      expect(await gateway.getRequests("config.get")).toHaveLength(0);
      expect(await gateway.getRequests("users.list")).toHaveLength(0);
      expect(await view.getByText("Bob", { exact: true }).count()).toBe(0);
      await view
        .getByRole("group", { name: "View access by" })
        .getByRole("button", { name: "People", exact: true })
        .click();
      await view
        .getByText("You have permission to work in your own sessions.", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("config.get")).toHaveLength(0);
    });
  });
});
