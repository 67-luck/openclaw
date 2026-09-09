import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  PROTOCOL_VERSION,
  type RequestFrame,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../infra/device-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { buildDeviceAuthPayloadV3 } from "../device-auth.js";
import { issueOperatorToken } from "../device-authz.test-helpers.js";
import * as hooks from "../hooks.js";
import { createGatewayOperatorHttpRuntime } from "../operator-http.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { createGatewayHttpServer } from "../server-http.js";
import * as lazyHandlers from "../server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandler } from "../server-methods/types.js";
import {
  installGatewayTestHooks,
  rpcReq,
  startConnectedServerWithClient,
} from "../test-helpers.js";
import type {
  OperatorHttpBeginResponse,
  OperatorHttpPollResponse,
} from "./operator-http-contract.js";
import { createPreauthConnectionBudget } from "./preauth-connection-budget.js";
import * as preauthBudget from "./preauth-connection-budget.js";
import type { GatewayWsClient } from "./ws-types.js";

installGatewayTestHooks({ scope: "suite" });
await import("../server.js");

describe("paired operator HTTP transport", () => {
  let started: Awaited<ReturnType<typeof startConnectedServerWithClient>>;
  const connections = new Set<OperatorHttpBeginResponse>();
  const client = {
    id: GATEWAY_CLIENT_IDS.TEST,
    mode: GATEWAY_CLIENT_MODES.TEST,
    version: "test",
    platform: "test",
  };
  const responseSchema = z.object({
    type: z.literal("res"),
    id: z.string(),
    ok: z.boolean(),
    payload: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
  });
  beforeAll(async () => {
    const budget = createPreauthConnectionBudget(1);
    const factory = vi
      .spyOn(preauthBudget, "createPreauthConnectionBudget")
      .mockReturnValueOnce(budget);
    try {
      started = await startConnectedServerWithClient("secret");
    } finally {
      factory.mockRestore();
    }
  });
  afterEach(async () => {
    await Promise.all(
      [...connections].map((connection) => exchange(connection, "", undefined, "DELETE")),
    );
    connections.clear();
  });
  afterAll(async () => {
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  });

  function exchange(
    connection: OperatorHttpBeginResponse | undefined,
    suffix: string,
    body?: unknown,
    method = "POST",
    headers?: Record<string, string>,
    signal = AbortSignal.timeout(10_000),
  ) {
    const base = `http://127.0.0.1:${started.port}/api/operator/connections`;
    return fetch(`${base}${connection ? `/${connection.connectionId}` : ""}${suffix}`, {
      method,
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(connection ? { Authorization: `Bearer ${connection.connectionKey}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function begin() {
    const response = await exchange(undefined, "", {});
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const connection: OperatorHttpBeginResponse = await response.json();
    connections.add(connection);
    expect(connection.connectionKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connection.handshakeExpiresAtMs).toBeGreaterThan(connection.challenge.ts);
    return connection;
  }

  function signedConnect(
    connection: OperatorHttpBeginResponse,
    paired: Awaited<ReturnType<typeof issueOperatorToken>>,
    scopes: string[],
  ): RequestFrame {
    const identity = loadOrCreateDeviceIdentity({ path: paired.identityPath });
    const signedAtMs = Date.now();
    const nonce = connection.challenge.nonce;
    return {
      type: "req",
      id: "connect",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "operator",
        scopes,
        auth: { deviceToken: paired.token },
        device: {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          nonce,
          signedAt: signedAtMs,
          signature: signDevicePayload(
            identity.privateKeyPem,
            buildDeviceAuthPayloadV3({
              deviceId: identity.deviceId,
              clientId: client.id,
              clientMode: client.mode,
              platform: client.platform,
              role: "operator",
              scopes,
              token: paired.token,
              nonce,
              signedAtMs,
            }),
          ),
        },
      },
    };
  }

  async function open(name: string, scopes = ["operator.read"]) {
    const paired = await issueOperatorToken({
      name: `http-${name}`,
      approvedScopes: scopes,
      clientId: client.id,
      clientMode: client.mode,
    });
    const connection = await begin();
    let clientSeq = 0;
    let ack = 0;
    const post = async (frame: RequestFrame) => {
      const response = await exchange(connection, "/frames", {
        clientSeq: ++clientSeq,
        ack,
        frame,
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ acceptedClientSeq: clientSeq });
    };
    const poll = async (acknowledge = true) => {
      const response = await exchange(connection, "/poll", { ack, waitMs: 2000 });
      expect(response.status).toBe(200);
      const result: OperatorHttpPollResponse = await response.json();
      if (acknowledge && result.frames.length) {
        ack = result.frames.at(-1)!.cursor;
      }
      return result;
    };
    const receive = async (id: string, acknowledge = true) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await poll(acknowledge);
        for (const entry of result.frames) {
          const parsed = responseSchema.safeParse(entry.frame);
          if (parsed.success && parsed.data.id === id) {
            return parsed.data;
          }
        }
        expect(result.closed).toBeUndefined();
      }
      throw new Error(`No HTTP response for ${id}`);
    };
    const call = async (method: string, params: unknown = {}) => {
      const id = `request-${clientSeq + 1}`;
      await post({ type: "req", id, method, params });
      return await receive(id);
    };
    await post(signedConnect(connection, paired, scopes));
    const hello = await receive("connect");
    expect(hello).toMatchObject({
      ok: true,
      payload: {
        server: { connId: connection.connectionId },
        auth: { method: "device-token", scopes },
      },
    });
    return {
      connection,
      paired,
      post,
      poll,
      receive,
      call,
      get ack() {
        return ack;
      },
    };
  }

  test("uses the shared RPC and subscription policy without administrative authority", async () => {
    const operator = await open("ordinary");
    expect(await operator.call("health")).toMatchObject({ ok: true });
    expect(await operator.call("sessions.subscribe")).toMatchObject({ ok: true });
    expect(await operator.call("config.get")).toMatchObject({ ok: true });
    expect(await operator.call("config.set", { raw: "{}" })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", details: { missingScope: "operator.admin" } },
    });
    expect(await operator.call("device.pair.list")).toMatchObject({ ok: false });
    expect((await rpcReq(started.ws, "health")).ok).toBe(true);
  });

  test.each(["operator.admin", "operator.pairing"])(
    "rejects %s at shared connect admission",
    async (scope) => {
      const paired = await issueOperatorToken({
        name: `http-denied-${scope}`,
        approvedScopes: [scope],
        clientId: client.id,
        clientMode: client.mode,
      });
      const connection = await begin();
      expect(
        (
          await exchange(connection, "/frames", {
            clientSeq: 1,
            ack: 0,
            frame: signedConnect(connection, paired, [scope]),
          })
        ).status,
      ).toBe(202);
      const response = await exchange(connection, "/poll", { ack: 0, waitMs: 2000 });
      const result: OperatorHttpPollResponse = await response.json();
      expect(result.frames).toEqual([
        {
          cursor: 1,
          frame: expect.objectContaining({ type: "res", id: "connect", ok: false }),
        },
      ]);
    },
  );

  test("does not use shared gateway auth instead of explicit device auth", async () => {
    const connection = await begin();
    await exchange(connection, "/frames", {
      clientSeq: 1,
      ack: 0,
      frame: {
        type: "req",
        id: "connect",
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client,
          role: "operator",
          scopes: ["operator.read"],
          auth: { token: "secret" },
        },
      },
    });
    const response = await exchange(connection, "/poll", { ack: 0, waitMs: 2000 });
    const result: OperatorHttpPollResponse = await response.json();
    expect(result.frames[0]?.frame).toMatchObject({ id: "connect", ok: false });
  });

  test("holds rejected preauth capacity until final removal, but releases authenticated capacity", async () => {
    const connection = await begin();
    await exchange(connection, "/frames", {
      clientSeq: 1,
      ack: 0,
      frame: { type: "req", id: "connect", method: "connect", params: {} },
    });
    const rejected = await exchange(connection, "/poll", { ack: 0, waitMs: 2000 });
    expect(await rejected.json()).toMatchObject({
      frames: [{ cursor: 1, frame: { id: "connect", ok: false } }],
      closed: { resyncRequired: true },
    });
    const exhausted = await exchange(undefined, "", {});
    if (exhausted.status === 201) {
      connections.add(await exhausted.json());
    }
    expect(exhausted.status).toBe(429);
    expect((await exchange(connection, "", undefined, "DELETE")).status).toBe(204);
    expect((await exchange(connection, "", undefined, "DELETE")).status).toBe(404);
    const authenticated = await open("budget-release");
    await begin();
    expect(await authenticated.call("health")).toMatchObject({ ok: true });
  });

  test("binds connect to the actual POST ingress instead of begin headers", async () => {
    const connection = await begin();
    const response = await exchange(
      connection,
      "/frames",
      {
        clientSeq: 1,
        ack: 0,
        frame: { type: "req", id: "connect", method: "connect", params: {} },
      },
      "POST",
      { Origin: `http://127.0.0.1:${started.port}` },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "ingress_changed", resyncRequired: true },
    });
  });

  test("does not retain root work while a poll waits and permits only one poll", async () => {
    const operator = await open("idle-poll");
    const output = await operator.poll();
    const cursor = output.frames.at(-1)?.cursor ?? 1;
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    const pending = exchange(operator.connection, "/poll", { ack: cursor, waitMs: 25_000 });
    await vi.waitFor(async () => {
      const second = await exchange(operator.connection, "/poll", { ack: cursor, waitMs: 0 });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: { code: "poll_conflict" } });
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    await exchange(operator.connection, "", undefined, "DELETE");
    expect((await pending).status).toBe(200);
  });

  test("fences a forwarding policy change during awaited handler preparation", async () => {
    const operator = await open("awaited-policy");
    const config = getRuntimeConfig();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepare = lazyHandlers.prepareGatewayRequestHandler;
    const invoked = vi.fn<GatewayRequestHandler>();
    const blocked = vi
      .spyOn(lazyHandlers, "prepareGatewayRequestHandler")
      .mockImplementationOnce(async (...args) => {
        invoked.mockImplementation(await prepare(...args));
        entered.resolve();
        await release.promise;
        return invoked;
      });
    try {
      await operator.post({ type: "req", id: "blocked", method: "health", params: {} });
      await entered.promise;
      setRuntimeConfigSnapshot({
        ...config,
        gateway: { ...config.gateway, trustedProxies: ["192.0.2.10"] },
      });
      release.resolve();
      await vi.waitFor(() => expect(blocked).toHaveResolved());
      // Restore only after the queued request has crossed its final dispatch fence.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(invoked).not.toHaveBeenCalled();
      setRuntimeConfigSnapshot(config);
      const response = await exchange(operator.connection, "/poll", {
        ack: operator.ack,
        waitMs: 0,
      });
      // A queued broadcaster send may terminate its transport on delivery failure.
      if (response.status === 404) {
        expect(await response.json()).toMatchObject({
          error: { code: "connection_not_found", resyncRequired: true },
        });
      } else {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          frames: [],
          closed: { resyncRequired: true },
        });
      }
    } finally {
      release.resolve();
      blocked.mockRestore();
      setRuntimeConfigSnapshot(config);
    }
  });

  test("does not claim preauth capacity when shutdown starts during the begin body", async () => {
    const clients = new Set<GatewayWsClient>();
    const work = new GatewayConnectionWork();
    const budget = createPreauthConnectionBudget(1);
    const acquire = vi.spyOn(budget, "acquire");
    const release = vi.spyOn(budget, "release");
    const readBody = vi.spyOn(hooks, "readJsonBody");
    const log = createSubsystemLogger("gateway/operator-http-test");
    const auth = { mode: "token", token: "secret", allowTailscale: false } as const;
    const runtime = createGatewayOperatorHttpRuntime({
      basePath: "",
      bootId: "shutdown-test",
      clients,
      connectionWork: work,
      preauthConnectionBudget: budget,
      getResolvedAuth: () => auth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      broadcast: () => {},
      refreshHealthSnapshot: async () => {
        throw new Error("No handshake may start");
      },
      buildRequestContext: () => {
        throw new Error("No connection may register");
      },
      logGateway: log,
      logHealth: log,
      logWsControl: log,
    });
    const server = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "",
      resolvedAuth: auth,
      handleHooksRequest: async () => false,
      handleOperatorRequest: runtime.handleRequest,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener");
    }
    const received = createDeferredCore<{ status?: number; body: string }>();
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/api/operator/connections",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "2" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.once("end", () => received.resolve({ status: response.statusCode, body }));
        response.once("error", received.reject);
      },
    );
    request.once("error", received.reject);
    try {
      request.write("{");
      await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
      work.beginClose();
      runtime.close();
      request.end("}");
      const response = await received.promise;
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: "unavailable", resyncRequired: true },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(budget.acquire("127.0.0.1")).toBe(true);
      budget.release("127.0.0.1");
      await work.drain();
    } finally {
      request.destroy();
      runtime.close();
      readBody.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test("deduplicates the same client sequence independently of ACK and rejects conflicts", async () => {
    const operator = await open("sequence");
    const frame: RequestFrame = { type: "req", id: "health", method: "health", params: {} };
    await operator.post(frame);
    const output = await operator.poll(false);
    const last = output.frames.at(-1);
    expect(last).toBeDefined();
    const repeated = await exchange(operator.connection, "/frames", {
      clientSeq: 2,
      ack: last!.cursor,
      frame: { params: {}, method: "health", id: "health", type: "req" },
    });
    expect(repeated.status).toBe(202);
    for (const body of [
      { clientSeq: 2, ack: last!.cursor, frame: { ...frame, id: "different" } },
      { clientSeq: 4, ack: last!.cursor, frame },
      { clientSeq: 3, ack: last!.cursor + 1, frame },
    ]) {
      expect((await exchange(operator.connection, "/frames", body)).status).toBe(409);
    }
    const noDuplicate = await exchange(operator.connection, "/poll", {
      ack: last!.cursor,
      waitMs: 0,
    });
    expect(await noDuplicate.json()).toMatchObject({ acceptedClientSeq: 2, frames: [] });
  });

  test("recovers a pending RPC after cancelling an empty poll and external approval rotates its token", async () => {
    const operator = await open("upgrade");
    const registration = await operator.call("device.scopes.requestUpgrade", {
      scopes: ["operator.read", "operator.write"],
    });
    expect(registration.ok).toBe(true);
    const { requestId } = z.object({ requestId: z.string() }).parse(registration.payload);
    await operator.post({
      type: "req",
      id: "wait",
      method: "device.scopes.waitUpgrade",
      params: { requestId },
    });
    const controller = new AbortController();
    const pendingPoll = exchange(
      operator.connection,
      "/poll",
      { ack: operator.ack, waitMs: 25_000 },
      "POST",
      undefined,
      controller.signal,
    ).then(
      () => "unexpected delivery",
      (error: unknown) => (error instanceof Error ? error.name : "unknown error"),
    );
    try {
      await vi.waitFor(async () => {
        const second = await exchange(operator.connection, "/poll", {
          ack: operator.ack,
          waitMs: 0,
        });
        expect(second.status).toBe(409);
      });
    } finally {
      controller.abort();
    }
    expect(await pendingPoll).toBe("AbortError");
    await vi.waitFor(async () => {
      const empty = await exchange(operator.connection, "/poll", { ack: operator.ack, waitMs: 0 });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ frames: [] });
    });
    expect((await rpcReq(started.ws, "device.pair.approve", { requestId })).ok).toBe(true);
    const result = await operator.receive("wait", false);
    expect(result.ok).toBe(true);
    const grant = z
      .object({
        status: z.literal("approved"),
        deviceToken: z.string(),
        scopes: z.array(z.string()),
      })
      .parse(result.payload);
    expect(grant.deviceToken).not.toBe(operator.paired.token);
    expect(grant.scopes).toEqual(["operator.read", "operator.write"]);
    const replay = await operator.poll(false);
    expect(replay.frames.map(({ frame }) => frame)).toContainEqual(result);
  });

  test.each(["device.token.revoke", "device.token.rotate", "device.pair.remove"])(
    "%s suppresses replay of an approved grant",
    async (method) => {
      const operator = await open(method);
      const registration = await operator.call("device.scopes.requestUpgrade", {
        scopes: ["operator.read", "operator.write"],
      });
      const { requestId } = z.object({ requestId: z.string() }).parse(registration.payload);
      await operator.post({
        type: "req",
        id: "wait",
        method: "device.scopes.waitUpgrade",
        params: { requestId },
      });
      expect((await rpcReq(started.ws, "device.pair.approve", { requestId })).ok).toBe(true);
      expect((await operator.receive("wait", false)).ok).toBe(true);
      expect(
        (
          await rpcReq(started.ws, method, {
            deviceId: operator.paired.deviceId,
            ...(method === "device.pair.remove" ? {} : { role: "operator" }),
          })
        ).ok,
      ).toBe(true);
      expect(await operator.poll(false)).toMatchObject({
        frames: [],
        closed: { resyncRequired: true },
      });
    },
  );
});
