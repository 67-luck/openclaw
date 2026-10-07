import type { SessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { ActiveWorkerPlacement, WorkerTurnEnvironmentService } from "./worker-turn-failure.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

type RedispatchableWorkerPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" | "failed" }
>;

export type WorkerTurnLauncherOptions = {
  withRequiredSession?: SessionPlacementAdmissionProvider["withRequiredSession"];
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  resolveWorkspace: (identity: {
    sessionId: string;
    agentId: string;
    sessionKey: string;
  }) => Promise<WorkerSessionWorkspace>;
  reconcileActivePlacement: (environmentId: string) => Promise<void>;
  waitForAdmissionNode: (params: {
    placement: ActiveWorkerPlacement;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  waitForInitialPlacement?: (
    placement: WorkerSessionPlacementRecord,
    signal?: AbortSignal,
  ) => Promise<WorkerSessionPlacementRecord>;
  redispatchPlacement: (
    placement: RedispatchableWorkerPlacement,
    options: { assertCurrent: () => void; signal?: AbortSignal },
  ) => Promise<ActiveWorkerPlacement>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
};
