// Release-tier proof: real self-send, cold Gateway processes, and real exec effects.
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../src/state/user-profile-writes.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "./helpers/tls-fixture.js";

const MODEL = "restart-proof/restart-proof";
const EMAIL = "restart-proof@example.test";
const CONTINUATION = "COLD_SELF_CONTINUATION";

// This proof kills a POSIX process group; it does not claim Windows process-lifecycle coverage.
it.skipIf(process.platform === "win32").each(["allowed", "revoked"] as const)(
  "revalidates original self-send authority through cold restart before final I/O: %s",
  { timeout: 300_000 },
  async (outcome) => {
    let sessionKey = "";
    let effectPath = "";
    let phase: "original" | "interrupted" | "restarted" = "original";
    let originalCalls = 0;
    let resumedCalls = 0;
    let held = false;
    const failures: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        if (phase === "original") {
          originalCalls += 1;
          if (originalCalls === 1) {
            tool(response, "self-send", "sessions_send", {
              sessionKey,
              message: CONTINUATION,
              timeoutSeconds: 0,
            });
          } else {
            phase = "interrupted";
            writeOpenAiResponsesText(response, {
              text: "Original turn settled.",
              messageId: "original-final",
              responseId: "original-done",
            });
          }
        } else if (phase === "interrupted") {
          expect(body).toContain(CONTINUATION);
          held = true;
          // Keep the actual continuation provider socket open until its Gateway is killed.
        } else {
          resumedCalls += 1;
          expect(body).toContain(CONTINUATION);
          if (resumedCalls === 1) {
            tool(response, "final-effect", "exec", {
              command: "printf 'RECOVERED_ONCE\n' >> " + JSON.stringify(effectPath),
            });
          } else {
            expect(body).toContain("final-effect");
            writeOpenAiResponsesText(response, {
              text: "COLD_RECOVERY_DONE",
              messageId: "recovered-final",
              responseId: "recovered-done",
            });
          }
        }
      })().catch((error: unknown) => {
        failures.push(String(error));
        response.writeHead(500).end("proof provider failure");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const closeProvider = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    };
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing provider address");
    }
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          heartbeat: { every: "0m" },
          model: { primary: MODEL },
          models: { [MODEL]: { agentRuntime: { id: "openclaw" } } },
          skipBootstrap: true,
          skills: [],
          timeoutSeconds: 180,
        },
      },
      tools: {
        profile: "coding",
        codeMode: false,
        toolSearch: false,
        allow: ["sessions_send", "exec"],
        exec: { security: "full", ask: "off" },
      },
      gateway: {
        roles: {
          default: "proof-writer",
          definitions: {
            "proof-writer": {
              agents: "*",
              sessions: { others: "write" },
              scopes: ["operator.read", "operator.write"],
            },
            "revoked-proof-role": { agents: [], sessions: { others: "none" }, scopes: [] },
          },
        },
        auth: {
          mode: "trusted-proxy",
          // The shared instance helper seeds token auth; this fixture uses proxy auth only.
          token: undefined,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowUsers: [EMAIL],
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
          },
        },
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: ["https://restart-proof.example.test"] },
      },
      models: {
        mode: "replace",
        providers: {
          "restart-proof": {
            baseUrl: "http://127.0.0.1:" + address.port + "/v1",
            apiKey: "synthetic-proof-key",
            api: "openai-responses",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "restart-proof",
                name: "restart-proof",
                reasoning: false,
                input: ["text"],
                contextWindow: 128_000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    const instance = await createOpenClawTestInstance({
      name: "self-continuation-cold-" + outcome,
      config: cfg,
      // This focused suite owns exact-source processes, not package/build validation.
      entrypoint: ["--import", "./scripts/tsx.mjs", "src/entry.ts"],
      env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
    }).catch(async (error: unknown) => {
      await closeProvider();
      throw error;
    });
    let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
    let proxy: Awaited<ReturnType<typeof startTlsProxy>> | undefined;
    const connect = (url: string) =>
      acquireGatewayTestClient(
        {
          url,
          tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
          deviceIdentity: loadOrCreateDeviceIdentity({ env: instance.env }),
          clientName: "openclaw-control-ui",
          mode: "webchat",
          origin: "https://restart-proof.example.test",
          scopes: ["operator.read", "operator.write"],
          edgeAuthHeaders: {
            "x-forwarded-for": "203.0.113.10",
            "x-forwarded-proto": "https",
            "x-forwarded-user": EMAIL,
          },
          env: instance.env,
        },
        {
          timeoutMs: 30_000,
          timeoutMessage: "Proof connect timed out",
          closeMessage: "Proof connect closed",
        },
      );
    await runQaGatewayFixture(
      async () => {
        try {
          instance.state.applyEnv();
          effectPath = path.join(instance.state.workspaceDir, "cold-effect.txt");
          await instance.startGateway();
          proxy = await startTlsProxy(instance.port);
          client = await connect(proxy.url);
          const created = await client.request<{ key: string; sessionId: string }>(
            "sessions.create",
            {
              agentId: "main",
              label: "Cold self-continuation " + outcome,
            },
          );
          sessionKey = created.key;
          const scope = {
            agentId: "main",
            sessionKey,
            storePath: instance.state.statePath("agents", "main", "sessions", "sessions.json"),
          };
          await client.request("agent", {
            sessionKey,
            message: "Queue one self-continuation, then finish this turn.",
            idempotencyKey: randomUUID(),
            deliver: false,
          });
          await vi.waitFor(
            () => {
              expect(failures).toEqual([]);
              expect(held).toBe(true);
            },
            { timeout: 60_000 },
          );
          const accepted = loadSessionEntry(scope);
          expect(accepted?.sessionId).toBe(created.sessionId);
          expect(accepted?.restartRecoveryRequester).toMatchObject({
            sessionKey,
            sessionId: created.sessionId,
          });
          expect(originalCalls).toBe(2);
          await client.stopAndWait();
          client = undefined;
          const gatewayChild = instance.child;
          if (!gatewayChild?.pid) {
            throw new Error("Missing owned Gateway process");
          }
          const originalPid = gatewayChild.pid;
          const killed = new Promise<void>((resolve) => {
            gatewayChild.once("exit", () => resolve());
          });
          process.kill(-originalPid, "SIGKILL");
          await killed;
          await instance.stopGateway();
          server.closeAllConnections();
          if (outcome === "revoked") {
            const profile = await ensureCanonicalUserProfileForEmail(EMAIL);
            expect(profile.id).toBe(accepted?.restartRecoveryRequester?.profileId);
            await setCanonicalUserProfileRole(profile.id, "revoked-proof-role");
          }
          phase = "restarted";
          await instance.startGateway();
          expect(instance.child?.pid).not.toBe(originalPid);
          // No browser reconnect, chat.send, agent, or sessions.recover after cold start.
          if (outcome === "allowed") {
            await vi.waitFor(
              async () => expect(await fs.readFile(effectPath, "utf8")).toBe("RECOVERED_ONCE\n"),
              { timeout: 60_000 },
            );
            await vi.waitFor(() => expect(loadSessionEntry(scope)?.status).toBe("done"), {
              timeout: 30_000,
            });
            expect(resumedCalls).toBe(2);
          } else {
            await vi.waitFor(
              () =>
                expect(loadSessionEntry(scope)?.mainRestartRecovery?.tombstone).toMatchObject({
                  reason: "original continuation requester authority is unavailable",
                }),
              { timeout: 60_000 },
            );
            expect(resumedCalls).toBe(0);
            await expect(fs.stat(effectPath)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(loadSessionEntry(scope)?.sessionId).toBe(created.sessionId);
          expect(failures).toEqual([]);
          console.info(
            "COLD_RESTART_PROOF",
            JSON.stringify({
              outcome,
              originalCalls,
              resumedCalls,
              sameSessionId: true,
              browserAbsentAfterRestart: true,
              finalEffect: outcome === "allowed",
            }),
          );
        } catch (error) {
          throw new Error(String(error) + "\nGateway: " + instance.logs(), { cause: error });
        }
      },
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      closeProvider,
      () => proxy?.close(),
    );
  },
);

function tool(response: ServerResponse, id: string, name: string, args: unknown) {
  const item = {
    type: "function_call",
    id: "fc_" + id,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

// Terminate real TLS at the trusted proxy boundary; never disable the client’s edge-auth guard.
async function startTlsProxy(targetPort: number) {
  const server = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", track);
  server.on("upgrade", (request, downstream, head) => {
    const upstream = connectTcp(targetPort, "127.0.0.1", () => {
      const headers: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headers.push(request.rawHeaders[index] + ": " + request.rawHeaders[index + 1]);
      }
      upstream.write(
        request.method +
          " " +
          request.url +
          " HTTP/" +
          request.httpVersion +
          "\r\n" +
          headers.join("\r\n") +
          "\r\n\r\n",
      );
      upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    track(upstream);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing TLS proxy address");
  }
  return {
    url: "wss://127.0.0.1:" + address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
