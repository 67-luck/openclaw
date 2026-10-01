// Queue cleanup preserves independent command lanes and normalized source accounting.
import { expect, it, vi } from "vitest";
import {
  enqueueCommandInLane,
  getQueueSize,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { captureSessionControllerSourceSettlement } from "../../../sessions/session-controller.mailbox.js";
import { createQueueSettings, createQueueTestRun } from "../queue.test-helpers.js";
import { clearSessionQueues } from "./cleanup.js";
import { enqueueFollowupRun } from "./enqueue.js";
import { getExistingFollowupQueue } from "./state.js";

it("clears each normalized mailbox without clearing independent command lanes", async () => {
  // The former adapter derived this command lane from the cleared logical key.
  const lane = "session:alpha";
  setCommandLaneConcurrency(lane, 0);
  const execute = vi.fn(async () => "independent work");
  const pending = enqueueCommandInLane(lane, execute);
  try {
    const sources = ["alpha", "session:beta"].flatMap((key) =>
      ["first", "second"].map((prompt) => {
        const run = createQueueTestRun({ prompt });
        enqueueFollowupRun(key, run, createQueueSettings(), "none", undefined, false);
        return run;
      }),
    );
    const result = clearSessionQueues([
      " alpha ",
      undefined,
      "",
      " \t ",
      "alpha",
      " session:beta ",
      "session:beta",
    ]);
    expect(result).toEqual({ followupCleared: 4, laneCleared: 0, keys: ["alpha", "session:beta"] });
    await Promise.all(
      sources.map((run) => captureSessionControllerSourceSettlement(run.controllerInput!)),
    );
    expect(getExistingFollowupQueue("alpha")).toBeUndefined();
    expect(getExistingFollowupQueue("session:beta")).toBeUndefined();
    expect(getQueueSize(lane)).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    setCommandLaneConcurrency(lane, 1);
    await expect(pending).resolves.toBe("independent work");
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    setCommandLaneConcurrency(lane, 1);
    await pending;
  }
});
