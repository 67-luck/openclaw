import { expect, it } from "vitest";
import {
  NodeSystemRunEventAuthority,
  resolveNodeSystemRunEventDeliveryContext,
  shouldSuppressRun,
} from "./node-system-run-event-authority.js";

it("returns the stored invocation session, not a terminal-selected alias", () => {
  const owner = new NodeSystemRunEventAuthority();
  const identity = {
    nodeId: "node-1",
    connId: "conn-1",
    runId: "bound-run",
    sessionKey: "agent:main:main",
    turnSourceAccountId: "work",
  };
  owner.remember(identity);
  expect(
    owner.authorize({
      ...identity,
      sessionKey: "agent:main:telegram:work:direct:123456789",
      terminal: false,
      allowLegacyRunIdFallback: false,
    }),
  ).toBeNull();
  expect(owner.authorize({ ...identity, terminal: true, allowLegacyRunIdFallback: false })).toEqual(
    {
      invokeResultReceived: false,
      invocationSessionKey: identity.sessionKey,
      turnSourceAccountId: "work",
    },
  );
});

it("sessionless authorization retains an ordinary notice but grants no captured recovery route", () => {
  const owner = new NodeSystemRunEventAuthority();
  const identity = { nodeId: "node-1", connId: "conn-1", runId: "sessionless-run" };
  owner.remember(identity);
  const authorization = owner.authorize({
    ...identity,
    sessionKey: "agent:main:telegram:work:direct:123456789",
    terminal: true,
    allowLegacyRunIdFallback: false,
  });
  expect(authorization).toEqual({ invokeResultReceived: false });
  const route = { channel: "telegram", to: "123456789", accountId: "work" };
  expect(resolveNodeSystemRunEventDeliveryContext(route, authorization)).toBeUndefined();
  expect(
    shouldSuppressRun(
      { suppressNotifyOnExit: true, invokeResultSentFirst: true },
      authorization,
      route,
      undefined,
    ),
  ).toBe(true);
  expect(shouldSuppressRun({ suppressNotifyOnExit: false }, authorization, route, undefined)).toBe(
    false,
  );
});
