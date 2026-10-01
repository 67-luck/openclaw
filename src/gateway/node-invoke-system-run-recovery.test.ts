import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import { buildNodeSystemRunInvoke } from "../agents/bash-tools.exec-host-node-phases.js";
import { buildExecFinishedEventPayload } from "../node-host/invoke-exec-finished-event.js";
import {
  publishSystemRunCompletion,
  resolveSystemRunNotifyOnExit,
} from "../node-host/invoke-system-run-completion.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";
import {
  NodeSystemRunEventAuthority,
  shouldSuppressRun,
} from "./node-system-run-event-authority.js";

test.each([true, false])(
  "preserves sanitized recovery eligibility and opt-out (notify=%s)",
  async (notifyOnExit) => {
    const sessionKey = "agent:main:telegram:group:-100123:topic:42";
    const runId = "sanitized-recovery";
    const route = {
      channel: "telegram",
      to: "-100123:topic:42",
      accountId: "work",
      threadId: "42",
    };
    const invoke = buildNodeSystemRunInvoke({
      target: {
        nodeId: "node",
        argv: ["printf", "RECOVERY"],
        env: undefined,
        invokeDeadlineMs: 1000,
        invokeWaitMs: 1000,
        runTimeoutMs: 1000,
        supportsSystemRunPrepare: true,
        supportsResultFirstCompletion: true,
      },
      command: ["printf", "RECOVERY"],
      rawCommand: "printf RECOVERY",
      cwd: undefined,
      agentId: "main",
      sessionKey,
      runId,
      suppressNotifyOnExit: true,
      notifyOnExit,
    });
    const forwarded = await sanitizeSystemRunParamsForForwarding({
      nodeId: "node",
      rawParams: invoke.params,
      client: null,
    });
    if (!forwarded.ok) {
      throw new Error(forwarded.message);
    }
    const params = asOptionalRecord(forwarded.params);
    const owner = new NodeSystemRunEventAuthority();
    owner.remember({
      nodeId: "node",
      connId: "conn",
      runId,
      sessionKey,
      invocationDeliveryContext: route,
    });
    let suppressed: boolean | undefined;
    await publishSystemRunCompletion(
      {
        sendInvokeResult: async () => {
          throw new Error("lost invoke reply");
        },
        sendExecFinishedEvent: async (event) => {
          const authorization = owner.authorize({
            nodeId: "node",
            connId: "conn",
            runId,
            sessionKey,
            terminal: true,
            allowLegacyRunIdFallback: false,
          });
          suppressed = shouldSuppressRun(
            buildExecFinishedEventPayload(event),
            authorization,
            route,
            undefined,
          );
        },
      },
      {
        sessionKey,
        runId,
        commandText: "printf RECOVERY",
        suppressNotifyOnExit: params?.suppressNotifyOnExit === true,
        notifyOnExit: resolveSystemRunNotifyOnExit({
          suppressNotifyOnExit: params?.suppressNotifyOnExit === true,
          notifyOnExit: typeof params?.notifyOnExit === "boolean" ? params.notifyOnExit : undefined,
        }),
      },
      { stdout: "RECOVERY", stderr: "", exitCode: 0, timedOut: false, success: true },
      '{"stdout":"RECOVERY"}',
    );
    expect(suppressed).toBe(!notifyOnExit);
  },
);
