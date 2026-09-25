import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";

export class SessionMutationFactsUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session access facts are unavailable; retry after session storage is ready.", options);
    this.name = "SessionMutationFactsUnavailableError";
  }
}

export class SessionMutationAuthorizationChangedError extends Error {
  readonly error: ErrorShape;

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "SessionMutationAuthorizationChangedError";
    this.error = error;
  }
}

export type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};

export type ExpectedSessionMutationTarget = Readonly<{
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
}>;

export function sessionMutationTargetChanged(method: string, sessionKey: string) {
  return new SessionMutationAuthorizationChangedError(
    errorShape(ErrorCodes.INVALID_REQUEST, `session changed before ${method}; retry the request`, {
      details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED", method, sessionKey },
    }),
  );
}

export function expectedSessionMutationTargetError(
  expected: ExpectedSessionMutationTarget | undefined,
  target: SessionSharingTarget | null,
  method: string,
): ErrorShape | null {
  return expected &&
    (!target ||
      target.agentId !== expected.agentId ||
      target.canonicalKey !== expected.sessionKey ||
      target.storePath !== expected.storePath ||
      target.entry.sessionId?.trim() !== expected.sessionId)
    ? sessionMutationTargetChanged(method, expected.sessionKey).error
    : null;
}
