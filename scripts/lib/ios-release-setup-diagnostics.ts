import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GatewayProtocolClient,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolTiming,
} from "../../packages/gateway-client/src/protocol-client.js";
import { GatewayClient, type GatewayClientRequestOptions } from "../../src/gateway/client.js";

type SetupOperation = "setup-status" | "setup-code";
type SetupMethod = "device.pair.setupStatus" | "device.pair.setupCode";
type EventLabel =
  | `protocol-${GatewayProtocolTiming<unknown>["phase"]}`
  | "client-start"
  | "connect-request-start"
  | "connect-request-resolved"
  | "connect-request-rejected"
  | "request-start"
  | "request-resolved"
  | "request-rejected"
  | "client-stop-start"
  | "client-stop-resolved"
  | "client-stop-rejected"
  | "call-resolved"
  | "call-rejected";

type ParentResources = {
  elapsedMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssBytes: number;
  eventLoopUtilization: number;
  eventLoopDelayMaxMs: number;
  eventLoopDelayP99Ms: number;
};

type RpcEvidence = {
  operation: SetupOperation;
  epochMs: number;
  status: "running" | "passed" | "failed";
  totalMs: number;
  events: { label: EventLabel; ms: number }[];
  parent?: ParentResources;
};

const RESOURCE_FIELDS = [
  "epochMs",
  "uptimeMs",
  "intervalMs",
  "cpuUserMs",
  "cpuSystemMs",
  "rssBytes",
  "heapUsedBytes",
  "eventLoopUtilization",
  "eventLoopDelayMaxMs",
  "eventLoopDelayP99Ms",
] as const;
type ResourceSample = Record<(typeof RESOURCE_FIELDS)[number], number>;

type IOSReleaseSetupEvidence = {
  rpcs: RpcEvidence[];
  serverRpcs: { method: SetupMethod; ok: boolean; durationMs: number }[];
  resources: ResourceSample[];
};

const RESOURCE_PREFIX = "IOS_SETUP_PROBE_RESOURCE ";
const MAX_LINE_LENGTH = 4_096;
const PROTOCOL_EVENT_LABELS = {
  "socket-open": "protocol-socket-open",
  challenge: "protocol-challenge",
  fallback: "protocol-fallback",
  "device-identity-ready": "protocol-device-identity-ready",
  "connect-plan-ready": "protocol-connect-plan-ready",
  "request-sent": "protocol-request-sent",
  hello: "protocol-hello",
  failed: "protocol-failed",
} as const satisfies Record<GatewayProtocolTiming<unknown>["phase"], EventLabel>;
const scope = new AsyncLocalStorage<object>();
let observing = false;

function rounded(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 1_000) / 1_000) : 0;
}

function resourceSample(value: unknown): value is ResourceSample {
  return (
    isRecord(value) &&
    Object.keys(value).length === RESOURCE_FIELDS.length &&
    RESOURCE_FIELDS.every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
    ) &&
    typeof value.eventLoopUtilization === "number" &&
    value.eventLoopUtilization <= 1
  );
}

function appendBounded<T>(rows: T[], value: T, limit: number): void {
  if (rows.length === limit) {
    rows.shift();
  }
  rows.push(value);
}

