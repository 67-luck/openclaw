import { describe, expect, it, vi } from "vitest";
import { SessionPendingInputSettlementUnknownError } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { registerChatAbortController } from "../chat-abort.js";
import {
  captureGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createChatSendRunCleanup } from "./chat-send-work-admission.js";
import { createChatSendWorkAdmission } from "./chat-send-work-lifetime.js";

describe("retained chat work admission", () => {
  it.each(["resolve", "reject"] as const)(
    "joins caller close without pending input before run cleanup (%s)",
    async (outcome) => {
      const close = Promise.withResolvers<void>();
      const failure = new Error("caller close failed");
      const releaseAdmission = vi.fn();
      const releaseCallerAuthority = vi.fn(() => close.promise);
      const releaseRoot = vi.fn();
      const discardMedia = vi.fn();
      const controllers: Parameters<typeof registerChatAbortController>[0]["chatAbortControllers"] =
        new Map();
      const activeRunAbort = registerChatAbortController({
        chatAbortControllers: controllers,
        runId: "joined-caller-close",
        sessionId: "joined-caller-session",
        sessionKey: "agent:main:joined-caller-session",
        timeoutMs: 60_000,
        projectSessionActive: false,
      });
      const abortCleanup = vi.spyOn(activeRunAbort, "cleanup");
      const work = createChatSendWorkAdmission({
        admission: { release: releaseAdmission },
        releaseCallerAuthority,
        logGateway: { warn: vi.fn() },
      });
      const cleanup = createChatSendRunCleanup({
        activeRunAbort,
        retainedWork: work,
        releaseGatewayRootContinuation: releaseRoot,
      });
      cleanup.setDiscardAbandonedPreparedMedia(discardMedia);
      let joined: void | Promise<void> = undefined;
      try {
        expect(activeRunAbort.registered).toBe(true);
        expect(controllers.get("joined-caller-close")?.controller).toBe(activeRunAbort.controller);
        joined = cleanup.cleanupAdmittedRun();
        if (!joined) {
          throw new Error("Expected the original caller-close settlement");
        }
        expect(cleanup.cleanupAdmittedRun()).toBe(joined);
        expect(releaseAdmission).toHaveBeenCalledOnce();
        expect(releaseCallerAuthority).toHaveBeenCalledOnce();
        expect(abortCleanup).not.toHaveBeenCalled();
        expect(releaseRoot).not.toHaveBeenCalled();
        expect(discardMedia).not.toHaveBeenCalled();
        expect(controllers.get("joined-caller-close")?.controller).toBe(activeRunAbort.controller);
        if (outcome === "reject") {
          close.reject(failure);
          await expect(joined).rejects.toBe(failure);
          expect(cleanup.cleanupAdmittedRun()).toBe(joined);
          await expect(cleanup.cleanupAdmittedRun()).rejects.toBe(failure);
          expect(abortCleanup).not.toHaveBeenCalled();
          expect(releaseRoot).not.toHaveBeenCalled();
          expect(discardMedia).not.toHaveBeenCalled();
          expect(controllers.get("joined-caller-close")?.controller).toBe(
            activeRunAbort.controller,
          );
        } else {
          close.resolve();
          await joined;
          expect(cleanup.cleanupAdmittedRun()).toBe(joined);
          expect(abortCleanup).toHaveBeenCalledOnce();
          expect(releaseRoot).toHaveBeenCalledOnce();
          expect(discardMedia).toHaveBeenCalledOnce();
          expect(controllers.has("joined-caller-close")).toBe(false);
        }
        expect(releaseAdmission).toHaveBeenCalledOnce();
        expect(releaseCallerAuthority).toHaveBeenCalledOnce();
      } finally {
        close.resolve();
        await joined?.catch(() => {});
        abortCleanup.mockRestore();
        activeRunAbort.cleanup();
      }
    },
  );

  it.each(["success", "failure", "unknown"] as const)(
    "joins final input settlement before releasing caller custody (%s)",
    async (outcome) => {
      const events: string[] = [];
      const terminal = Promise.withResolvers<void>();
      const callerClose = Promise.withResolvers<void>();
      const callerClosing = Promise.withResolvers<void>();
      const caller = captureGatewayDeviceRevocation(
        {},
        { deviceId: "joined-device", role: "operator" },
        () => true,
      );
      const releaseCaller = retainGatewayDeviceRevocation(caller.isCurrent);
      const work = createChatSendWorkAdmission({
        admission: {
          release: () => {
            events.push("admission");
          },
        },
        releaseCallerAuthority: () => {
          events.push("caller");
          releaseCaller?.();
          callerClosing.resolve();
          return callerClose.promise;
        },
        logGateway: { warn: vi.fn() },
      });
      work.setPendingInputCleanup(() => {
        events.push("finish");
        return terminal.promise;
      });
      caller.release();
      try {
        const joined = work.release();
        expect(work.release()).toBe(joined);
        expect(events).toEqual(["finish"]);
        expect(caller.isCurrent()).toBe(true);
        const failure =
          outcome === "unknown"
            ? new SessionPendingInputSettlementUnknownError()
            : new Error("known disposition failure");
        if (outcome === "success") {
          terminal.resolve();
        } else {
          terminal.reject(failure);
        }
        if (outcome === "unknown") {
          await expect(joined).rejects.toBe(failure);
          await expect(work.release()).rejects.toBe(failure);
          expect(events).toEqual(["finish"]);
          expect(caller.isCurrent()).toBe(true);
        } else {
          let settled = false;
          void joined?.then(() => {
            settled = true;
          });
          await callerClosing.promise;
          expect(settled).toBe(false);
          callerClose.resolve();
          await joined;
          expect(events).toEqual(["finish", "admission", "caller"]);
          expect(caller.isCurrent()).toBe(false);
        }
      } finally {
        callerClose.resolve();
        // This unit test owns only the retained caller fixture, not a native UNKNOWN recovery.
        releaseCaller?.();
      }
    },
  );

  it.each([false, true])(
    "keeps caller custody through collected work (cleanup failure: %s)",
    (failCleanup) => {
      const caller = captureGatewayDeviceRevocation(
        {},
        { deviceId: "device", role: "operator" },
        () => true,
      );
      const releaseAdmission = vi.fn();
      const warn = vi.fn();
      const work = createChatSendWorkAdmission({
        admission: { release: releaseAdmission },
        releaseCallerAuthority: retainGatewayDeviceRevocation(caller.isCurrent),
        logGateway: { warn },
      });
      const finishPendingInput = vi.fn(() => {
        if (failCleanup) {
          throw new Error("pending input write failed");
        }
      });
      work.setPendingInputCleanup(finishPendingInput);
      const releaseCollectedTurn = work.retain();
      caller.release();
      expect(work.release()).toBeUndefined();
      expect(work.release()).toBeUndefined();

      expect(work.isActive()).toBe(true);
      expect(caller.isCurrent()).toBe(true);
      expect(finishPendingInput).not.toHaveBeenCalled();
      expect(releaseAdmission).not.toHaveBeenCalled();

      expect(releaseCollectedTurn()).toBeUndefined();
      expect(releaseCollectedTurn()).toBeUndefined();
      expect(work.isActive()).toBe(false);
      expect(caller.isCurrent()).toBe(false);
      expect(finishPendingInput).toHaveBeenCalledOnce();
      expect(releaseAdmission).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(failCleanup ? 1 : 0);
      expect(() => work.retain()).toThrow("cannot retain a released chat work admission");
    },
  );
});
