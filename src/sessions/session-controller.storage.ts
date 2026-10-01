import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import type {
  SessionControllerEntry,
  ReplyOperationAdmission,
  ReplyOperationAfterClear,
  ReplyOperationSuccessorBarrierGroup,
} from "./session-controller.state.types.js";
const controllerState = resolveGlobalSingleton(Symbol.for("openclaw.sessionControllers"), () => ({
  controllers: new Map<string, SessionControllerEntry>(),
  entryByOperation: new WeakMap<ReplyOperation, SessionControllerEntry>(),
  lifecycleAdmissionByOperation: new WeakMap<ReplyOperation, ReplyOperationAdmission>(),
  evictOperationByOperation: new WeakMap<ReplyOperation, () => void>(),
  executionStartedOperations: new WeakSet<ReplyOperation>(),
  operationsByUpstreamAbortSignal: new WeakMap<AbortSignal, ReplyOperation>(),
  producerCompletionByOperation: new WeakMap<ReplyOperation, Promise<void>>(),
  afterClearByOperation: new WeakMap<ReplyOperation, ReplyOperationAfterClear>(),
  successorBarrierStartsByOperation: new WeakMap<ReplyOperation, Set<() => void>>(),
  successorBarrierGroupsByOperation: new WeakMap<
    ReplyOperation,
    Set<ReplyOperationSuccessorBarrierGroup>
  >(),
}));
export const sessionControllers = controllerState.controllers;
export const controllerEntryByOperation = controllerState.entryByOperation;
export const lifecycleAdmissionByOperation = controllerState.lifecycleAdmissionByOperation;

export const evictReplyOperationByOperation = controllerState.evictOperationByOperation;
export const executionStartedOperations = controllerState.executionStartedOperations;
export const operationsByUpstreamAbortSignal = controllerState.operationsByUpstreamAbortSignal;
export const producerCompletionByOperation = controllerState.producerCompletionByOperation;
export const afterClearByOperation = controllerState.afterClearByOperation;
export const successorBarrierStartsByOperation = controllerState.successorBarrierStartsByOperation;
export const successorBarrierGroupsByOperation = controllerState.successorBarrierGroupsByOperation;
