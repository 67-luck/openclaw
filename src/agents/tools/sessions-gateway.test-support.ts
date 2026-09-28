import { expect } from "vitest";

/** Routing fixtures have no issued operator runtime; real identity transport has its own tests. */
export function createSessionGatewayMock(
  call: (request: unknown) => unknown,
  create: (method: unknown, params: unknown, creation: unknown) => unknown,
  hasContext: () => boolean,
) {
  return {
    callAgentToolGatewayRequest: call,
    callInProcessGatewayToolWithCreation: create,
    hasInProcessGatewayToolContext: hasContext,
    getInProcessGatewayToolContext: () => undefined,
    hasGatewayToolRoutingContext: () => false,
    runWithGatewayToolCleanupContext: <T>(run: () => T): T => run(),
    runWithGatewayToolContinuationContext: async <T>(run: () => Promise<T>): Promise<T> => run(),
    withAgentToolGatewayRuntimeIdentity: <T extends object>(request: T, identity: unknown): T => {
      expect(identity, "routing fixtures must not invent issued runtime authority").toBeUndefined();
      return request;
    },
  };
}
