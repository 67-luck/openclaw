import { expect, it } from "vitest";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "./session-controller.mailbox.js";

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
