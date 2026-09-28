// Covers remote native approval notices to the original requester.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createApprovalNativeRouteCoordinator,
  createApprovalNativeRouteReporter,
} from "./approval-native-route-coordinator.js";
import {
  formatRemotePluginApprovalNotice,
  type ApprovalRouteSendParams,
} from "./approval-native-route-notice.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ReporterOptions = Parameters<typeof createApprovalNativeRouteReporter>[0];

function createGatewayRequestMock() {
  return vi.fn(
    async (
      _method: "send",
      _params: ApprovalRouteSendParams,
      _options?: { liveOnlyWhenCurrent: (cfg?: OpenClawConfig) => boolean },
    ): Promise<void> => {},
  );
}

function reporterOptions(overrides: Partial<ReporterOptions> = {}): ReporterOptions {
  return {
    handledKinds: new Set(["plugin"]),
    channel: "slack",
    accountId: "work",
    requestGateway: createGatewayRequestMock(),
    shouldHandle: () => true,
    classifyRoute: () => "unbound",
    ...overrides,
  };
}

function createPluginRequest(id: string): PluginApprovalRequest {
  return {
    approvalKind: "plugin",
    id,
    request: {
      title: "Run report",
      description: "Render a diff",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "work",
      turnSourceThreadId: "1712345678.123456",
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

describe("remote plugin approval requester outcome", () => {
  it("renders remote channel labels as plain text in requester notices", () => {
    expect(
      formatRemotePluginApprovalNotice({
        approvalId: "plugin:markup",
        channelLabel: "<!channel>",
        deliveredAny: true,
        deliveredOnlyToApproverDms: true,
      }),
    ).toBe("Approval plugin:markup required. An approval request was sent to channel DMs.");
  });

  it("keeps a failed local attempt distinct from a later remote reviewer delivery", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const origin = coordinator.createReporter(
      reporterOptions({ isOriginCurrent: () => true, requestGateway }),
    );
    const request = createPluginRequest("plugin:mixed-native-delivery");
    request.request.approvalSource = { channel: "slack", senderId: "U123" };
    origin.start();
    coordinator.capturePluginOrigin(request);
    origin.selectRequest({ approvalKind: "plugin", request });

    await origin.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [{ surface: "approver-dm", target: { to: "user:owner" }, reason: "preferred" }],
        originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [],
    });
    await coordinator.reportRemoteNativeDelivery(
      {
        id: request.id,
        channel: "matrix",
        channelLabel: "Matrix",
        deliveredAny: true,
        deliveredOnlyToApproverDms: true,
      },
      () => {},
    );

    expect(requestGateway.mock.calls.map((call) => call[1].message)).toEqual([
      expect.stringContaining("A native approval delivery attempt failed."),
      `Approval ${request.id} required. An approval request was sent to Matrix DMs.`,
    ]);
    coordinator.close();
  });

  it("routes a remote reviewer report through the original live Slack account", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    let originalAccountCurrent = true;
    const origin = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        accountId: "work",
        isOriginCurrent: () => originalAccountCurrent,
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:remote-reviewer");
    request.request.approvalSource = { channel: "slack", senderId: "U123" };
    origin.start();
    coordinator.capturePluginOrigin(request);
    const remoteReport = {
      id: request.id,
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "reviewers",
      deliveredAny: true,
      deliveredOnlyToApproverDms: true,
    };
    let reporterCurrent = true;
    const assertReporterCurrent = () => {
      if (!reporterCurrent) {
        throw new Error("reviewer client disconnected");
      }
    };
    await coordinator.reportRemoteNativeDelivery(remoteReport, assertReporterCurrent);
    await coordinator.reportRemoteNativeDelivery(remoteReport, assertReporterCurrent);

    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        channel: "slack",
        to: "channel:C123",
        accountId: "work",
        threadId: "1712345678.123456",
        message: `Approval ${request.id} required. An approval request was sent to Matrix DMs.`,
      }),
      { liveOnlyWhenCurrent: expect.any(Function), approvalRequest: request },
    );
    const pendingGuard = requestGateway.mock.calls[0]?.[2]?.liveOnlyWhenCurrent;
    expect(pendingGuard?.()).toBe(true);
    reporterCurrent = false;
    expect(pendingGuard?.()).toBe(false);
    reporterCurrent = true;
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
    expect(requestGateway).toHaveBeenCalledTimes(2);
    expect(requestGateway.mock.calls[1]?.[1].message).toBe(
      `Approval ${request.id} was denied. The requested action did not run.`,
    );
    originalAccountCurrent = false;
    expect(pendingGuard?.()).toBe(false);
    expect(requestGateway.mock.calls[1]?.[2]?.liveOnlyWhenCurrent()).toBe(false);
    coordinator.close();
  });

  it("keeps remote reports bound to the source runtime that existed at request time", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const origin = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        accountId: "work",
        isOriginCurrent: () => true,
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:retired-origin");
    request.request.approvalSource = { channel: "slack", senderId: "U123" };
    origin.start();
    coordinator.capturePluginOrigin(request);
    await origin.stop();
    const replacement = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        accountId: "work",
        isOriginCurrent: () => true,
        requestGateway,
      }),
    );
    replacement.start();

    await expect(
      coordinator.reportRemoteNativeDelivery(
        {
          id: request.id,
          channel: "matrix",
          deliveredAny: true,
          deliveredOnlyToApproverDms: true,
        },
        () => {},
      ),
    ).rejects.toThrow("originating approval account is no longer active");
    expect(requestGateway).not.toHaveBeenCalled();
    coordinator.close();
  });

  it("sends the denied outcome when it overtakes a remote delivery report", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const origin = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        accountId: "work",
        isOriginCurrent: () => true,
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:late-remote-report");
    request.request.approvalSource = { channel: "slack", senderId: "U123" };
    origin.start();
    coordinator.capturePluginOrigin(request);
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
    await coordinator.reportRemoteNativeDelivery(
      {
        id: request.id,
        channel: "matrix",
        deliveredAny: true,
        deliveredOnlyToApproverDms: true,
      },
      () => {},
    );

    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway.mock.calls[0]?.[1].message).toBe(
      `Approval ${request.id} was denied. The requested action did not run.`,
    );
    coordinator.close();
  });

  it("still sends denial after a pending remote notice fails during resolution", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    let startPending!: () => void;
    let rejectPending!: (error: Error) => void;
    const pendingStarted = new Promise<void>((resolve) => {
      startPending = resolve;
    });
    const pendingSend = new Promise<void>((_resolve, reject) => {
      rejectPending = reject;
    });
    const requestGateway = createGatewayRequestMock()
      .mockImplementationOnce(async () => {
        startPending();
        await pendingSend;
      })
      .mockImplementationOnce(async () => {});
    const origin = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        accountId: "work",
        isOriginCurrent: () => true,
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:failed-pending-send");
    request.request.approvalSource = { channel: "slack", senderId: "U123" };
    origin.start();
    coordinator.capturePluginOrigin(request);
    const report = coordinator.reportRemoteNativeDelivery(
      {
        id: request.id,
        channel: "matrix",
        deliveredAny: true,
        deliveredOnlyToApproverDms: true,
      },
      () => {},
    );
    await pendingStarted;
    const terminal = coordinator.publishPluginTerminal({
      approvalId: request.id,
      status: "denied",
    });
    rejectPending(new Error("pending delivery failed"));

    await expect(report).rejects.toThrow("pending delivery failed");
    await terminal;
    expect(requestGateway.mock.calls.map((call) => call[1].message)).toEqual([
      `Approval ${request.id} required. An approval request was sent to matrix DMs.`,
      `Approval ${request.id} was denied. The requested action did not run.`,
    ]);
    coordinator.close();
  });

  it("reports a failed remote card and a later successful reviewer delivery accurately", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const requestGateway = createGatewayRequestMock();
    const origin = coordinator.createReporter(
      reporterOptions({
        handledKinds: new Set(["plugin"]),
        channel: "slack",
        accountId: "work",
        isOriginCurrent: () => true,
        requestGateway,
      }),
    );
    const request = createPluginRequest("plugin:remote-fail-then-success");
    request.request.approvalSource = { channel: "slack", senderId: "U123" };
    origin.start();
    coordinator.capturePluginOrigin(request);

    await coordinator.reportRemoteNativeDelivery(
      {
        id: request.id,
        channel: "matrix",
        channelLabel: "Matrix",
        deliveredAny: false,
        deliveredOnlyToApproverDms: false,
      },
      () => {},
    );
    await coordinator.reportRemoteNativeDelivery(
      {
        id: request.id,
        channel: "matrix",
        channelLabel: "Matrix",
        deliveredAny: true,
        deliveredOnlyToApproverDms: true,
      },
      () => {},
    );

    expect(requestGateway.mock.calls.map((call) => call[1].message)).toEqual([
      `Approval ${request.id} required. The Matrix reviewer card was not delivered. Open the Control UI or terminal UI to review it.`,
      `Approval ${request.id} required. An approval request was sent to Matrix DMs.`,
    ]);
    coordinator.close();
  });

  it.each(["local-first", "remote-first"] as const)(
    "does not duplicate a local origin card's terminal outcome when remote reporting is %s",
    async (order) => {
      const coordinator = createApprovalNativeRouteCoordinator();
      const requestGateway = createGatewayRequestMock();
      const origin = coordinator.createReporter(
        reporterOptions({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          accountId: "work",
          isOriginCurrent: () => true,
          requestGateway,
        }),
      );
      const request = createPluginRequest(`plugin:both-cards-${order}`);
      request.request.approvalSource = { channel: "slack", senderId: "U123" };
      origin.start();
      coordinator.capturePluginOrigin(request);
      origin.selectRequest({ approvalKind: "plugin", request });
      const reportLocal = async () =>
        await origin.reportDelivery({
          approvalKind: "plugin",
          request,
          deliveryPlan: {
            targets: [
              {
                surface: "origin",
                target: { to: "channel:C123", threadId: "1712345678.123456" },
                reason: "preferred",
              },
            ],
            originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
            notifyOriginWhenDmOnly: false,
          },
          deliveredTargets: [
            {
              surface: "origin",
              target: { to: "channel:C123", threadId: "1712345678.123456" },
              reason: "preferred",
            },
          ],
        });
      const reportRemote = async () =>
        await coordinator.reportRemoteNativeDelivery(
          {
            id: request.id,
            channel: "matrix",
            channelLabel: "Matrix",
            deliveredAny: true,
            deliveredOnlyToApproverDms: true,
          },
          () => {},
        );
      if (order === "local-first") {
        await reportLocal();
        await reportRemote();
      } else {
        await reportRemote();
        await reportLocal();
      }
      await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
      expect(requestGateway.mock.calls.some((call) => call[1].message.includes("was denied"))).toBe(
        false,
      );
      coordinator.close();
    },
  );
});
