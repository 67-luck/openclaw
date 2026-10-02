import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "../../../extensions/openai/realtime-quicksilver-session.js";
import {
  createBroker,
  createRequest,
} from "../../../extensions/openai/realtime-quicksilver.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { resolveAcceptedBrowserOrigin } from "../../plugin-sdk/webhook-request-guards.js";
import type { PluginHttpRouteRegistration } from "../../plugins/registry.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createGatewayTestRegistry } from "./__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

function createMockLogger(): SubsystemLogger {
  const child = vi.fn<(name: string) => SubsystemLogger>();
  const logger = {
    subsystem: "test/plugins-http-origin-policy",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child,
  } satisfies SubsystemLogger;
  child.mockImplementation(() => logger);
  return logger;
}

describe("plugin HTTP origin policy", () => {
  it("carries mapped origins through dispatch without leaking them to other requests", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://old.example.test" } };
    let accepted: string | undefined;
    const route: PluginHttpRouteRegistration = {
      pluginId: "origin-proof",
      source: "origin-proof",
      path: "/origin-proof",
      auth: "gateway",
      match: "exact",
      handler: async (req) => {
        await Promise.resolve();
        accepted = resolveAcceptedBrowserOrigin({ req, cfg });
        return true;
      },
    };
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({ httpRoutes: [route] }),
      log: createMockLogger(),
    });
    const request = async (origin: string, publishedPort?: number) => {
      const req = {
        url: route.path,
        headers: { origin, host: "gateway.example.test:18789" },
        socket: { remoteAddress: "198.51.100.4" },
      } as IncomingMessage;
      const response = makeMockHttpResponse();
      expect(
        await handler(req, response.res, undefined, {
          gatewayAuthSatisfied: true,
          gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
          gatewayRequestOperatorScopes: ["operator.write"],
          publishedPort,
        }),
      ).toBe(true);
      return accepted;
    };

    const mappedOrigin = "http://localhost:25432";
    expect(await request(mappedOrigin, 25432)).toBe(mappedOrigin);
    expect(await request(mappedOrigin)).toBeUndefined();
    cfg.gateway!.publicOrigin = "https://new.example.test";
    expect(await request("https://old.example.test", 25432)).toBeUndefined();
    expect(await request("https://new.example.test", 25432)).toBe("https://new.example.test");
    expect(await request(mappedOrigin, 25432)).toBe(mappedOrigin);
    cfg.gateway!.controlUi = { allowedOrigins: [] };
    expect(await request(mappedOrigin, 25432)).toBeUndefined();
  });

  it("enforces mapped origin changes before the OpenAI offer is reserved or sent", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://old.example.test" } };
    const fetchImpl = vi.fn(
      async () =>
        new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/live/rtc_origin_proof" },
        }),
    ) as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl, getConfig: () => cfg });
    const route: PluginHttpRouteRegistration = {
      pluginId: "openai",
      source: "openai",
      path: OPENAI_QUICKSILVER_OFFER_PATH,
      auth: "plugin",
      match: "exact",
      handler: realtime.handler,
    };
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({ httpRoutes: [route] }),
      log: createMockLogger(),
    });
    const reservation = await realtime.broker.createBrowserSession(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      },
      { type: "api-key", token: "test-token-placeholder" },
    );
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected WebRTC reservation");
    }

    const offer = async (origin: string) => {
      const req = createRequest({ origin });
      Object.assign(req.headers, { authorization: `Bearer ${reservation.clientSecret}` });
      req.url = route.path;
      req.headers.host = "gateway.example.test:18789";
      const response = makeMockHttpResponse();
      expect(await handler(req, response.res, undefined, { publishedPort: 25432 })).toBe(true);
      return response;
    };

    try {
      expect((await offer("https://untrusted.example.test")).res.statusCode).toBe(403);
      expect(realtime.getSessionCounts().pending).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();

      cfg.gateway!.publicOrigin = "https://new.example.test";
      expect((await offer("https://old.example.test")).res.statusCode).toBe(403);
      expect(realtime.getSessionCounts().pending).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();

      cfg.gateway!.controlUi = { allowedOrigins: [] };
      expect((await offer("http://localhost:25432")).res.statusCode).toBe(403);
      expect(realtime.getSessionCounts().pending).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();

      delete cfg.gateway!.controlUi;
      const accepted = await offer("http://localhost:25432");
      expect(accepted.res.statusCode).toBe(200);
      expect(accepted.end).toHaveBeenCalledWith("v=answer\r\n");
      expect(realtime.getSessionCounts().pending).toBe(0);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      await realtime.cleanup();
    }
  });
});
