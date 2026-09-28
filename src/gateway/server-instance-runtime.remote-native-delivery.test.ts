import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ApprovalRouteSendParams,
  GatewayRequestFn,
} from "../infra/approval-native-route-notice.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

function createContext(): GatewayRequestContext {
  return {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: name.includes("approval") ? APPROVALS_SCOPE : WRITE_SCOPE,
    })),
  );
}

describe("createGatewayInstanceRuntime remote plugin delivery", () => {
  it("sends remote plugin approval and denial notices through the captured source account", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "remote-plugin-approval-notice-" },
      async () => {
        const sourceConfig: OpenClawConfig = {
          channels: { slack: { accounts: { work: { botToken: "source-token" } } } },
        };
        let currentConfig = sourceConfig;
        const context: GatewayRequestContext = {
          ...createContext(),
          getRuntimeConfig: () => currentConfig,
        };
        const runtime = createGatewayInstanceRuntime({
          getContext: () => context,
          getMethodRegistry: () => createRegistry({}),
          isDispatchAvailable: () => true,
        });
        const aux = createGatewayAuxHandlers({
          scheduler: createTestGatewayScheduler(),
          log: {},
          getNativeApprovalRouteCoordinator: () => runtime.nativeApprovals.routeCoordinator,
          activateRuntimeSecrets: createTestRuntimeSecretsActivator(),
          sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
            current: undefined,
            required: null,
          }),
          resolveSharedGatewaySessionGenerationForConfig: () => undefined,
          clients: [],
          channelManager: {
            startChannel: async () => new Map(),
            stopChannel: async () => {},
            isManuallyStopped: () => false,
            resolveRuntimeAccountId: (_channel, accountId) => accountId,
          },
          logChannels: { info: () => {} },
        });
        context.pluginApprovalManager = aux.pluginApprovalManager;
        const sent: ApprovalRouteSendParams[] = [];
        const guards: Array<(cfg?: OpenClawConfig) => boolean> = [];
        const deniedSent = createDeferred();
        const requestGateway: GatewayRequestFn = async (_method, payload, options) => {
          if (!options?.liveOnlyWhenCurrent(currentConfig)) {
            throw new Error("source account is no longer current");
          }
          guards.push(options.liveOnlyWhenCurrent);
          sent.push(payload);
          if (payload.message.includes("was denied")) {
            deniedSent.resolve();
          }
        };
        const reporter = runtime.nativeApprovals.routeCoordinator.createReporter({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          channelLabel: "Slack",
          accountId: "work",
          sourceConfig,
          isOriginCurrent: (_request, cfg) =>
            currentConfig.channels?.slack?.accounts?.work?.botToken === "source-token" &&
            (cfg === undefined || cfg === sourceConfig),
          requestGateway,
          shouldHandle: () => true,
          classifyRoute: () => "unbound",
        });
        try {
          const record = aux.pluginApprovalManager.create(
            {
              title: "Review action",
              description: "Approve an operation",
              approvalSource: { channel: "slack", senderId: "U123" },
              turnSourceChannel: "slack",
              turnSourceTo: "channel:C123",
              turnSourceAccountId: "work",
              turnSourceThreadId: "1712345678.123456",
            },
            60_000,
            "plugin:remote-origin-notice",
          );
          record.approvalReviewerDeviceIds = ["reviewer-device"];
          await aux.pluginApprovalManager.register(record, 60_000);
          const request: PluginApprovalRequest = {
            approvalKind: "plugin",
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          };
          reporter.start();
          runtime.approvalEvents.publishRequested("plugin", request);

          const registry = createRegistry(aux.extraHandlers);
          const report = {
            id: record.id,
            channel: "matrix",
            channelLabel: "Matrix",
            accountId: "reviewers",
            deliveredAny: true,
            deliveredOnlyToApproverDms: true,
          };
          const clientForDevice = (deviceId: string) =>
            ({
              connId: `remote-${deviceId}`,
              connect: {
                role: "operator",
                scopes: [APPROVALS_SCOPE],
                caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
                client: {
                  id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
                  mode: GATEWAY_CLIENT_MODES.BACKEND,
                },
                device: { id: deviceId },
              },
            }) as Parameters<typeof dispatchGatewayRequestInProcessRaw>[2]["client"];
          const dispatch = (deviceId: string, payload = report) =>
            dispatchGatewayRequestInProcessRaw("plugin.approval.reportNativeDelivery", payload, {
              client: clientForDevice(deviceId),
              context,
              methodRegistry: registry,
            });

          expect(await dispatch("other-device")).toMatchObject({
            ok: false,
            error: { message: "unknown or unbound plugin approval" },
          });
          expect(sent).toEqual([]);
          expect(await dispatch("reviewer-device")).toMatchObject({
            ok: true,
            payload: { reported: true },
          });
          expect(sent).toEqual([
            {
              channel: "slack",
              to: "channel:C123",
              accountId: "work",
              threadId: "1712345678.123456",
              message: `Approval ${record.id} required. An approval request was sent to Matrix DMs.`,
              idempotencyKey: `approval-remote-route-notice:${record.id}:delivered`,
            },
          ]);

          await aux.pluginApprovalManager.resolve(record.id, "deny");
          runtime.approvalEvents.publishResolved("plugin", {
            id: record.id,
            decision: "deny",
            ts: Date.now(),
            request: record.request,
          });
          await deniedSent.promise;
          expect(sent[1]).toEqual({
            channel: "slack",
            to: "channel:C123",
            accountId: "work",
            threadId: "1712345678.123456",
            message: `Approval ${record.id} was denied. The requested action did not run.`,
            idempotencyKey: `approval-terminal-notice:${record.id}`,
          });

          // A remote card can finish after the manager's normal 15-second
          // resolved grace. The captured source must retain its exact binding.
          const lateRecord = aux.pluginApprovalManager.create(
            record.request,
            60_000,
            "plugin:remote-origin-late-denial",
          );
          lateRecord.approvalReviewerDeviceIds = ["reviewer-device"];
          await aux.pluginApprovalManager.register(lateRecord, 60_000);
          runtime.approvalEvents.publishRequested("plugin", {
            approvalKind: "plugin",
            id: lateRecord.id,
            request: lateRecord.request,
            createdAtMs: lateRecord.createdAtMs,
            expiresAtMs: lateRecord.expiresAtMs,
          });
          await aux.pluginApprovalManager.resolve(lateRecord.id, "deny");
          runtime.approvalEvents.publishResolved("plugin", {
            id: lateRecord.id,
            decision: "deny",
            ts: Date.now(),
            request: lateRecord.request,
          });
          const futureNow = Date.now() + 16_000;
          const nowSpy = vi.spyOn(Date, "now").mockReturnValue(futureNow);
          try {
            expect(
              await dispatch("reviewer-device", { ...report, id: lateRecord.id }),
            ).toMatchObject({
              ok: true,
              payload: { reported: true },
            });
            expect(sent[2]?.message).toBe(
              `Approval ${lateRecord.id} was denied. The requested action did not run.`,
            );
            runtime.close();
            nowSpy.mockReturnValue(futureNow + 16_000);
            expect(aux.pluginApprovalManager.getLocalSnapshot(lateRecord.id)).toBeNull();
          } finally {
            nowSpy.mockRestore();
          }
          currentConfig = {
            channels: { slack: { accounts: { work: { botToken: "replacement-token" } } } },
          };
          expect(guards).toHaveLength(3);
          expect(guards.every((guard) => !guard(currentConfig))).toBe(true);
        } finally {
          await reporter.stop();
          await aux.stopOperatorInteractions();
          runtime.close();
        }
      },
    );
  });
});
