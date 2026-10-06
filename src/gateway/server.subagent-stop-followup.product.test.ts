// Prove exact-run Stop followed by a kept-child follow-up through real Gateway tools.
import { X509Certificate } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import {
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  buildSubagentStopConfig,
  subagentStopProxyHeaders,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const parentPrompt = "Run the exact Stop then kept-child follow-up proof.";
const stoppedTask = "Hold this first child execution until it is stopped.";
const followupTask = "Finish this successor execution with the required success marker.";
const stoppedResult = "STOPPED_RUN_MUST_NOT_DELIVER";
const successorResult = "AFTER_STOP_OK";
const proxyUser = "subagent-stop-administrator@example.test";

function toolCallEvents(name: string, args: Record<string, unknown>, sequence: number) {
  const responseId = `resp_stop_followup_${sequence}`;
  const itemId = `fc_stop_followup_${sequence}`;
  const callId = `call_stop_followup_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsText,
  };
  return [
    {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
}

function findRecord(
  value: unknown,
  matches: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return findRecord(JSON.parse(value) as unknown, matches);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const matched = findRecord(item, matches);
      if (matched) {
        return matched;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (matches(record)) {
    return record;
  }
  for (const item of Object.values(record)) {
    const matched = findRecord(item, matches);
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return body;
}

async function startStopFollowupModel() {
  const firstChildStarted = createDeferred();
  const firstChildStopped = createDeferred();
  const successorAccepted = createDeferred<string>();
  const allowParentYield = createDeferred();
  const completionDelivered = createDeferred();
  const requests: string[] = [];
  let parentRequestCount = 0;
  let responseSequence = 0;
  let successorDeliveries = 0;
  let stoppedDeliveries = 0;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "stop-proof", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequestBody(request);
    requests.push(body);
    responseSequence += 1;
    if (!body.includes(parentPrompt)) {
      // A follow-up to the kept child starts a distinct successor execution.
      if (body.includes(followupTask)) {
        writeOpenAiResponsesText(response, {
          text: successorResult,
          messageId: "stop_followup_successor",
          responseId: "stop_followup_successor_response",
        });
        return;
      }
      // The stopped execution attempts a late result after its transport is cancelled.
      if (body.includes(stoppedTask)) {
        firstChildStarted.resolve();
        request.once("aborted", () => firstChildStopped.resolve());
        response.once("close", () => firstChildStopped.resolve());
        await firstChildStopped.promise;
        writeOpenAiResponsesText(response, {
          text: stoppedResult,
          messageId: "stopped_child_late_result",
          responseId: "stopped_child_late_result_response",
        });
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "NO_REPLY",
        messageId: `fallback_${responseSequence}`,
        responseId: `fallback_response_${responseSequence}`,
      });
      return;
    }

    // Completion reaches the requester through a fresh delivery-only agent turn.
    if (body.includes(successorResult)) {
      successorDeliveries += 1;
      writeOpenAiResponsesText(response, {
        text: "PARENT_RECEIVED_SUCCESSOR",
        messageId: `successor_delivery_${responseSequence}`,
        responseId: `successor_delivery_response_${responseSequence}`,
      });
      completionDelivered.resolve();
      return;
    }
    if (body.includes(stoppedResult)) {
      stoppedDeliveries += 1;
      writeOpenAiResponsesText(response, {
        text: "NO_REPLY",
        messageId: `stopped_delivery_${responseSequence}`,
        responseId: `stopped_delivery_response_${responseSequence}`,
      });
      return;
    }

    parentRequestCount += 1;
    if (parentRequestCount === 1) {
      writeOpenAiResponsesSse(
        response,
        toolCallEvents(
          "sessions_spawn",
          {
            task: stoppedTask,
            context: "isolated",
            cleanup: "keep",
            completionTarget: "parent",
          },
          responseSequence,
        ),
      );
      return;
    }
    const parsed = JSON.parse(body) as unknown;
    const child = findRecord(
      parsed,
      (record) => typeof record.childSessionKey === "string" && typeof record.runId === "string",
    );
    if (!child) {
      throw new Error("Parent transport did not retain the child spawn receipt");
    }
    const childSessionKey = child.childSessionKey as string;
    const childRunId = child.runId as string;
    if (parentRequestCount === 2) {
      await firstChildStarted.promise;
      writeOpenAiResponsesSse(
        response,
        toolCallEvents(
          "sessions",
          { action: "stop", sessionKey: childSessionKey, runId: childRunId },
          responseSequence,
        ),
      );
      return;
    }
    if (parentRequestCount === 3) {
      writeOpenAiResponsesSse(
        response,
        toolCallEvents(
          "sessions_send",
          {
            sessionKey: childSessionKey,
            mode: "followup",
            timeoutSeconds: 0,
            message: followupTask,
          },
          responseSequence,
        ),
      );
      return;
    }
    if (parentRequestCount === 4) {
      const followup = findRecord(
        parsed,
        (record) =>
          record.status === "accepted" &&
          record.targetDisposition === "queued" &&
          typeof record.runId === "string",
      );
      if (!followup) {
        throw new Error("Parent transport did not retain the queued follow-up receipt");
      }
      successorAccepted.resolve(followup.runId as string);
      await allowParentYield.promise;
      writeOpenAiResponsesSse(
        response,
        toolCallEvents("sessions_yield", { waitFor: "message" }, responseSequence),
      );
      return;
    }
    writeOpenAiResponsesText(response, {
      text: "NO_REPLY",
      messageId: `parent_fallback_${responseSequence}`,
      responseId: `parent_fallback_response_${responseSequence}`,
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    firstChildStarted: firstChildStarted.promise,
    successorAccepted: successorAccepted.promise,
    completionDelivered: completionDelivered.promise,
    allowParentYield: () => allowParentYield.resolve(),
    deliveryCounts: () => ({ successorDeliveries, stoppedDeliveries }),
    requests,
    close: async () => {
      allowParentYield.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
});

it("delivers exactly one kept-child successor after exact-run Stop", async () => {
  const model = await startStopFollowupModel();
  const state = await createOpenClawTestState({ label: "subagent-stop-followup" });
  setUserProfileRole(ensureProfileForEmail(proxyUser).id, "administrator");
  const cfg = buildSubagentStopConfig(state.workspaceDir, {
    certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
    keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
  });
  const provider = cfg.models?.providers?.synthetic;
  if (!provider) {
    throw new Error("Missing synthetic model provider");
  }
  provider.baseUrl = model.url;
  provider.request = { allowPrivateNetwork: true };
  const parentRunId = "subagent-stop-followup-parent";
  const gateway = await startGatewayWithClient({
    cfg,
    configPath: state.configPath,
    auth: cfg.gateway?.auth,
    edgeAuthHeaders: subagentStopProxyHeaders,
    secure: true,
    tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    origin: "https://control.example.com",
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
  let stopObserving = () => {};
  try {
    await gateway.server.startupSettled;
    await expect(
      gateway.client.request("chat.send", {
        sessionKey: "agent:main:subagent-stop-followup-parent",
        message: parentPrompt,
        idempotencyKey: parentRunId,
        deliver: false,
      }),
    ).resolves.toMatchObject({ runId: parentRunId, status: "started" });
    await model.firstChildStarted;
    const successorRunId = await model.successorAccepted;
    await expect(
      gateway.client.request("agent.wait", { runId: successorRunId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });
    model.allowParentYield();
    const parentOutcome = await gateway.client.request<Record<string, unknown>>("agent.wait", {
      runId: parentRunId,
      timeoutMs: 30_000,
    });
    if (parentOutcome.status !== "ok") {
      const successor = getSubagentRunByRunId(successorRunId);
      throw new Error(
        `Requester wait failed with successor delivery=${successor?.delivery?.status ?? "missing"}: ${JSON.stringify(parentOutcome)}`,
      );
    }

    const delivered = createDeferred();
    const observeDelivery = () => {
      const current = getSubagentRunByRunId(successorRunId);
      if (current?.delivery?.status === "delivered") {
        delivered.resolve();
      }
    };
    stopObserving = subscribeSubagentRunChanges("persistence", observeDelivery);
    observeDelivery();
    await model.completionDelivered;
    await delivered.promise;
    expect(model.deliveryCounts()).toEqual({ successorDeliveries: 1, stoppedDeliveries: 0 });
    expect(model.requests.filter((body) => body.includes(successorResult))).toHaveLength(1);
    expect(model.requests.some((body) => body.includes(stoppedResult))).toBe(false);
  } finally {
    stopObserving();
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "subagent stop follow-up proof complete" });
    await model.close();
    await state.cleanup();
  }
});
