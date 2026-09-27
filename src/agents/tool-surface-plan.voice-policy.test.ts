import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../gateway/device-revocation.js";
import { sharingPolicyClient } from "../gateway/session-sharing.test-utils.js";
import { captureTalkVoiceOrigin } from "../gateway/talk/client-voice-origin.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCodeModeTools } from "./code-mode.js";
import { createToolSearchCatalogRef, clearToolSearchCatalog } from "./tool-search.js";
import { applyAgentToolSurfaceCatalog, resolveAgentToolSurfacePlan } from "./tool-surface-plan.js";
import { createNodesTool } from "./tools/nodes-tool.js";

const config: OpenClawConfig = {
  tools: { codeMode: true },
  talk: {
    realtime: {
      appLaunchPolicies: [
        {
          id: "calculator",
          agentId: "main",
          originatingDeviceId: "widget",
          nodeId: "node",
          appId: "linux-desktop:calculator.desktop",
          appRevision: "a".repeat(64),
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
      ],
    },
  },
};

const catalogs: ReturnType<typeof createToolSearchCatalogRef>[] = [];
afterEach(() => {
  clientVoiceSessionTesting.reset();
  for (const catalogRef of catalogs.splice(0)) {
    clearToolSearchCatalog({ catalogRef });
  }
});
describe("Talk app policies and the Nodes catalog", () => {
  it("keeps Nodes searchable in an unrelated Code Mode session", () => {
    const catalogRef = createToolSearchCatalogRef();
    catalogs.push(catalogRef);
    const ctx = {
      config,
      agentId: "other",
      sessionKey: "agent:other:unrelated",
      runId: "unrelated",
      catalogRef,
    };
    const plan = resolveAgentToolSurfacePlan({
      ...ctx,
      forceDirectMessageTool: false,
      toolsEnabled: true,
      isRawModelRun: false,
    });
    const nodes = createNodesTool({ config, agentId: "other" });
    const result = applyAgentToolSurfaceCatalog({
      ...ctx,
      ...plan,
      forceDirectMessageTool: false,
      tools: [...createCodeModeTools(ctx), nodes],
    });
    expect(catalogRef.current?.entries.some((entry) => entry.id === "openclaw:core:nodes")).toBe(
      true,
    );
    expect(result.tools.some((tool) => tool.name === "nodes")).toBe(false);
  });
  it.each(["matching", "other-device", "revoked", "expired"] as const)(
    "keeps %s voice Nodes searchable with source-scoped direct visibility",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = {};
        const deviceId = mode === "other-device" ? "other" : "widget";
        const capture = captureGatewayDeviceRevocation(context, { deviceId }, () => true);
        const origin = captureTalkVoiceOrigin({
          client: { ...sharingPolicyClient({ deviceId }), isDeviceTokenAuth: true },
          hasCurrentClientAuthority: capture.isCurrent,
        });
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:voice",
          origin: "client" as const,
        };
        const voiceSessionId = createOrResumeClientVoiceSession(scope);
        const dispose = registerClientVoiceConsultRun({
          ...scope,
          voiceSessionId,
          runId: "voice",
          originAuthority: origin,
        });
        try {
          if (mode === "revoked") {
            invalidateGatewayDeviceRevocation(context, deviceId);
          }
          const selected = structuredClone(config);
          if (mode === "expired") {
            selected.talk!.realtime!.appLaunchPolicies![0]!.expiresAtMs = 1;
          }
          const catalogRef = createToolSearchCatalogRef();
          catalogs.push(catalogRef);
          const ctx = {
            config: selected,
            agentId: "main",
            sessionKey: scope.sessionKey,
            runId: "voice",
            catalogRef,
          };
          const plan = resolveAgentToolSurfacePlan({
            ...ctx,
            forceDirectMessageTool: false,
            toolsEnabled: true,
            isRawModelRun: false,
          });
          const result = applyAgentToolSurfaceCatalog({
            ...ctx,
            ...plan,
            forceDirectMessageTool: false,
            tools: [
              ...createCodeModeTools(ctx),
              createNodesTool({ config: selected, agentId: "main" }),
            ],
          });
          expect(
            catalogRef.current?.entries.some((entry) => entry.id === "openclaw:core:nodes"),
          ).toBe(true);
          expect(result.tools.some((tool) => tool.name === "nodes")).toBe(mode === "matching");
        } finally {
          dispose();
          origin?.release();
          capture.release();
        }
      });
    },
  );
});
