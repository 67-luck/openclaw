import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { getActiveNativeAttempt } from "../../../agents/embedded-agent-runner/run-state.js";
import * as workspace from "../../../agents/workspace.js";
import { readSessionTranscriptMessageEvents } from "../../../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  flushClientVoiceSessionWrites,
  isClientVoiceSessionConfirmable,
} from "../../../talk/client-voice-session.js";
import { buildMockOpenAiResponsesProvider } from "../../test-openai-responses-model.js";
import {
  AGENT_ID,
  SESSION_ID,
  SESSION_KEY,
  connectNativeSession,
  installNativePluginTestHooks,
  nativeDelegation,
  requireString,
  talkEventTypes,
  upstream,
  withNativePlugin,
  withParkedNativeTask,
  withRegisteredNativeEmbeddedRun,
} from "./client-native-control.test-support.js";

describe("native Talk through the public OpenAI plugin registration", () => {
  installNativePluginTestHooks();

  it("reports setup rejection before a backend registration exists", async () => {
    const preparation = vi
      .spyOn(workspace, "ensureAgentWorkspace")
      .mockRejectedValueOnce(new Error("Synthetic workspace preparation failure"));
    const assertions = vi.fn<Parameters<typeof withParkedNativeTask>[0]>();
    await expect(withParkedNativeTask(assertions)).rejects.toThrow(
      "Native delegation completed before backend registration",
    );
    expect(preparation).toHaveBeenCalledOnce();
    expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(assertions).not.toHaveBeenCalled();
    expect(Boolean(getActiveNativeAttempt(SESSION_ID))).toBe(false);
    expect(
      upstream.sockets.every((socket) => socket.readyState === upstream.NativeSocket.CLOSED),
    ).toBe(true);
  });

  it.each([
    ["Status?", "transcript-first", "complete"],
    ["Status?", "delegation-first", "complete"],
    ["cancel", "transcript-first", "rejection"],
    ["cancel", "delegation-first", "rejection"],
    ["cancel", "transcript-first", "empty"],
    ["cancel", "delegation-first", "partial"],
  ] as const)(
    "negotiates Gateway control and persists native sideband speech without client control (%s, %s, %s)",
    async (control, eventOrder, settlement) => {
      const model = buildMockOpenAiResponsesProvider("https://native-model.example.invalid/v1");
      const requested = createDeferredCore();
      const runnerFinished = createDeferredCore<{ error?: unknown }>();
      const finishModel = createDeferredCore();
      const nativeFetch = upstream.fetch.getMockImplementation()!;
      let modelRequests = 0;
      upstream.fetch.mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url !== model.config.baseUrl + "/responses") {
          return await nativeFetch(input, init);
        }
        modelRequests++;
        if (modelRequests === 1 && (settlement === "complete" || settlement === "rejection")) {
          requested.resolve();
          await racePromiseWithAbortSignal(finishModel.promise, init?.signal ?? undefined);
        }
        const item = {
          type: "message",
          id: "voice-message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Real runner consultation completed.", annotations: [] },
          ],
        };
        const events = [
          {
            type: "response.output_item.added",
            item: { ...item, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ];
        const encode = (event: unknown) =>
          new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n");
        if (modelRequests === 1 && (settlement === "empty" || settlement === "partial")) {
          let closed = false;
          const body = new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(encode(events[0]));
              if (settlement === "partial") {
                stream.enqueue(
                  encode({
                    type: "response.content_part.added",
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  }),
                );
                stream.enqueue(
                  encode({
                    type: "response.output_text.delta",
                    item_id: item.id,
                    output_index: 0,
                    content_index: 0,
                    delta: "Cancelled partial output.",
                  }),
                );
              }
              requested.resolve();
              void racePromiseWithAbortSignal(finishModel.promise, init?.signal ?? undefined).then(
                () => {
                  if (!closed) {
                    for (const event of events.slice(1)) {
                      stream.enqueue(encode(event));
                    }
                    stream.close();
                  }
                },
                (error: unknown) => {
                  if (!closed) {
                    stream.error(error);
                  }
                },
              );
            },
            cancel() {
              closed = true;
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(
          events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const actualRunner = await vi.importActual<
        typeof import("../../../agents/embedded-agent.js")
      >("../../../agents/embedded-agent.js");
      upstream.runEmbeddedAgent.mockImplementation(async (params) => {
        try {
          const result = await actualRunner.runEmbeddedAgent(params);
          runnerFinished.resolve({});
          return result;
        } catch (error) {
          runnerFinished.resolve({ error });
          throw error;
        }
      });
      const preparing = createDeferredCore();
      const releasePreparation = createDeferredCore();
      const ensureWorkspace = workspace.ensureAgentWorkspace;
      vi.spyOn(workspace, "ensureAgentWorkspace").mockImplementationOnce(async (...args) => {
        const result = await ensureWorkspace(...args);
        preparing.resolve();
        await releasePreparation.promise;
        return result;
      });
      await withNativePlugin(
        async ({ create, offer, invoke, broadcast }) => {
          try {
            const { result, socket } = await connectNativeSession({ create, offer });
            expect(
              talkEventTypes(broadcast).filter((type) => type === "session.ready"),
            ).toHaveLength(1);
            expect(
              isClientVoiceSessionConfirmable({
                agentId: AGENT_ID,
                sessionKey: SESSION_KEY,
                voiceSessionId: requireString(result, "voiceSessionId"),
              }),
            ).toBe(true);
            socket.serverEvent({
              type: "turn.done",
              turn: { role: "user", transcript: "Hello voice" },
            });
            socket.serverEvent({
              type: "turn.done",
              turn: { role: "assistant", transcript: "Hello human" },
            });
            await flushClientVoiceSessionWrites({
              agentId: AGENT_ID,
              voiceSessionId: requireString(result, "voiceSessionId"),
            });
            const messages = readSessionTranscriptMessageEvents({
              agentId: AGENT_ID,
              sessionId: SESSION_ID,
            });
            expect(messages).toMatchObject([
              {
                event: {
                  message: { role: "user", content: [{ type: "text", text: "Hello voice" }] },
                },
              },
              {
                event: {
                  message: { role: "assistant", content: [{ type: "text", text: "Hello human" }] },
                },
              },
            ]);
            expect(talkEventTypes(broadcast)).not.toContain("turn.ended");
            socket.serverEvent(
              nativeDelegation("real-runner-request", "Complete a small voice consultation."),
            );
            await Promise.race([
              preparing.promise,
              runnerFinished.promise.then(({ error }) => {
                throw new Error("Native consultation settled before workspace preparation", {
                  cause: error,
                });
              }),
            ]);
            expect(modelRequests).toBe(0);
            expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
            releasePreparation.resolve();
            await Promise.race([
              requested.promise,
              runnerFinished.promise.then(({ error }) => {
                throw new Error("Native consultation settled before the model request", {
                  cause: error,
                });
              }),
            ]);
            const idle = await connectNativeSession({ create, offer });
            idle.socket.serverEvent(nativeDelegation("other-call-control", control));
            await idle.socket.waitForSent((frame) =>
              frame.includes(
                control === "cancel"
                  ? "There is no active OpenClaw run to cancel."
                  : "I'm not working on an active request right now.",
              ),
            );
            const transcript = { type: "turn.done", turn: { role: "user", transcript: control } };
            if (eventOrder === "transcript-first") {
              socket.serverEvent(transcript);
            }
            socket.serverEvent(nativeDelegation("real-runner-control", control));
            await socket.waitForSent((frame) =>
              frame.includes(
                control === "cancel"
                  ? "Cancelled the active OpenClaw run."
                  : "OpenClaw is waiting on the model.",
              ),
            );
            if (eventOrder === "delegation-first") {
              socket.serverEvent(transcript);
            }
            finishModel.resolve();
            await Promise.allSettled(
              upstream.runEmbeddedAgent.mock.results
                .filter((invocation) => invocation.type === "return")
                .map((invocation) => invocation.value),
            );
            await nextEventLoopTurn();
            const frames = socket.sent.map((frame): unknown => JSON.parse(frame));
            const completion = expect.objectContaining({
              type: "delegation.context.append",
              delegation_item_id: "real-runner-request",
              content: [expect.objectContaining({ text: "Real runner consultation completed." })],
            });
            if (control === "cancel") {
              expect(frames).not.toContainEqual(completion);
              expect(frames).not.toContainEqual(
                expect.objectContaining({
                  type: "delegation.context.append",
                  delegation_item_id: "real-runner-request",
                }),
              );
            } else {
              expect(frames).toContainEqual(completion);
            }
            expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
            expect(modelRequests).toBe(1);
            if (control === "cancel") {
              socket.serverEvent(nativeDelegation("late-cancel", "cancel"));
              await socket.waitForSent((frame) =>
                frame.includes("There is no active OpenClaw run to cancel."),
              );
              expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
              socket.serverEvent(nativeDelegation("after-cancel", "Start a fresh small task."));
              await socket.waitForSent(
                (frame) =>
                  frame.includes('"delegation_item_id":"after-cancel"') &&
                  frame.includes("Real runner consultation completed."),
              );
              expect(socket.sent.map((frame): unknown => JSON.parse(frame))).toContainEqual(
                expect.objectContaining({
                  type: "delegation.context.append",
                  delegation_item_id: "after-cancel",
                  content: [
                    expect.objectContaining({ text: "Real runner consultation completed." }),
                  ],
                }),
              );
              expect(upstream.runEmbeddedAgent).toHaveBeenCalledTimes(2);
              expect(modelRequests).toBe(2);
            }
            await invoke("talk.client.close", {
              voiceSessionId: requireString(result, "voiceSessionId"),
            });
            expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED);
          } finally {
            releasePreparation.resolve();
            finishModel.resolve();
          }
        },
        (config) => {
          config.agents!.defaults = {
            model: { primary: model.modelRef },
            models: { [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
          };
          config.models = { mode: "replace", providers: { [model.providerId]: model.config } };
        },
      );
    },
  );

  it.each([
    ["Status?", "I'm not working on an active request right now."],
    ["cancel", "There is no active OpenClaw run to cancel."],
  ])("answers idle native %s without starting a consult", async (text, reply) => {
    await withNativePlugin(async ({ create, offer }) => {
      const { socket, result } = await connectNativeSession({ create, offer });
      const beforeTranscript = socket.sent.slice();
      socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: text } });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      await nextEventLoopTurn();
      expect(socket.sent).toEqual(beforeTranscript);
      expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
      socket.serverEvent(nativeDelegation("idle-control", text));
      await vi.waitFor(() => expect(socket.sent.join("\n")).toContain(reply));
      await nextEventLoopTurn();
      expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
    });
  });

  it("keeps legacy native data-channel and client transcript ownership unchanged", async () => {
    await withNativePlugin(async ({ create, offer, invoke, broadcast }) => {
      const { result, socket } = await connectNativeSession({ create, offer }, false);
      socket.serverEvent({
        type: "turn.done",
        turn: { role: "user", transcript: "Client-owned speech" },
      });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(0);
      expect(talkEventTypes(broadcast)).not.toContain("transcript.done");
      await invoke("talk.client.transcript", {
        entryId: "legacy-final",
        role: "user",
        text: "Client-owned speech",
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(1);
      upstream.runEmbeddedAgent.mockImplementation(
        async (params) =>
          await withRegisteredNativeEmbeddedRun(params, () => ({
            payloads: [{ text: "Legacy provider consultation." }],
            meta: { durationMs: 0 },
          })),
      );
      socket.serverEvent(nativeDelegation("legacy-status", "Status?"));
      await vi.waitFor(() =>
        expect(socket.sent.join("\n")).toContain("Legacy provider consultation."),
      );
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });
});
