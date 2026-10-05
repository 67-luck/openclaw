import { expect, it, vi } from "vitest";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import {
  consumeGatewaySuspendHandoff,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { markGatewayRestartDraining } from "../process/gateway-work-admission.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import type { handleGatewayRequest } from "./server-methods.js";
import { dispatchSuspensionRequest as dispatch } from "./server-methods.suspension-admission.test-support.js";
import { suspendHandlers } from "./server-methods/suspend.js";

export function registerSuspensionHandoffAuthorizationTests() {
  it.each([
    "armed",
    "committed",
    "unsupported-commit",
    "read-scope",
    "other-pid",
    "new-process-same-pid",
    "retired-host",
  ])("binds an external handoff to the authenticated live owner: %s", async (mode) => {
    const host = createGatewayHostLifecycle({
      processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
      isCurrent: () => true,
      isServing: () => true,
      acceptStop: () => {},
      commitExternalStop:
        mode === "committed"
          ? () => {
              const handoff = consumeGatewaySuspendHandoff(host.capability.externalRestart);
              if (!handoff.ok || !handoff.value) {
                throw new Error("Missing current suspension handoff");
              }
              markGatewayRestartDraining("stop (SIGTERM)");
            }
          : undefined,
    });
    const lease = prepareGatewaySuspend({
      requestId: "handoff-route",
      drain: true,
      pauseScheduling: () => {},
      resumeScheduling: () => {},
      inspect: { getRootRequests: () => 1, getTerminalPersistence: () => 0 },
    });
    if (lease.status !== "draining") {
      throw new Error("expected a held drain");
    }
    try {
      const result = dispatch({
        method: "gateway.suspend.handoff",
        scope: "operator.admin",
        core: true,
        clientScopes: [mode === "read-scope" ? "operator.read" : "operator.admin"],
        handler: suspendHandlers["gateway.suspend.handoff"]!,
        requestParams: {
          suspensionId: lease.suspensionId,
          ...(["committed", "unsupported-commit"].includes(mode) ? { commit: true } : {}),
          target: {
            pid: mode === "other-pid" ? process.pid + 1 : process.pid,
            processInstanceId:
              mode === "new-process-same-pid" ? "different-process" : getGatewayProcessInstanceId(),
          },
        },
        context: {
          hostLifecycle: host.capability,
          logGateway: { warn: vi.fn() },
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      });
      // The request has crossed an async dispatch boundary, but the original
      // host must still own its iteration when the synchronous handler commits.
      if (mode === "retired-host") {
        await host.retire();
      }
      await result.request;
      if (mode === "armed") {
        expect(result.respond).toHaveBeenCalledWith(true, {
          status: "armed",
          suspensionId: lease.suspensionId,
          expiresAtMs: lease.expiresAtMs,
        });
        expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
          ok: true,
          value: true,
        });
      } else if (mode === "committed") {
        expect(result.respond).toHaveBeenCalledWith(true, {
          status: "committed",
          suspensionId: lease.suspensionId,
          expiresAtMs: lease.expiresAtMs,
        });
        expect(resumeGatewaySuspend(lease.suspensionId)).toEqual({
          ok: false,
          reason: "gateway-restarting",
        });
        expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
          ok: true,
          value: false,
        });
      } else {
        expect(result.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
        expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
          ok: true,
          value: false,
        });
      }
    } finally {
      await host.retire();
      resumeGatewaySuspend(lease.suspensionId);
    }
  });
}
