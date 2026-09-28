import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

describe("Gateway-owned remote plugin approval requester notice", () => {
  it("reports pending and denial through the source account without trusting a remote client", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "remote-plugin-approval-notice-" },
      async () => {
        const configForToken = (botToken: string): OpenClawConfig => ({
          channels: { slack: { accounts: { work: { botToken } } } },
        });
        const sourceConfig = configForToken("xoxb-original");
        let currentConfig = sourceConfig;
        const posts: Array<{ text: string; token: unknown }> = [];
        const pendingPosted = createDeferred();
        const deniedPosted = createDeferred();
        const staleHandoff = createDeferred();
        const noticeFailed = createDeferred();
        const sendText = vi.fn(
          async (options: {
            text: string;
            cfg: OpenClawConfig;
            onPlatformSendDispatch?: () => Promise<void>;
            assertDirectAdapterHandoff?: () => void;
          }) => {
            if (options.text.includes("plugin:stale-source")) {
              currentConfig = configForToken("xoxb-replacement");
              staleHandoff.resolve();
            }
            await options.onPlatformSendDispatch?.();
            options.assertDirectAdapterHandoff?.();
            posts.push({
              text: options.text,
              token: options.cfg.channels?.slack?.accounts?.work?.botToken,
            });
            if (options.text.includes("was denied")) {
              deniedPosted.resolve();
            } else {
              pendingPosted.resolve();
            }
            return { channel: "slack", messageId: `1712345678.${posts.length}` };
          },
        );
        const plugin: ChannelPlugin = {
          id: "slack",
          meta: {
            id: "slack",
            label: "Slack",
            selectionLabel: "Slack",
            docsPath: "/channels/slack",
            blurb: "Slack-shaped approval test plugin.",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => ["work"],
            resolveAccount: () => ({}),
            isConfigured: () => true,
          },
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
            sendText,
          },
        };
        const registrySnapshot = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(
          createTestRegistry([{ pluginId: "slack", source: "test", plugin }]),
          null,
          "default",
        );
        const errors: string[] = [];
        const context = {
          trackExecution: trackAsyncWork,
          deps: {},
          getRuntimeConfig: () => currentConfig,
          logGateway: { warn: vi.fn(), error: vi.fn() },
          chatAbortControllers: new Map(),
          chatQueuedTurns: new Map(),
          dedupe: new Map(),
        } as unknown as GatewayRequestContext;
        const runtime = createGatewayInstanceRuntime({
          getContext: () => context,
          getMethodRegistry: () => {
            throw new Error("source notice must not use a public Gateway RPC");
          },
          isDispatchAvailable: () => true,
          logError: (message) => {
            errors.push(message);
            if (message.includes("plugin approval origin notice failed")) {
              noticeFailed.resolve();
            }
          },
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
        const reporter = runtime.nativeApprovals.routeCoordinator.createReporter({
          handledKinds: new Set(["plugin"]),
          channel: "slack",
          accountId: "work",
          sourceConfig,
          isOriginCurrent: (_request, cfg) =>
            currentConfig.channels?.slack?.accounts?.work?.botToken === "xoxb-original" &&
            (cfg === undefined || cfg === sourceConfig),
          requestGateway: runtime.nativeApprovals.requestRoute,
          shouldHandle: () => false,
          classifyRoute: () => "unbound",
        });
        const publish = async (id: string): Promise<PluginApprovalRequest> => {
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
            id,
          );
          await aux.pluginApprovalManager.register(record, 60_000);
          const request: PluginApprovalRequest = {
            approvalKind: "plugin",
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          };
          expect(runtime.approvalEvents.publishRequested("plugin", request)).toBe(0);
          return request;
        };

        try {
          reporter.start();
          const request = await publish("plugin:remote-source");
          await pendingPosted.promise;
          expect(posts).toEqual([
            {
              text: `Approval ${request.id} required. An approver can review it in the Control UI or terminal UI.`,
              token: "xoxb-original",
            },
          ]);
          expect(posts[0]?.text).not.toMatch(/sent|delivered|DMs/i);
          await aux.pluginApprovalManager.resolve(request.id, "deny");
          runtime.approvalEvents.publishResolved("plugin", {
            id: request.id,
            decision: "deny",
            ts: Date.now(),
            request: request.request,
          });
          await deniedPosted.promise;
          expect(posts[1]).toEqual({
            text: `Approval ${request.id} was denied. The requested action did not run.`,
            token: "xoxb-original",
          });
          expect(errors).toEqual([]);

          const stale = await publish("plugin:stale-source");
          await staleHandoff.promise;
          await noticeFailed.promise;
          expect(
            errors.some((message) => message.includes("plugin approval origin notice failed")),
          ).toBe(true);
          expect(posts).toHaveLength(2);
          expect(await findDeliveryIntentOwner(`approval-route-notice:${stale.id}`)).toBeNull();
          await runtime.nativeApprovals.routeCoordinator
            .publishPluginTerminal({ approvalId: stale.id, status: "denied" })
            .catch(() => undefined);
          expect(posts).toHaveLength(2);
        } finally {
          await reporter.stop();
          await aux.stopOperatorInteractions();
          runtime.close();
          restoreActivePluginRegistrySnapshot(registrySnapshot);
        }
      },
    );
  });
});
