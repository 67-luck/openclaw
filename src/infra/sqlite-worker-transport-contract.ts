import type { HeapInfo } from "node:v8";
import type { MessagePort } from "node:worker_threads";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "./sqlite-worker-contract.js";

export const SQLITE_WORKER_PROTOCOL_WAIT_NS = 5_000_000_000n;
export const SQLITE_WORKER_HEAP_LIMIT_MB = 512;

type Identity = { service: string; child: string };
export type SqliteWorkerTransportInput = Identity & {
  port: MessagePort;
  carrierUrl: string;
  execArgv: string[];
};

export type SqliteWorkerTransportRequest = Identity &
  (
    | { kind: "request"; request: SqliteWorkerRequest }
    | { kind: "status"; sequence: number; job: number }
    | { kind: "sample"; sequence: number; metric: "cpu" | "heap" }
  );

export type SqliteWorkerTransportReply = Identity &
  (
    | { kind: "ready" }
    | { kind: "posted"; job: number; actor: number; attemptedAtNs: bigint }
    | { kind: "reply"; reply: SqliteWorkerReply }
    | { kind: "status"; sequence: number; job: number }
    | { kind: "cpu"; sequence: number; value?: NodeJS.CpuUsage }
    | { kind: "heap"; sequence: number; value?: HeapInfo }
    | { kind: "exit"; code: number; error?: string }
  );
