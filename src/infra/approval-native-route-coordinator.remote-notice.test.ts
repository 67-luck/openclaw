// Covers requester notices when the reviewer runtime is outside this Gateway.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createApprovalNativeRouteCoordinator,
  createApprovalNativeRouteReporter,
} from "./approval-native-route-coordinator.js";
import type { ApprovalRouteSendParams } from "./approval-native-route-notice.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ReporterOptions = Parameters<typeof createApprovalNativeRouteReporter>[0];
type RouteRequest = Parameters<ReporterOptions["shouldHandle"]>[0];

function createGatewayRequestMock() {
  return vi.fn(
    async (
      _method: "send",
      _params: ApprovalRouteSendParams,
      _options?: { liveOnlyWhenCurrent: (cfg?: OpenClawConfig) => boolean },
    ): Promise<void> => {},
  );
}

function createPluginRequest(id: string): PluginApprovalRequest {
  return {
    approvalKind: "plugin",
    id,
    request: {
      title: "Run report",
      description: "Render a diff",
      approvalSource: { channel: "slack", senderId: "U123" },
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "work",
      turnSourceThreadId: "1712345678.123456",
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

function createOrigin(
  coordinator: ReturnType<typeof createApprovalNativeRouteCoordinator>,
  overrides: Partial<ReporterOptions> = {},
) {
  const requestGateway = createGatewayRequestMock();
  const reporter = coordinator.createReporter({
    handledKinds: new Set(["plugin"]),
    channel: "slack",
    channelLabel: "Slack",
    accountId: "work",
    requestGateway,
    shouldHandle: () => false,
    classifyRoute: () => "unbound",
    isOriginCurrent: () => true,
    ...overrides,
  });
  reporter.start();
  return { reporter, requestGateway };
}

describe("plugin approval requester notices without a local reviewer route", () => {
  it("keeps the source excerpt out of route callbacks and pending notices", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const seen = {
      shouldHandle: [] as RouteRequest[],
      classifyRoute: [] as RouteRequest[],
      isOriginCurrent: [] as RouteRequest[],
    };
    const { reporter: origin, requestGateway: originGateway } = createOrigin(coordinator, {
      isOriginCurrent: (request) => {
        seen.isOriginCurrent.push(request);
        return true;
      },
    });
    const otherGateway = createGatewayRequestMock();
    const other = coordinator.createReporter({
      handledKinds: new Set(["plugin"]),
      channel: "discord",
      channelLabel: "Discord",
      accountId: "default",
      requestGateway: otherGateway,
      shouldHandle: (request) => {
        seen.shouldHandle.push(request);
        return true;
      },
      classifyRoute: (request) => {
        seen.classifyRoute.push(request);
        return "unbound";
      },
    });
    other.start();
    const request = createPluginRequest("plugin:private-route-source");
    request.request.approvalSource = {
      channel: "slack",
      senderId: "U123",
      userMessageExcerpt: "private original message",
    };

    coordinator.capturePluginOrigin(request);
    origin.selectRequest({ approvalKind: "plugin", request });
    const reviewerTarget = {
      surface: "approver-dm" as const,
      target: { to: "user:reviewer" },
      reason: "preferred" as const,
    };
    await other.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [reviewerTarget],
        originTarget: null,
        notifyOriginWhenDmOnly: false,
      },
      deliveredTargets: [reviewerTarget],
    });
    await origin.reportSkipped({ approvalKind: "plugin", request, reason: "ineligible" });
    await coordinator.finishPluginOriginRouting(request.id, true);

    for (const requests of Object.values(seen)) {
      expect(requests.length).toBeGreaterThan(0);
      for (const observed of requests) {
        expect(observed.request).toEqual(
          expect.objectContaining({ approvalSource: { channel: "slack", senderId: "U123" } }),
        );
      }
    }
    const sends = [...originGateway.mock.calls, ...otherGateway.mock.calls];
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[2]).toEqual(
      expect.objectContaining({
        approvalRequest: expect.objectContaining({
          request: expect.objectContaining({
            approvalSource: { channel: "slack", senderId: "U123" },
          }),
        }),
      }),
    );
    expect(request.request.approvalSource?.userMessageExcerpt).toBe("private original message");
    coordinator.close();
  });

  it("sends a truthful pending notice and denial through the captured source account", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    let current = true;
    const { reporter, requestGateway } = createOrigin(coordinator, {
      isOriginCurrent: () => current,
    });
    const request = createPluginRequest("plugin:remote-reviewer");
    coordinator.capturePluginOrigin(request);
    reporter.selectRequest({ approvalKind: "plugin", request });
    await reporter.reportSkipped({ approvalKind: "plugin", request, reason: "ineligible" });
    expect(requestGateway).not.toHaveBeenCalled();

    await coordinator.finishPluginOriginRouting(request.id, false);
    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        channel: "slack",
        to: "channel:C123",
        accountId: "work",
        threadId: "1712345678.123456",
        message: `Approval ${request.id} required. An approver can review it in the Control UI or terminal UI.`,
      }),
      { liveOnlyWhenCurrent: expect.any(Function), approvalRequest: request },
    );
    expect(requestGateway.mock.calls[0]?.[1].message).not.toMatch(/sent|delivered|DMs/i);

    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
    expect(requestGateway.mock.calls[1]?.[1].message).toBe(
      `Approval ${request.id} was denied. The requested action did not run.`,
    );
    const pendingGuard = requestGateway.mock.calls[0]?.[2]?.liveOnlyWhenCurrent;
    const terminalGuard = requestGateway.mock.calls[1]?.[2]?.liveOnlyWhenCurrent;
    expect(pendingGuard?.()).toBe(false);
    expect(terminalGuard?.()).toBe(true);
    current = false;
    expect(terminalGuard?.()).toBe(false);
    coordinator.close();
  });

  it("sends expiry without a remote client report and suppresses a prior allow", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const { requestGateway } = createOrigin(coordinator);
    const expired = createPluginRequest("plugin:remote-expired");
    coordinator.capturePluginOrigin(expired);
    await coordinator.finishPluginOriginRouting(expired.id, false);
    await coordinator.publishPluginTerminal({ approvalId: expired.id, status: "expired" });
    expect(requestGateway.mock.calls.map((call) => call[1].message)).toEqual([
      `Approval ${expired.id} required. An approver can review it in the Control UI or terminal UI.`,
      `Approval ${expired.id} timed out. The requested action did not run.`,
    ]);

    const allowed = createPluginRequest("plugin:remote-allowed");
    coordinator.capturePluginOrigin(allowed);
    await coordinator.publishPluginTerminal({ approvalId: allowed.id, status: "allowed" });
    await coordinator.finishPluginOriginRouting(allowed.id, false);
    expect(requestGateway).toHaveBeenCalledTimes(2);
    coordinator.close();
  });

  it("does not send a duplicate notice when the local card reached the origin", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const { reporter, requestGateway } = createOrigin(coordinator, {
      shouldHandle: () => true,
    });
    const request = createPluginRequest("plugin:local-origin-card");
    coordinator.capturePluginOrigin(request);
    reporter.selectRequest({ approvalKind: "plugin", request });
    await coordinator.finishPluginOriginRouting(request.id, true);
    const originTarget = {
      surface: "origin" as const,
      target: { to: "channel:C123", threadId: "1712345678.123456" },
      reason: "preferred" as const,
    };
    await reporter.reportDelivery({
      approvalKind: "plugin",
      request,
      deliveryPlan: {
        targets: [originTarget],
        originTarget: originTarget.target,
        notifyOriginWhenDmOnly: false,
      },
      deliveredTargets: [originTarget],
    });
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
    expect(requestGateway).not.toHaveBeenCalled();
    coordinator.close();
  });

  it("keeps terminal handoff bound to the original runtime after replacement", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    let current = true;
    const { reporter, requestGateway } = createOrigin(coordinator, {
      isOriginCurrent: () => current,
    });
    const request = createPluginRequest("plugin:retired-origin");
    coordinator.capturePluginOrigin(request);
    await coordinator.finishPluginOriginRouting(request.id, false);
    const pendingGuard = requestGateway.mock.calls[0]?.[2]?.liveOnlyWhenCurrent;
    expect(pendingGuard?.()).toBe(true);
    current = false;
    expect(pendingGuard?.()).toBe(false);
    await reporter.stop();
    createOrigin(coordinator);
    await coordinator.publishPluginTerminal({ approvalId: request.id, status: "denied" });
    expect(requestGateway).toHaveBeenCalledTimes(2);
    expect(requestGateway.mock.calls[1]?.[2]?.liveOnlyWhenCurrent()).toBe(false);
    coordinator.close();
  });
});
