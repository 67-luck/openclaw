/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import type {
  UserProfile,
  UsersListResult,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createConnectedContext,
  modelAccountProfile,
} from "../profile/profile-page.test-support.ts";
import { PeoplePage } from "./people-page.ts";

const policy = {
  sessions: { others: "view" },
  agents: ["main"],
  scopes: ["operator.sessions.read", "operator.sessions.write"],
  sandbox: "required",
  modelPolicy: { allow: [], deny: ["example/private-*"], sourceAgent: "main" },
  accessPolicyPlugin: "example-access",
};
const guest = { ...modelAccountProfile, role: "guest" };
const methods = ["users.list", "users.self", "config.get"];
const tag = "test-people-permissions-page";
customElements.define(tag, class extends PeoplePage {});
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup(scopes = ["operator.read"], profiles: UserProfile[] = [guest]) {
  const result = createDeferred<UsersListResult>();
  const request = vi.fn(async (method: string) =>
    method === "users.list" ? result.promise : { profile: guest },
  );
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: guest.id,
    identity: { type: "profile", id: guest.id },
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods(methods, scopes));
  Object.assign(
    harness.context.runtimeConfig.state,
    createInitialConfigState(harness.context.gateway.snapshot),
    {
      configSnapshot: {
        runtimeConfig: { gateway: { roles: { default: "guest", definitions: { guest: policy } } } },
        sourceConfig: { gateway: { roles: { default: "wrong-saved-draft", definitions: {} } } },
      },
    },
  );
  harness.context.runtimeConfig.refresh = vi.fn(async () => undefined);
  const ensure = vi.spyOn(harness.context.runtimeConfig, "ensureLoaded");
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(tag) as PeoplePage;
  provider.append(page);
  document.body.append(provider);
  return {
    ...harness,
    request,
    ensure,
    page,
    async finish() {
      result.resolve({ profiles });
      await result.promise;
      await Promise.all(request.mock.results.map((call) => call.value));
      await page.updateComplete;
    },
    result,
  };
}

it.each(["operator.read", "operator.admin"])(
  "shows applied ceilings, not other connection grants, for %s",
  async (scope) => {
    const h = setup([scope]);
    h.page.personId = guest.id;
    await h.page.updateComplete;
    expect(h.page.querySelector('[aria-busy="true"]')).not.toBeNull();
    await h.finish();
    expect(h.page.textContent).toContain("Role policy · maximum permissions");
    expect(h.page.textContent).toContain(
      "Configured ceilings, not this person's live connection permissions.",
    );
    expect(h.page.textContent).toContain("Required");
    expect(h.page.textContent).toContain("No models");
    expect(h.page.textContent).toContain("example-access");
    expect(h.page.textContent).not.toContain("wrong-saved-draft");
    expect(h.request).toHaveBeenCalledExactlyOnceWith("users.list", {});
    expect(h.ensure).toHaveBeenCalledOnce();
  },
);

it("keeps guest reads self-scoped and refuses another person's deep link", async () => {
  const h = setup(["operator.sessions.read", "operator.sessions.write"]);
  await h.page.updateComplete;
  await h.context.gateway.loadSelfProfile();
  await h.page.updateComplete;
  expect(h.page.textContent).toContain("You have permission to work in your own sessions.");
  expect(h.page.textContent).toContain("Your connection cannot read the people directory.");
  expect(h.ensure).not.toHaveBeenCalled();
  expect(h.request.mock.calls.every(([method]) => method === "users.self")).toBe(true);
  h.page.personId = "another-person";
  await h.page.updateComplete;
  expect(h.page.textContent).not.toContain("Your access");
  expect(h.page.textContent).toContain("This profile is unavailable or cannot be read");
  expect(h.page.textContent).not.toContain("example-access");
});

it.each([undefined, "retired-role"])(
  "distinguishes the saved %s assignment from default policy",
  async (role) => {
    const h = setup(["operator.read"], [{ ...guest, role }]);
    h.page.personId = guest.id;
    await h.page.updateComplete;
    await h.finish();
    expect(h.page.textContent).toContain(
      role ? "saved role is no longer defined" : "No role is assigned",
    );
    expect(h.page.textContent).toContain("guest");
  },
);

it("follows canonical merges and does not show retired directory rows", async () => {
  const alias = {
    ...guest,
    id: "retired-alias",
    displayName: "Old person",
    mergedInto: guest.id,
    role: "retired-role",
  };
  const h = setup(["operator.read"], [alias, guest]);
  h.page.personId = alias.id;
  await h.page.updateComplete;
  await h.finish();
  expect(h.page.textContent).toContain("Ada");
  expect(h.page.textContent).not.toContain("Old person");
  expect(h.page.textContent).not.toContain("retired-role");
});

it.each(["owner", "roles-off", "missing-runtime", "empty"])(
  "reports %s without inventing authority",
  async (state) => {
    const h = setup(
      ["operator.read"],
      state === "empty"
        ? []
        : [state === "owner" ? { ...guest, id: GATEWAY_OWNER_PROFILE_ID } : guest],
    );
    h.page.personId = state === "owner" ? GATEWAY_OWNER_PROFILE_ID : guest.id;
    if (state === "roles-off") {
      h.context.runtimeConfig.state.configSnapshot = { runtimeConfig: {} };
    }
    if (state === "missing-runtime") {
      h.context.runtimeConfig.state.configSnapshot = { config: {} };
    }
    await h.page.updateComplete;
    await h.finish();
    expect(h.page.textContent).toContain(
      state === "owner"
        ? "outside the named-role boundary"
        : state === "roles-off"
          ? "Named operator roles are not configured"
          : state === "empty"
            ? "No profiles were returned"
            : "applied role policy could not be confirmed",
    );
  },
);

it("retires late directory responses on a same-client downgrade and reconnect", async () => {
  const h = setup();
  h.page.personId = guest.id;
  await h.page.updateComplete;
  h.emitHello(gatewayHelloForMethods(methods, ["operator.sessions.read"]));
  await h.finish();
  expect(h.page.textContent).not.toContain("example-access");
  expect(h.page.textContent).toContain("Your connection cannot read the people directory.");
  h.emitConnected(false);
  await h.page.updateComplete;
  expect(h.page.textContent).not.toContain("Assigned role");
  expect(h.page.textContent).toContain("Connect to the gateway");
  h.emitHello(gatewayHelloForMethods(methods, ["operator.read"]));
  h.emitConnected(true);
  await h.page.updateComplete;
  expect(h.request.mock.calls.filter(([method]) => method === "users.list")).toHaveLength(2);
});

it("does not publish a late read after unmounting", async () => {
  const h = setup();
  await h.page.updateComplete;
  h.page.remove();
  await h.finish();
  expect(h.page.textContent).not.toContain("example-access");
});
