import { describe, expect, it, vi } from "vitest";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import { createDeferredCore } from "../shared/deferred.js";
import { applyQueueDropPolicy } from "../utils/queue-helpers.js";
import {
  generatePilotSequence,
  initialPilotState,
  stepPilot,
  stepPilotMailbox,
  type PilotCustody,
  type PilotEvent,
  type PilotInput,
  type PilotMailbox,
} from "./session-controller-model.test-support.js";
import type { ReplyMessageInjectionAttempt } from "./session-controller.contracts.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
  captureCurrentReplyMessageInjectionTarget,
} from "./session-controller.js";
import {
  beginSessionEffect,
  startSessionControllerInterruption,
} from "./session-controller.lifecycle.js";
import { beginReplyMessageInjectionTarget } from "./session-controller.message-injection.js";

/** Calls public owner operations, never the runtime reducer under test. */
async function replay(events: readonly PilotEvent[], label: string) {
  let model = initialPilotState();
  let live = true;
  let compacting = false;
  let injectionAvailable = true;
  let writer = true;
  const key = "agent:main:controller-pilot";
  const gates = new Map<
    string,
    ReturnType<typeof createDeferredCore<PilotEvent & { type: "receipt" }>>
  >();
  const attempts = new Map<string, ReplyMessageInjectionAttempt>();
  const custody = new Map<string, PilotCustody>();
  const effects: string[] = [];
  const deliveries: ReturnType<typeof createDeferredCore<void>>[] = [];
  const operations: ReturnType<typeof createReplyOperation>[] = [];
  const create = () => {
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "pilot-session",
      resetTriggered: false,
    });
    const delivery = createDeferredCore();
    deliveries.push(delivery);
    operations.push(operation);
    void operation.ownerSettlement?.then(() => {
      if (current.operation === operation) {
        writer = false;
      }
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "pilot-run",
      toolAuthorityFingerprint: "alice-policy",
      cancel: () => {
        effects.push("cancel");
      },
      isCompacting: () => compacting,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => injectionAvailable,
        async queueMessage(_text, options, assertCurrent) {
          const id = options?.queueIdentity;
          if (!id) {
            throw new Error("Missing input identity");
          }
          effects.push("inject:" + id);
          const gate = createDeferredCore<PilotEvent & { type: "receipt" }>();
          gates.set(id, gate);
          const receipt = await gate.promise;
          assertCurrent();
          if (receipt.outcome === "indeterminate") {
            throw new QuestionAnswerUnconfirmedError("unknown acceptance");
          }
          if (receipt.outcome === "rejected") {
            throw new Error("backend rejected");
          }
          options?.onQueueAccepted?.(true);
        },
      },
    });
    return { operation, delivery };
  };
  let current = create();
  const prefix: PilotEvent[] = [];
  try {
    for (const event of events) {
      prefix.push(event);
      const expected = stepPilot(model, event);
      const beforeEffects = effects.length;
      switch (event.type) {
        case "run":
          current.operation.setPhase("running");
          break;
        case "finish":
          current.operation.freezeAbort();
          break;
        case "stop":
          current.operation.abortByUser();
          break;
        case "injection-available":
          injectionAvailable = event.available;
          break;
        case "compact":
          compacting = event.active;
          break;
        case "revoke":
          live = false;
          break;
        case "complete":
          current.operation.completeWithAfterClearBarrier(current.delivery.promise);
          break;
        case "delivery-settled":
          current.delivery.resolve();
          await current.operation.ownerSettlement;
          break;
        case "replace":
          current = create();
          live = true;
          compacting = false;
          injectionAvailable = true;
          writer = true;
          break;
        case "offer": {
          const target = captureCurrentReplyMessageInjectionTarget(key);
          if (!target) {
            custody.set(event.input.id, "rejected");
            break;
          }
          const attempt = beginReplyMessageInjectionTarget(target, event.input.id, {
            queueIdentity: event.input.id,
            isInboundUserMessage: true,
            toolAuthorityFingerprint: event.input.authority,
            assertCurrent: () => {
              if (!live) {
                throw new Error("source revoked");
              }
            },
          });
          attempts.set(event.input.id, attempt);
          if (gates.has(event.input.id)) {
            custody.set(event.input.id, "offered");
          } else {
            custody.set(event.input.id, (await attempt.outcome).status);
          }
          break;
        }
        case "receipt": {
          const gate = gates.get(event.id);
          const attempt = attempts.get(event.id);
          if (!gate || !attempt) {
            break;
          }
          gate.resolve(event);
          const outcome = await attempt.outcome;
          custody.set(event.id, outcome.status);
          if (outcome.status === "accepted" || outcome.status === "indeterminate") {
            expect(await attempt.acceptance).toBe(true);
          }
          gates.delete(event.id);
          break;
        }
      }
      await Promise.resolve();
      model = expected.state;
      const context = label + " prefix=" + JSON.stringify(prefix);
      expect(getSessionControllerOperation(key) === current.operation, context).toBe(model.slot);
      expect(current.operation.abortSignal.aborted, context).toBe(model.cancelled);
      expect(writer, context).toBe(model.writer);
      expect(effects.slice(beforeEffects), context).toEqual(
        expected.effects.flatMap((effect) =>
          effect.type === "cancel"
            ? ["cancel"]
            : effect.type === "inject"
              ? ["inject:" + effect.input.id]
              : [],
        ),
      );
      for (const [id, input] of Object.entries(model.inputs)) {
        expect(custody.get(id), context).toBe(input.custody);
      }
    }
  } finally {
    for (const [id, gate] of gates) {
      gate.resolve({ type: "receipt", id, outcome: "accepted" });
    }
    for (const delivery of deliveries) {
      delivery.resolve();
    }
    for (const operation of operations) {
      operation.complete();
    }
    await Promise.all([...attempts.values()].map((attempt) => attempt.outcome));
    await Promise.all(operations.map((operation) => operation.ownerSettlement));
  }
}

