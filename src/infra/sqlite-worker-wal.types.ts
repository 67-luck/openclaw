import type { SqliteWalCheckpointSnapshot } from "./sqlite-wal-checkpoint.js";
import type { SqliteWalPeriodicResult } from "./sqlite-wal-write-admission.js";

export type SqliteWalMaintenanceReceipt = { lease: number; pass: number };
export type SqliteWalMaintenanceDispatchResult =
  | { kind: "pending"; receipt: SqliteWalMaintenanceReceipt }
  | { kind: "complete"; result: SqliteWalPeriodicResult };

export type SqliteWorkerWalFacts = {
  databasePath: string;
  identity: string;
  birthtime?: string;
  databaseLabel?: string;
};
export type SqliteWorkerWalCommand = { actor: number; lease: number } & (
  | { type: "open"; facts: SqliteWorkerWalFacts; authority: SharedArrayBuffer }
  | { type: "checkpoint" | "close" }
  | { type: "beginPass"; pass: number; claim: boolean }
  | { type: "claimPass"; pass: number }
  | { type: "finishPass"; pass: number; ok: true; result: SqliteWalPeriodicResult }
  | { type: "finishPass"; pass: number; ok: false; error: string }
  | { type: "schedule"; pass: number; unit: number }
);
export type SqliteWorkerWalRequest = SqliteWorkerWalCommand & { id: number };
export class SqliteWorkerWalAdmissionRefusedError extends Error {}
export type SqliteWorkerWalReply =
  | { type: "observation"; lease: number; checkpoint: SqliteWalCheckpointSnapshot }
  | { type: "unitAck"; unit: number; ok: true }
  | { type: "unitAck"; unit: number; ok: false; error: string }
  | { type: "result"; id: number; ok: true; checkpoint?: SqliteWalCheckpointSnapshot }
  | { type: "result"; id: number; ok: false; error: string; admissionRefused?: true };
