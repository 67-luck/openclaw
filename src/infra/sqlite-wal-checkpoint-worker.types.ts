import type { SqliteWalCheckpointSnapshot } from "./sqlite-wal-checkpoint.js";

export type SqliteWalCheckpointWorkerOwner = { identity: string; revision: number };
export type SqliteWalCheckpointWorkerOpen = SqliteWalCheckpointWorkerOwner & {
  databasePath: string;
  birthtime?: string;
  databaseLabel?: string;
  /** One Int32: 1 while the physical owner permits maintenance, 0 after revocation. */
  authority: SharedArrayBuffer;
  leases: SharedArrayBuffer[];
};
export type SqliteWalCheckpointWorkerObservation = SqliteWalCheckpointWorkerOwner & {
  checkpoint: SqliteWalCheckpointSnapshot;
};
export type SqliteWalCheckpointWorkerCommand =
  | { type: "open"; input: SqliteWalCheckpointWorkerOpen }
  | { type: "checkpoint"; owner: SqliteWalCheckpointWorkerOwner }
  | { type: "leases"; owner: SqliteWalCheckpointWorkerOwner; leases: SharedArrayBuffer[] }
  | { type: "sweep" };