describe("session controller executable pilot", () => {
  it("replays 2048 state-aware sequences with delayed receipts (48 generated steps each)", async () => {
    vi.useFakeTimers();
    try {
      for (let seed = 1; seed <= 2048; seed++) {
        await replay(generatePilotSequence(seed), "seed=" + seed);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps finishing cancellation separate from the backend injection capability", async () => {
    await replay(
      [
        { type: "run" },
        { type: "finish" },
        { type: "offer", input: { id: "still-available", authority: "alice-policy" } },
        { type: "receipt", id: "still-available", outcome: "accepted" },
        { type: "injection-available", available: false },
        { type: "offer", input: { id: "closed", authority: "alice-policy" } },
        { type: "stop" },
        { type: "complete" },
        { type: "delivery-settled" },
      ],
      "finishing capability",
    );
  });

  it("retains uncertain input custody while refusing another sender during compaction", async () => {
    await replay(
      [
        { type: "run" },
        { type: "compact", active: true },
        { type: "offer", input: { id: "other-sender", authority: "bob-policy" } },
        { type: "offer", input: { id: "uncertain", authority: "alice-policy" } },
        { type: "receipt", id: "uncertain", outcome: "indeterminate" },
        { type: "revoke" },
        { type: "stop" },
        { type: "complete" },
        { type: "delivery-settled" },
      ],
      "indeterminate custody",
    );
  });

  it("rejects a delayed receipt from a same-ID replaced operation", async () => {
    await replay(
      [
        { type: "run" },
        { type: "offer", input: { id: "old-input", authority: "alice-policy" } },
        { type: "complete" },
        { type: "delivery-settled" },
        { type: "replace" },
        { type: "run" },
        { type: "receipt", id: "old-input", outcome: "accepted" },
        { type: "complete" },
        { type: "delivery-settled" },
      ],
      "exact-instance replacement",
    );
  });

  it("keeps an interrupted lifecycle lease until the actual owner and delivery settle", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:pilot-lease",
      sessionId: "pilot-lease",
      resetTriggered: false,
    });
    operation.setPhase("running");
    const delivery = createDeferredCore();
    const lease = await beginSessionEffect({
      scope: "pilot-store",
      identities: [operation.key, operation.sessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        operation.abortByUser();
      },
    });
    const ownerReleased = operation.ownerSettlement.then(() => lease.release());
    let effectSettled = false;
    void lease.released.then(() => {
      effectSettled = true;
    });
    try {
      const interruption = startSessionControllerInterruption({
        scope: "pilot-store",
        identities: [operation.key],
      });
      expect(operation.abortSignal.aborted).toBe(true);
      expect(lease.isActive()).toBe(false);
      expect(effectSettled).toBe(false);
      await expect(lease.run(async () => {})).rejects.toThrow("Session effect interrupted");
      operation.completeWithAfterClearBarrier(delivery.promise);
      await Promise.resolve();
      expect(effectSettled).toBe(false);
      delivery.reject(new Error("delivery failed"));
      await ownerReleased;
      await interruption.released;
      expect(effectSettled).toBe(true);
      expect(lease.isActive()).toBe(false);
    } finally {
      delivery.resolve();
      operation.complete();
      await ownerReleased;
      lease.release();
    }
  });

  it.each(["old", "new"] as const)(
    "conserves overflow identities against the existing %s queue boundary",
    (dropPolicy) => {
      let model: PilotMailbox = { capacity: 2, waiting: [], retired: [] };
      const queue = {
        cap: 2,
        items: [] as PilotInput[],
        dropPolicy,
        droppedCount: 0,
        summaryLines: [] as string[],
      };
      const retired: string[] = [];
      for (let n = 0; n < 6; n++) {
        const input = { id: "mail-" + n, authority: n % 2 ? "alice-policy" : "bob-policy" };
        model = stepPilotMailbox(model, { type: "enqueue", input, overflow: dropPolicy }).state;
        if (
          applyQueueDropPolicy({
            queue,
            summarize: (item) => item.id,
            onDrop: (items) => retired.push(...items.map((item) => item.id)),
          })
        ) {
          queue.items.push(input);
        } else {
          retired.push(input.id);
        }
        expect(queue.items).toEqual(model.waiting);
        expect(retired).toEqual(model.retired);
        expect(queue.items.length + retired.length).toBe(n + 1);
      }
    },
  );
});
