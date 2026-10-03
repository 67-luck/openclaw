// Subagent announce dispatch tests lock down direct-vs-steer ordering for
// progress updates and completion messages.
import { describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceDispatch } from "./subagent-announce-dispatch.js";

describe("runSubagentAnnounceDispatch", () => {
  async function runNonCompletionDispatch(params: {
    steerOutcome: "none" | "steered";
    directDelivered?: boolean;
  }) {
    const steer = vi.fn(async () => ({ status: params.steerOutcome }) as const);
    const direct = vi.fn(async () => ({
      delivered: params.directDelivered ?? true,
      path: "direct" as const,
    }));
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      steer,
      direct,
    });
    return { steer, direct, result };
  }

  it("uses steer-first ordering for non-completion mode", async () => {
    const { steer, direct, result } = await runNonCompletionDispatch({ steerOutcome: "none" });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.path).toBe("direct");
    expect(result.reason).toBeUndefined();
  });

  it("short-circuits direct send when non-completion steering delivers", async () => {
    const { steer, direct, result } = await runNonCompletionDispatch({ steerOutcome: "steered" });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("steered");
  });

  it("does not direct-fallback when steering loses source ownership", async () => {
    const steer = vi.fn(async () => ({ status: "source_owner_changed" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      steer,
      direct,
    });

    expect(direct).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
    });
  });

  it.each([true, false])(
    "never steers when direct delivery is required and direct delivery succeeds: %s",
    async (delivered) => {
      const steer = vi.fn(async () => ({ status: "steered" }) as const);
      const direct = vi.fn(async () => ({
        delivered,
        path: "direct" as const,
        ...(delivered ? {} : { error: "direct delivery failed" }),
      }));

      const result = await runSubagentAnnounceDispatch({
        expectsCompletionMessage: false,
        requireDirectDelivery: true,
        steer,
        direct,
      });

      expect(direct).toHaveBeenCalledOnce();
      expect(steer).not.toHaveBeenCalled();
      expect(result.delivered).toBe(delivered);
      expect(result.path).toBe("direct");
      expect(result.error).toBe(delivered ? undefined : "direct delivery failed");
    },
  );

  it("keeps completion delivery in the direct followup lane", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(result.path).toBe("direct");
  });

  it("does not fall through to direct delivery when non-completion steering drops the new item", async () => {
    const steer = vi.fn(async () => ({ status: "dropped" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      steer,
      direct,
    });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      reason: "steer_dropped",
    });
  });

  it("returns none immediately when signal is already aborted", async () => {
    const steer = vi.fn(async () => ({ status: "none" }) as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      steer,
      direct,
    });

    expect(steer).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
    });
  });
});
