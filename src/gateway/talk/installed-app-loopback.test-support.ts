/** Loopback wire only; each caller retains its own config, pairing and executable fixture. */
import { EventEmitter } from "node:events";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { NodeHostClient } from "../../node-host/client.js";
import type { NodeInvokeRequestPayload } from "../../node-host/invoke-types.js";
import { handleInvoke } from "../../node-host/invoke.js";
import type { buildNodeInvokeCancel, buildNodeInvokeInput } from "../node-invoke-request.js";
import type { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";

export function createInstalledAppLoopbackTransport(
  registry: NodeRegistry,
  {
    beforeProgress,
    onAllowPermit,
    beforeResult,
  }: {
    beforeProgress?: () => void;
    onAllowPermit?: () => void;
    beforeResult?: (command: string, result: unknown) => void;
  } = {},
) {
  const invocations = new Map<
    string,
    { controller: AbortController; input?: (raw: string) => void; seq: number }
  >();
  const nativeCommands: string[] = [];
  const permits: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  class Transport extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    close() {
      this.readyState = 3;
    }
    terminate() {
      this.close();
    }
    send(raw: string) {
      const event = JSON.parse(raw) as
        | { event: "node.invoke.input"; payload: ReturnType<typeof buildNodeInvokeInput> }
        | { event: "node.invoke.cancel"; payload: ReturnType<typeof buildNodeInvokeCancel> }
        | { event: "node.invoke.request"; payload: NodeInvokeRequestPayload };
      if (event.event === "node.invoke.input") {
        const permit = JSON.parse(event.payload.payloadJSON);
        permits.push(permit);
        if (permit.type === "installed-app-launch.allow") {
          onAllowPermit?.();
        }
        invocations.get(event.payload.id)?.input?.(event.payload.payloadJSON);
        return;
      }
      if (event.event === "node.invoke.cancel") {
        invocations.get(event.payload.invokeId)?.controller.abort();
        return;
      }
      if (event.event !== "node.invoke.request") {
        return;
      }
      const frame = event.payload;
      const active = {
        controller: new AbortController(),
        input: undefined as ((raw: string) => void) | undefined,
        seq: 0,
      };
      invocations.set(frame.id, active);
      nativeCommands.push(frame.command);
      const request: NodeHostClient["request"] = async (method, value) => {
        if (method === "node.invoke.result") {
          beforeResult?.(frame.command, value);
          registry.handleInvokeResult({
            ...(value as Parameters<NodeRegistry["handleInvokeResult"]>[0]),
            connId: "node-connection",
          });
        }
        return {} as never;
      };
      const operation = Promise.resolve()
        .then(() =>
          handleInvoke(frame, { request }, { current: async () => [] }, undefined, {
            installedAppsSharingEnabled: true,
            installedAppsPlatform: "linux",
            signal: active.controller.signal,
            pluginCommandIo: {
              signal: active.controller.signal,
              onInput: (listener) => {
                active.input = listener;
              },
              emitChunk: async (chunk) => {
                beforeProgress?.();
                registry.handleInvokeProgress({
                  invokeId: frame.id,
                  nodeId: "paired-node",
                  connId: "node-connection",
                  seq: active.seq++,
                  chunk,
                });
              },
            },
          }),
        )
        .catch((error: unknown) => {
          // Never fabricate a native response: a missing dispatcher response must fail the proof.
          failures.push(error);
        })
        .finally(() => {
          invocations.delete(frame.id);
          pending.delete(operation);
        });
      pending.add(operation);
    }
  }
  const node: GatewayWsClient = {
    socket: new Transport(),
    connId: "node-connection",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      role: "node",
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "linux",
        deviceFamily: "linux",
        mode: "node",
      },
      device: {
        id: "paired-node",
        publicKey: "fixture",
        signature: "fixture",
        signedAt: 1,
        nonce: "fixture",
      },
      caps: ["device"],
      commands: ["device.apps", "device.apps.launch"],
    },
  };
  return {
    node,
    nativeCommands,
    permits,
    drain: async () => {
      await Promise.all(pending);
      if (failures.length) {
        throw new AggregateError(failures, "native dispatcher failed");
      }
    },
  };
}
