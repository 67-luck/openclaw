import { afterEach, describe, expect, it } from "vitest";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import {
  getSessionControllerEntry,
  sessionControllers,
  type SessionControllerEntry,
} from "./session-controller.state.js";

afterEach(() => {
  sessionControllers.clear();
});

it.each([false, true])(
  "does not borrow an ambient owner for another reserved input (operation=%s)",
  async (materialize) => {
    const target = captureSessionTarget({
      storeScope: "/synthetic/ambient-input/sessions.json",
      sessionKey: `agent:main:ambient-input-${materialize}`,
      incarnation: "incarnation",
    });
    const params = {
      target,
      sessionKey: target.sessionKey,
      ...(materialize ? { sessionId: target.incarnation } : {}),
    };
    let input: ReturnType<typeof reserveSessionControllerSource> | undefined;
    let nested: Promise<void> | undefined;
    let nestedStarted = false;
    let nestedOwnedInput = false;
    try {
      const startedInsidePredecessor = await withSessionTurn(params, async () => {
        const reserved = reserveSessionControllerSource(target.sessionKey, {
          target,
          policy: { mode: "followup" },
        });
        input = reserved;
        nested = withSessionTurn({ ...params, controllerInput: reserved }, async () => {
          nestedStarted = true;
          nestedOwnedInput = reserved.claim?.inputs.includes(reserved) === true;
        });
        await Promise.resolve();
        return nestedStarted;
      });
      await nested;
      expect(startedInsidePredecessor).toBe(false);
      expect(nestedStarted).toBe(true);
      expect(nestedOwnedInput).toBe(true);
    } finally {
      if (input) {
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
      await nested;
    }
  },
);

describe("turn admission parity", () => {
  it.each(
    (["visible", "heartbeat", "queued_followup", "direct"] as const).flatMap((kind) => [
      { kind, blocked: false },
      { kind, blocked: true },
    ]),
  )(
    "makes the mailbox and direct creation agree for $kind (blocked=$blocked)",
    async ({ kind, blocked }) => {
      const sessionKey = `agent:main:admission-parity:${kind}:${blocked}`;
      const entry = getSessionControllerEntry(sessionKey);
      const input = reserveSessionControllerSource(sessionKey, { policy: { mode: "followup" } });
      if (blocked) {
        entry.followupBarrier = {} as NonNullable<SessionControllerEntry["followupBarrier"]>;
      }

      const claim = tryClaimSessionControllerTask(input, kind);
      expect(Boolean(claim)).toBe(!blocked);
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      const create = () => {
        operation = createReplyOperation({
          sessionKey,
          sessionId: `session-${kind}`,
          resetTriggered: false,
          turnKind: kind,
          mailboxClaim: claim,
        });
      };
      if (blocked) {
        expect(create).toThrow("Reply follow-up admission is blocked");
      } else {
        expect(create).not.toThrow();
      }

      operation?.complete();
      if (claim) {
        releaseSessionControllerClaim(claim);
        await claim.settlement.promise;
      } else {
        entry.followupBarrier = undefined;
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
    },
  );
});
