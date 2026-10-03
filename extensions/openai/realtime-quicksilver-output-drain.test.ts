import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type QuicksilverAudioWorkerCommand,
  type QuicksilverAudioWorkerEvent,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
} from "./realtime-quicksilver.test-helpers.js";

const transport = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const events: QuicksilverAudioWorkerEvent[] = [];
  const acknowledgments: QuicksilverAudioWorkerCommand[] = [];
  const receivedRtp = new EventEmitter();
  let resolveDrain!: () => void;
  const draining = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  const parent = Object.assign(new EventEmitter(), {
    postMessage(event: QuicksilverAudioWorkerEvent) {
      if (event.type === "audio") {
        events.push(event);
      } else {
        queueMicrotask(() => worker.emit("message", event));
      }
    },
    close() {},
  });
  const worker = Object.assign(new EventEmitter(), {
    postMessage(command: QuicksilverAudioWorkerCommand) {
      if (command.type === "audio-ack") {
        acknowledgments.push(command);
      } else {
        queueMicrotask(() => {
          parent.emit("message", command);
          if (command.type === "drain-output") {
            resolveDrain();
          }
        });
      }
    },
    unref() {},
    async terminate() {
      worker.emit("exit", 0);
      return 0;
    },
  });
  return { parent, worker, receivedRtp, events, acknowledgments, draining };
});

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: transport.parent,
  workerData: {},
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  createCpuTrackedWorker: () => transport.worker,
  resolveRuntimeWorkerUrl: () => new URL("file:///audio.worker.ts"),
  resolveRuntimeWorkerArgv: () => [],
}));
vi.mock("libopus-wasm", () => ({
  Application: { Voip: 0 },
  createEncoder: async () => ({ free() {} }),
  createDecoder: async () => ({
    decode: () => new Int16Array(960 * 2).fill(12_000),
    decodePacketLoss: () => new Int16Array(960 * 2).fill(12_000),
    free() {},
  }),
}));
vi.mock("werift", () => ({
  useOPUS: () => ({}),
  dePacketizeRtpPackets: (_codec: string, packets: { payload: Buffer }[]) => ({
    data: packets[0]!.payload,
  }),
  RTCPeerConnection: class {
    localDescription = { sdp: "v=offer\r\n" };
    onTrack = { subscribe() {} };
    connectionStateChange = { subscribe() {} };
    addTransceiver() {
      return {
        receiver: {
          track: {
            kind: "audio",
            uuid: "inbound",
            onReceiveRtp: {
              subscribe: (receive: (packet: unknown) => void) =>
                transport.receivedRtp.on("rtp", receive),
            },
          },
        },
      };
    }
    async createOffer() {
      return this.localDescription;
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async close() {}
  },
}));

describe("GPT-Live callback output completion", () => {
  it("delivers reordered RTP and backpressured worker PCM before completing the reply", async () => {
    vi.useFakeTimers();
    let socket!: FakeSocket;
    const audio: Buffer[] = [];
    const callbacks: string[] = [];
    let completed!: () => void;
    const completion = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const onResponseDone = vi.fn(() => {
      callbacks.push("completed");
      completed();
    });
    const onError = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: (chunk) => {
          audio.push(chunk);
          callbacks.push("audio");
        },
        onClearAudio: vi.fn(),
        onResponseDone,
        onError,
        runAgentConsult: async () => ({ text: "done" }),
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: async () => ({
          type: "oauth",
          token: "test-token",
          accountId: "test-account",
        }),
        createPeer: async (peerCallbacks) => {
          const creation = OpenAIQuicksilverAudioPeer.create({
            callbacks: peerCallbacks,
            iceServers: [],
          });
          await import("./realtime-quicksilver-audio.worker.js");
          return creation;
        },
        fetchImpl: async () => createCallResponse("v=answer\r\n", "rtc_drain"),
        webSocketFactory: () => (socket = new FakeSocket()),
      },
      openAIRealtimeHost,
    );
    try {
      await bridge.connect();
      for (const sequenceNumber of [10, 11, 13, 15]) {
        transport.receivedRtp.emit("rtp", {
          header: { sequenceNumber, ssrc: 1 },
          payload: Buffer.from([sequenceNumber]),
        });
      }
      // The first PCM batch is posted but undelivered; the next is held for its
      // acknowledgment, and two RTP packets still await the 80-ms reorder timer.
      expect(transport.events).toHaveLength(1);
      expect(audio).toHaveLength(0);
      const finish = () =>
        emitSideband(socket, {
          type: "turn.done",
          turn: { role: "assistant", transcript: "Finished reply" },
        });
      finish();
      expect(onResponseDone).not.toHaveBeenCalled();
      await transport.draining;
      finish();
      expect(onResponseDone).not.toHaveBeenCalled();

      transport.worker.emit("message", transport.events.shift());
      expect(transport.acknowledgments).toHaveLength(1);
      expect(onResponseDone).not.toHaveBeenCalled();
      transport.parent.emit("message", transport.acknowledgments.shift());
      // The worker result follows the final audio event on the same port.
      // Deliver that batch before allowing its queued result to run.
      expect(transport.events).toHaveLength(1);
      transport.worker.emit("message", transport.events.shift());
      await completion;

      expect(Buffer.concat(audio)).toHaveLength(6 * 480 * 2);
      expect(Buffer.concat(audio).readInt16LE(6 * 480 * 2 - 2)).toBe(12_000);
      expect(callbacks).toEqual(["audio", "audio", "completed"]);
      expect(onResponseDone).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
      await vi.advanceTimersByTimeAsync(80);
      expect(transport.events).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
      await transport.worker.terminate();
      vi.useRealTimers();
    }
  });
});
