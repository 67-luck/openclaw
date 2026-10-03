import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
} from "./realtime-quicksilver.test-helpers.js";

describe("GPT-Live final transcripts during media drain", () => {
  it.each(["resolve", "reject"] as const)(
    "retains a received final transcript when closing before the drain can %s",
    async (settlement) => {
      const drain = createDeferred();
      const events: string[] = [];
      let socket!: FakeSocket;
      const onTranscript = vi.fn(() => events.push("transcript"));
      const onResponseDone = vi.fn();
      const onError = vi.fn();
      const peer = {
        createOffer: async () => "v=offer\r\n",
        applyAnswer: async () => {},
        adoptPendingAudio: () => {},
        sendAudio: () => {},
        drainOutputAudio: vi.fn(() => drain.promise),
        close: () => {
          if (settlement === "reject") {
            drain.reject(new Error("GPT-Live audio worker closed"));
          }
        },
      };
      const bridge = new OpenAIQuicksilverGatewayBridge(
        {
          providerConfig: {},
          model: "gpt-live-test-canary",
          onAudio: vi.fn(),
          onClearAudio: vi.fn(),
          onTranscript,
          onResponseDone,
          onError,
          onClose: () => events.push("closed"),
          runAgentConsult: async () => ({ text: "Done" }),
          logger: { debug: vi.fn(), warn: vi.fn() },
          resolveAuth: async () => ({
            type: "oauth",
            token: "synthetic-token",
            accountId: "synthetic-account",
          }),
          createPeer: async () => peer,
          fetchImpl: async () => createCallResponse("v=answer\r\n", "rtc_transcript_drain"),
          webSocketFactory: () => (socket = new FakeSocket()),
        },
        openAIRealtimeHost,
      );
      try {
        await bridge.connect();
        emitSideband(socket, {
          type: "turn.done",
          turn: { role: "assistant", transcript: "Received final reply" },
        });
        expect(peer.drainOutputAudio).toHaveBeenCalledOnce();
        expect(onResponseDone).not.toHaveBeenCalled();

        await bridge.close();
        expect(onTranscript).toHaveBeenCalledExactlyOnceWith(
          "assistant",
          "Received final reply",
          true,
        );
        expect(events).toEqual(["transcript", "closed"]);

        drain.resolve();
        await drain.promise.catch(() => {});
        expect(onTranscript).toHaveBeenCalledTimes(1);
        expect(onResponseDone).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
      } finally {
        drain.resolve();
        await bridge.close();
      }
    },
  );
});
