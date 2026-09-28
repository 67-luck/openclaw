import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type TestContext } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const report = {
  id: "plugin:remote-delivery",
  channel: "telegram",
  channelLabel: "Telegram",
  accountId: "review",
  deliveredAny: true,
  deliveredOnlyToApproverDms: true,
} as const;

function createOptions(
  id: string,
  mode: (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES] = GATEWAY_CLIENT_MODES.BACKEND,
  deviceId = "device-approver",
): GatewayRequestHandlerOptions {
  const params = { ...report, id };
  // SAFETY: The handler test supplies the authenticated Gateway client and request context directly.
  return {
    req: { method: "plugin.approval.reportNativeDelivery", params, id: "req-1" },
    params,
    client: {
      connId: "remote-approval-runtime",
      connect: {
        role: "operator",
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        client: { id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT, mode },
        device: { id: deviceId },
      },
    },
    respond: vi.fn(),
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as GatewayRequestHandlerOptions;
}

function createFixture(testContext: TestContext) {
  const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
    approvalKind: "plugin",
  });
  const reportRemoteNativeDelivery = vi.fn(async () => {});
  const handler = expectDefined(
    createPluginApprovalHandlers(manager, { reportRemoteNativeDelivery })[
      "plugin.approval.reportNativeDelivery"
    ],
    "native delivery report handler",
  );
  async function register(id: string, approvalSource?: { channel: string }) {
    const record = manager.create(
      {
        title: "T",
        description: "D",
        ...(approvalSource ? { approvalSource } : {}),
        turnSourceChannel: "slack",
        turnSourceTo: "channel:D123",
        turnSourceAccountId: "default",
      },
      60_000,
      id,
    );
    record.approvalReviewerDeviceIds = ["device-approver"];
    await manager.register(record, 60_000);
  }
  return { handler, manager, register, reportRemoteNativeDelivery };
}

it("reports cross-channel native delivery only for a pending host-origin approval", async (testContext) => {
  const fixture = createFixture(testContext);
  await fixture.register(report.id, { channel: "slack" });
  const options = createOptions(report.id);

  await fixture.handler(options);

  expect(options.respond).toHaveBeenCalledWith(true, { reported: true }, undefined);
  expect(fixture.reportRemoteNativeDelivery).toHaveBeenCalledWith(report, expect.any(Function));
});

it("accepts a late delivery report after denial so the origin can receive its terminal notice", async (testContext) => {
  const fixture = createFixture(testContext);
  await fixture.register(report.id, { channel: "slack" });
  await fixture.manager.resolve(report.id, "deny");
  const options = createOptions(report.id);

  await fixture.handler(options);

  expect(options.respond).toHaveBeenCalledWith(true, { reported: true }, undefined);
  expect(fixture.reportRemoteNativeDelivery).toHaveBeenCalledWith(report, expect.any(Function));
});

it("rejects public turn-source records and non-backend callers", async (testContext) => {
  const fixture = createFixture(testContext);
  await fixture.register(report.id);
  const publicOptions = createOptions(report.id);
  await fixture.handler(publicOptions);
  expect(publicOptions.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: expect.any(String) }),
  );

  const uiId = "plugin:remote-delivery-ui";
  await fixture.register(uiId, { channel: "slack" });
  const uiOptions = createOptions(uiId, GATEWAY_CLIENT_MODES.UI);
  await fixture.handler(uiOptions);
  expect(uiOptions.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: expect.any(String) }),
  );
  expect(fixture.reportRemoteNativeDelivery).not.toHaveBeenCalled();
});

it("rejects a scoped approval client that cannot see the exact record", async (testContext) => {
  const fixture = createFixture(testContext);
  await fixture.register(report.id, { channel: "slack" });
  const options = createOptions(report.id, GATEWAY_CLIENT_MODES.BACKEND, "other-device");

  await fixture.handler(options);

  expect(options.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: expect.any(String) }),
  );
  expect(fixture.reportRemoteNativeDelivery).not.toHaveBeenCalled();
});
