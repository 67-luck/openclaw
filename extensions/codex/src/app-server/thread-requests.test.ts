import { describe, expect, it } from "vitest";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";

describe("Codex blocking question ownership", () => {
  it.each(["direct", "deferred", "namespaced"] as const)(
    "uses OpenClaw's %s ask_user instead of native blocking questions on start and resume",
    (exposure) => {
      const askUser: CodexDynamicToolFunctionSpec = {
        type: "function",
        name: "ask_user",
        description: "Ask the user a question.",
        inputSchema: { type: "object" },
        ...(exposure === "deferred" ? { deferLoading: true } : {}),
      };
      const dynamicTools: CodexDynamicToolSpec[] =
        exposure === "namespaced"
          ? [
              {
                type: "namespace",
                name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
                description: "",
                tools: [askUser],
              },
            ]
          : [askUser];
      const params = createAttemptParams({ provider: "openai" });
      const options = {
        cwd: "/repo",
        dynamicTools,
        appServer: createAppServerOptions(),
        developerInstructions: "test instructions",
        nativeCodeModeEnabled: exposure !== "direct",
        nativeCodeModeOnlyEnabled: exposure !== "direct",
        config: {
          "tools.experimental_request_user_input.enabled": true,
          mcp_servers: { local_docs: { command: "node", args: ["/opt/docs-mcp.js"] } },
        },
      };

      const start = buildThreadStartParams(params, options);
      const resume = buildThreadResumeParams(params, { ...options, threadId: "thread-1" });
      for (const request of [start, resume]) {
        expect(request.config?.["tools.experimental_request_user_input.enabled"]).toBe(false);
        expect(request.config?.mcp_servers).toEqual(options.config.mcp_servers);
      }
      expect(start.dynamicTools).toEqual(dynamicTools);
    },
  );

  it.each([undefined, true, false])(
    "preserves native blocking question configuration %s when ask_user is absent",
    (enabled) => {
      const params = createAttemptParams({ provider: "openai" });
      const options = {
        cwd: "/repo",
        dynamicTools: [
          {
            type: "function" as const,
            name: "message",
            description: "Send a message.",
            inputSchema: { type: "object" },
          },
        ],
        appServer: createAppServerOptions(),
        developerInstructions: "test instructions",
        config:
          enabled === undefined
            ? undefined
            : { "tools.experimental_request_user_input.enabled": enabled },
      };

      const start = buildThreadStartParams(params, options);
      const resume = buildThreadResumeParams(params, { ...options, threadId: "thread-1" });
      for (const request of [start, resume]) {
        expect(request.config?.["tools.experimental_request_user_input.enabled"]).toBe(enabled);
      }
    },
  );
});
