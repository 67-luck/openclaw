import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTalkGatewayControlOwnerTestFixture,
  withPluginRuntimeGatewayRequestScope,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBroker,
  createRequest,
  createResponseHarness,
} from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function createDeferredOfferRequest(params: { origin: string; token: string }): {
  req: IncomingMessage;
  finish: (body: string) => void;
} {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.headers = {
    authorization: `Bearer ${params.token}`,
    "content-type": "application/sdp",
    origin: params.origin,
  };
  return {
    req,
    finish: (body) => {
      req.push(Buffer.from(body));
      req.complete = true;
      req.push(null);
    },
  };
}

describe("GPT-Live offer origin policy", () => {
  it("enforces origin changes before reserving or sending an OpenAI offer", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://old.example.test" } };
    const fetchImpl = vi.fn(
      async () =>
        new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/live/rtc_origin_proof" },
        }),
    ) as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl, getConfig: () => cfg });
    const reservation = await realtime.broker.createBrowserSession(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      },
      { type: "api-key", token: "platform-key" },
    );
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected WebRTC reservation");
    }
    const offer = async (origin: string) => {
      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ origin, token: reservation.clientSecret }),
        response.res,
      );
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
      expect((await offer("https://new.example.test")).res.statusCode).toBe(403);
      expect(realtime.getSessionCounts().pending).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();

      delete cfg.gateway!.controlUi;
      const accepted = await offer("https://new.example.test");
      expect(accepted.res.statusCode).toBe(200);
      expect(accepted.end).toHaveBeenCalledWith("v=answer\r\n");
      expect(realtime.getSessionCounts().pending).toBe(0);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      await realtime.cleanup();
    }
  });

  it("revokes a mapped-origin offer held across an explicit policy change", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://public.example.test" } };
    const fetchImpl = vi.fn(
      async () =>
        new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/live/rtc_revoked_origin" },
        }),
    ) as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl, getConfig: () => cfg });
    const gateway = createTalkGatewayControlOwnerTestFixture("voice-revoked-origin");
    const reservation = await realtime.broker.createBrowserSession(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        clientControl: { owner: "gateway" },
        runAgentConsult: gateway.owner.runAgentConsult,
        gatewayControl: gateway.owner.control,
      },
      { type: "api-key", token: "platform-key" },
    );
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected WebRTC reservation");
    }
    const deferred = createDeferredOfferRequest({
      origin: "http://localhost:25432",
      token: reservation.clientSecret,
    });
    const response = createResponseHarness();

    try {
      const handling = withPluginRuntimeGatewayRequestScope(
        { isWebchatConnect: () => false, publishedPort: 25432 },
        () => realtime.handler(deferred.req, response.res),
      );
      await vi.waitFor(() => expect(realtime.getSessionCounts().pending).toBe(0));

      cfg.gateway!.controlUi = { allowedOrigins: [] };
      deferred.finish(AUDIO_ONLY_SDP);

      await expect(handling).resolves.toBe(true);
      expect(response.res.statusCode).toBe(403);
      expect(response.readBody()).toBe("Origin not allowed");
      expect(response.removeHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin");
      expect(fetchImpl).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(gateway.closeLogicalSession).toHaveBeenCalledOnce());
      expect(gateway.events.map((event) => event.type)).toEqual([
        "session.error",
        "session.closed",
      ]);
      expect(gateway.events[0]?.payload).toEqual(
        expect.objectContaining({ message: "Origin not allowed" }),
      );
      expect(() => gateway.owner.assertOpen()).toThrow("Realtime voice session closed");
      expect(realtime.getSessionCounts()).toEqual({
        active: 0,
        inFlight: 0,
        pending: 0,
        reservations: 0,
      });
    } finally {
      deferred.req.destroy();
      await realtime.cleanup();
      await gateway.owner.close();
    }
  });
});
