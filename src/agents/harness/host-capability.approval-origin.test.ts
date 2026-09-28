import { afterEach, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { runBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));

afterEach(() => {
  resetAgentRunRegistryForTest();
  vi.clearAllMocks();
});

it("retains requester context through harness tool hooks", async () => {
  const approvalSource = {
    channel: "slack",
    senderId: "U123",
    conversationKind: "direct" as const,
  };
  const fixture = await createAdmittedHostCapabilityTestFixture({
    runId: "approval-source",
    agentId: "main",
    sessionKey: "agent:main:approval-thread",
    messageChannel: "slack",
    currentThreadTs: "1700000001.000002",
    approvalSource,
  });
  try {
    vi.mocked(runBeforeToolCallHook).mockImplementationOnce(async ({ ctx, params }) => {
      expect(ctx?.turnSourceThreadId).toBe("1700000001.000002");
      expect(getGatewayToolCallerIdentity()?.approvalSource).toEqual(approvalSource);
      return { blocked: false, params };
    });
    await fixture.hostCapabilities.runBeforeToolCall({ toolName: "read", params: {} });
    expect(runBeforeToolCallHook).toHaveBeenCalledTimes(1);
  } finally {
    fixture.closeHost();
    fixture.closeAdmission();
  }
});
