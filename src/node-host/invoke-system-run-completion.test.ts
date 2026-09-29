import { describe, expect, it, vi } from "vitest";
import { publishSystemRunCompletion } from "./invoke-system-run-completion.js";

describe("publishSystemRunCompletion", () => {
  it("publishes the terminal event when invoke-result delivery rejects", async () => {
    const sendInvokeResult = vi.fn(async () => {
      throw new Error("result transport failed");
    });
    const sendExecFinishedEvent = vi.fn(async () => undefined);
    const result = {
      exitCode: 0,
      timedOut: false,
      success: true,
      stdout: "done",
      stderr: "",
    };

    await publishSystemRunCompletion(
      { sendInvokeResult, sendExecFinishedEvent },
      {
        sessionKey: "agent:main:telegram:group:-100155462274:topic:42",
        runId: "run-1",
        commandText: "printf done",
        suppressNotifyOnExit: true,
        notifyOnExit: true,
      },
      result,
      JSON.stringify(result),
    );

    expect(sendInvokeResult).toHaveBeenCalledOnce();
    expect(sendExecFinishedEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        result,
        suppressNotifyOnExit: true,
        notifyOnExit: true,
        invokeResultSentFirst: true,
      }),
    );
  });
});