/** Temporary setup-only observations; no request data or raw diagnostics leave this owner. */
export function createIOSReleaseSetupDiagnostics() {
  const evidence: IOSReleaseSetupEvidence = { rpcs: [], serverRpcs: [], resources: [] };
  return {
    evidence,
    async observeRpc<T>(operation: SetupOperation, action: () => Promise<T>): Promise<T> {
      // Prototypes are shared within the harness process, so observation scopes must be serial.
      if (observing) {
        throw new Error("iOS setup diagnostic observation already active");
      }
      if (evidence.rpcs.length >= 2) {
        return action();
      }
      // Retain the actual replaceable properties, including their flags, for exact restoration.
      const clientDescriptors = Object.getOwnPropertyDescriptors(GatewayClient.prototype);
      const protocolDescriptors = Object.getOwnPropertyDescriptors(GatewayProtocolClient.prototype);
      const originalStart = clientDescriptors.start.value;
      const originalRequest = clientDescriptors.request.value;
      const originalStop = clientDescriptors.stopAndWait.value;
      const originalProtocolRequest = protocolDescriptors.request.value;
      const originalProtocolTiming = protocolDescriptors.recordTiming.value;
      if (
        !originalStart ||
        !originalRequest ||
        !originalStop ||
        !originalProtocolRequest ||
        !originalProtocolTiming
      ) {
        throw new Error("iOS setup diagnostic methods unavailable");
      }
      const identity = {};
      const started = performance.now();
      const cpu = process.cpuUsage();
      const utilization = performance.eventLoopUtilization();
      const delay = monitorEventLoopDelay({ resolution: 20 });
      const rpc: RpcEvidence = {
        operation,
        epochMs: Date.now(),
        status: "running",
        totalMs: 0,
        events: [],
      };
      evidence.rpcs.push(rpc);
      let active = true;
      let selectedClient: WeakRef<GatewayClient> | undefined;
      let selectedProtocol: WeakRef<GatewayProtocolClient<unknown>> | undefined;
      const current = () => active && scope.getStore() === identity;
      const record = (label: EventLabel) => {
        if (active && rpc.events.length < 24) {
          rpc.events.push({ label, ms: rounded(performance.now() - started) });
        }
      };
      const observePromise = <Value>(
        pending: Promise<Value>,
        resolved: EventLabel,
        rejected: EventLabel,
      ) => {
        void pending.then(
          () => record(resolved),
          () => record(rejected),
        );
        return pending;
      };
      const method =
        operation === "setup-status" ? "device.pair.setupStatus" : "device.pair.setupCode";
      observing = true;
      delay.enable();
      try {
        GatewayClient.prototype.start = function () {
          if (current() && (!selectedClient || selectedClient.deref() === this)) {
            selectedClient ??= new WeakRef(this);
            record("client-start");
          }
          return originalStart.call(this);
        };
        GatewayClient.prototype.request = function <Value = Record<string, unknown>>(
          requestedMethod: string,
          params?: unknown,
          options?: GatewayClientRequestOptions,
        ): Promise<Value> {
          const observed =
            current() && selectedClient?.deref() === this && requestedMethod === method;
          if (observed) {
            record("request-start");
          }
          try {
            const pending = originalRequest.bind(this)<Value>(requestedMethod, params, options);
            return observed
              ? observePromise(pending, "request-resolved", "request-rejected")
              : pending;
          } catch (error) {
            if (observed) {
              record("request-rejected");
            }
            throw error;
          }
        };
        GatewayClient.prototype.stopAndWait = function (options?: { timeoutMs?: number }) {
          const observed = current() && selectedClient?.deref() === this;
          if (observed) {
            record("client-stop-start");
          }
          try {
            const pending = originalStop.call(this, options);
            return observed
              ? observePromise(pending, "client-stop-resolved", "client-stop-rejected")
              : pending;
          } catch (error) {
            if (observed) {
              record("client-stop-rejected");
            }
            throw error;
          }
        };
        GatewayProtocolClient.prototype.recordTiming = function (phase, generation, plan, detail) {
          if (
            current() &&
            selectedClient &&
            (!selectedProtocol || selectedProtocol.deref() === this) &&
            Object.hasOwn(PROTOCOL_EVENT_LABELS, phase)
          ) {
            selectedProtocol ??= new WeakRef(this);
            record(PROTOCOL_EVENT_LABELS[phase]);
          }
          return originalProtocolTiming.call(this, phase, generation, plan, detail);
        };
        GatewayProtocolClient.prototype.request = function <Value = unknown>(
          requestedMethod: string,
          params?: unknown,
          options?: GatewayProtocolRequestOptions,
        ): Promise<Value> {
          const observed =
            current() &&
            selectedClient !== undefined &&
            (!selectedProtocol || selectedProtocol.deref() === this) &&
            requestedMethod === "connect";
          if (observed) {
            selectedProtocol ??= new WeakRef(this);
            record("connect-request-start");
          }
          try {
            const pending = originalProtocolRequest.bind(this)<Value>(
              requestedMethod,
              params,
              options,
            );
            return observed
              ? observePromise(pending, "connect-request-resolved", "connect-request-rejected")
              : pending;
          } catch (error) {
            if (observed) {
              record("connect-request-rejected");
            }
            throw error;
          }
        };
        const result = await scope.run(identity, action);
        rpc.status = "passed";
        record("call-resolved");
        return result;
      } catch (error) {
        rpc.status = "failed";
        record("call-rejected");
        throw error;
      } finally {
        active = false;
        Object.defineProperty(GatewayClient.prototype, "start", clientDescriptors.start);
        Object.defineProperty(GatewayClient.prototype, "request", clientDescriptors.request);
        Object.defineProperty(
          GatewayClient.prototype,
          "stopAndWait",
          clientDescriptors.stopAndWait,
        );
        Object.defineProperty(
          GatewayProtocolClient.prototype,
          "request",
          protocolDescriptors.request,
        );
        Object.defineProperty(
          GatewayProtocolClient.prototype,
          "recordTiming",
          protocolDescriptors.recordTiming,
        );
        observing = false;
        delay.disable();
        const elapsedMs = rounded(performance.now() - started);
        const used = process.cpuUsage(cpu);
        rpc.totalMs = elapsedMs;
        rpc.parent = {
          elapsedMs,
          cpuUserMs: rounded(used.user / 1_000),
          cpuSystemMs: rounded(used.system / 1_000),
          rssBytes: process.memoryUsage().rss,
          eventLoopUtilization: rounded(performance.eventLoopUtilization(utilization).utilization),
          eventLoopDelayMaxMs: rounded(delay.max / 1_000_000),
          eventLoopDelayP99Ms: rounded(delay.percentile(99) / 1_000_000),
        };
      }
    },
    captureGatewayLogs(raw: string): void {
      // Fixture logs are a bounded tail; keep parsing and exported evidence bounded independently.
      for (const line of raw.slice(-1_048_576).split("\n")) {
        if (line.length > MAX_LINE_LENGTH) {
          continue;
        }
        try {
          if (line.startsWith(RESOURCE_PREFIX)) {
            const value: unknown = JSON.parse(line.slice(RESOURCE_PREFIX.length));
            if (resourceSample(value)) {
              appendBounded(evidence.resources, value, 120);
            }
            continue;
          }
          const value: unknown = JSON.parse(line);
          if (
            !isRecord(value) ||
            value.subsystem !== "gateway/ws" ||
            typeof value.message !== "string"
          ) {
            continue;
          }
          const match =
            /^(?:→|⇄)\s+res\s+([✓✗])\s+(device\.pair\.(?:setupStatus|setupCode))\s+(\d+)ms\b/u.exec(
              stripVTControlCharacters(value.message),
            );
          const method = match?.[2];
          const durationMs = Number(match?.[3]);
          if (
            (method === "device.pair.setupStatus" || method === "device.pair.setupCode") &&
            Number.isSafeInteger(durationMs) &&
            durationMs >= 0
          ) {
            appendBounded(evidence.serverRpcs, { method, ok: match?.[1] === "✓", durationMs }, 8);
          }
        } catch {
          // Raw output may contain non-JSON lines or credential-bearing errors; discard them whole.
        }
      }
    },
  };
}
