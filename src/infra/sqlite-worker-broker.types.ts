import type { MessagePort, Worker } from "node:worker_threads";
import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import type {
  SqliteWorkerRequest,
  SqliteWorkerReply,
  SqliteWorkerCloseReceipt,
  SqliteWorkerStateLifecycle,
} from "./sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import type {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
} from "./sqlite-worker-transfer.js";
import type { createSqliteWorkerTransport } from "./sqlite-worker-transport.js";
import type {
  tryCreateGatewaySchemaFenceDelegate,
  tryCreateStateLifecycleDelegate,
} from "./state-database-coordinator.js";

type StateLifecycleDelegate = NonNullable<ReturnType<typeof tryCreateStateLifecycleDelegate>>;

export type RequestBody = SqliteWorkerRequest extends infer Request
  ? Request extends SqliteWorkerRequest
    ? Omit<Request, "id">
    : never
  : never;
type DispatchState = { dispatched: boolean; openNotEntered?: boolean };
export type SqliteWorkerJobTerminal = {
  settlement: SqliteWorkerOperationSettlement;
  result: Result<unknown, unknown>;
};
export type ReadySqliteWorkerOperation = {
  job?: Job;
  /** Only refusals before a Job exists; dispatched outcomes belong to Job.terminal. */
  result?: { ok: true; value: unknown } | { ok: false; error: unknown };
};
export type Job = {
  terminal?: SqliteWorkerJobTerminal;
  ready?: ReadySqliteWorkerOperation;
  transportPostedAtNs?: bigint;
  preparedAtNs?: bigint;
  dispatchPrepared?: () => void;
  readyReply?: true;
  requireStateLifecycle?: SqliteWorkerStateLifecycle;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  maintenanceSchemaFence?: { actor: Actor; delegate: StateLifecycleDelegate };
  gatewaySchemaFence?: { actor: Actor; delegate: StateLifecycleDelegate };
  createAdmission?: SqliteWorkerAdmissionFactory;
  operationAdmission?: {
    admission: SqliteWorkerOperationAdmission;
    settle?: ReturnType<SqliteWorkerAdmissionFactory>["settle"];
    releaseService(): void;
  };
  settleNative?: (settlement: SqliteWorkerOperationSettlement) => void;
  nativeDispatched?: boolean;
  requestPosted?: boolean;
  rejectPreparation?: (error: unknown) => void;
  preparation?: Promise<void>;
  scopeDriver?: Promise<void>;
  lifecyclePreparation?: { failure: unknown; service(check?: () => void): void; finish(): void };
  cancelPreparation?: AbortController;
  stateLifecycle?: { actor: Actor; delegate: StateLifecycleDelegate };
  assertCurrent?: () => void;
  inputTransfer?: {
    id: number;
    producer: ReturnType<typeof createSqliteWorkerTransferOwner>;
  };
  transfer?: {
    id: number;
    receiver: ReturnType<typeof createSqliteWorkerTransferReceiver>;
    value: unknown;
  };
  dispatchState?: DispatchState;
  request: SqliteWorkerRequest;
  bytes: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  detach(): void;
};
export type Slot = {
  retirementReason?: Error;
  transport?: ReturnType<typeof createSqliteWorkerTransport>;
  childStopped?: true;
  runtimeGeneration?: RuntimeWorkerGeneration;
  borrowedGenerationSlot?: true;
  worker: Worker;
  receiveReply(reply: SqliteWorkerReply, pumping?: boolean): void;
  actors: Set<Actor>;
  queue: Job[];
  current?: Job;
  failed?: Error;
  retiring?: Promise<void>;
  exit: Promise<void>;
  exited: boolean;
  pendingOpens: number;
};
export type Actor = {
  volatile?: true;
  protocolFailure?: Error;
  runtimeGeneration?: RuntimeWorkerGeneration;
  nativeStopped: Promise<void>;
  markNativeStopped(): void;
  closeReceipt?: SqliteWorkerCloseReceipt;
  stateDatabasePath?: string;
  id: number;
  key: string;
  databasePath: string;
  pathReferences: Map<string, number>;
  moduleUrl: string;
  inputHash: string;
  slot: Slot;
  references: number;
  opened: Promise<unknown>;
  openDispatch: DispatchState;
  initialized: boolean;
  backendClosed: boolean;
  cleanupState?: "pending" | "complete";
  closing?: Promise<void>;
  retirementRequested?: boolean;
  retirement?: Promise<void>;
  onReferencesDrained?: () => void;
  stateContext?: SqliteWorkerStateContext;
  gatewaySchemaFence?: NonNullable<ReturnType<typeof tryCreateGatewaySchemaFenceDelegate>>;
  pendingStateLifecycles: Set<StateLifecycleDelegate>;
};
export type OperationScope = {
  requireStateLifecycle?: SqliteWorkerStateLifecycle;
  createAdmission?: SqliteWorkerAdmissionFactory;
  assertCurrent?: (commandType: PropertyKey) => void;
  active: boolean;
  pending: Set<Promise<unknown>>;
  stateContext?: SqliteWorkerStateContext;
};
export type EnqueueOptions = {
  ready?: ReadySqliteWorkerOperation;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  createAdmission?: SqliteWorkerAdmissionFactory;
  signal?: AbortSignal;
  dispatchState?: DispatchState;
  scope?: OperationScope;
  assertCurrent?: () => void;
};
export type StoreClient = {
  actor: Actor;
  close(): Promise<void>;
  sealed: boolean;
  isAvailable(): boolean;
  scopes: Set<Promise<void>>;
  execute(
    command: { type: PropertyKey; input: unknown },
    options: { signal?: AbortSignal },
    scope?: OperationScope,
  ): Promise<unknown>;
  executeReady(command: { type: PropertyKey; input: unknown }, scope?: OperationScope): unknown;
};

export type SqliteWorkerStoreOptions = {
  runtimeGeneration?: RuntimeWorkerGeneration;
  moduleUrl: URL;
  databasePath: string;
  input: unknown;
  existingOnly?: boolean;
  admission?: { identity: string; assertCurrent(): void };
};

export type PreparedSqliteWorkerOpen = {
  volatile?: { id: string };
  backendService?: MessagePort;
  preparation?: Buffer;
  runtimeGeneration?: RuntimeWorkerGeneration;
  carrierUrl: URL;
  transportUrl?: URL;
  expectedIdentity?: string;
  createOpenAdmission?: SqliteWorkerAdmissionFactory;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  retainCleanup?: (cleanup: SqliteWorkerAdmissionCleanup) => void;
  onNativeStopped?: (
    stopped: Promise<void>,
    readCloseReceipt: () => SqliteWorkerCloseReceipt | undefined,
  ) => void;
  stateDatabasePath?: string;
  createAdmission?: SqliteWorkerAdmissionFactory;
  assertCurrent?: () => void;
  moduleUrl: URL;
  databasePath: string;
  input: Buffer;
  existingOnly: boolean;
  stateContext?: SqliteWorkerStateContext;
};

/** Exact failed-admission custody; pathname cleanup can include unrelated actors. */
export type SqliteWorkerAdmissionCleanup = {
  readonly pending: boolean;
  close(): Promise<void>;
};

export type SqliteWorkerOpenCustody = Pick<
  PreparedSqliteWorkerOpen,
  | "maintenanceScope"
  | "retainCleanup"
  | "createAdmission"
  | "stateDatabasePath"
  | "onNativeStopped"
  | "volatile"
  | "backendService"
> & { preparation?: unknown };
export type SqliteWorkerInputRetention = "snapshot" | "stream";
export type SqliteWorkerInputPreparation = {
  assertCurrent: () => void;
  /** Transfer to a dispatch that reaches enqueue synchronously, before returning its Promise. */
  handoff<T>(dispatch: () => Promise<T>): Promise<T>;
  release(): void;
};
