import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  commitSetupInferenceActivation,
  type SetupInferenceConfigTarget,
} from "./setup-inference-transition.js";

it.each([
  "prepare-first",
  "undo-first",
  "no-write",
  "unclaimed",
  "inline",
  "rollback-failed",
] as const)("settles credential recovery once for %s activation", async (mode) => {
  const before: OpenClawConfig = { gateway: { mode: "local", port: 18789 } };
  const candidate: OpenClawConfig = { gateway: { mode: "local", port: 18790 } };
  let current = before;
  const activationFailure = new Error("activation owner changed");
  const rollbackFailure = new Error("newer credential preserved");
  const rollbackEntered = createDeferred();
  const rollback = vi.fn(() => {
    rollbackEntered.resolve();
    if (mode === "rollback-failed") {
      throw rollbackFailure;
    }
  });
  let complete: (() => Promise<boolean>) | undefined;
  const target: SetupInferenceConfigTarget = {
    read: async () => ({ config: current, write: target.write }),
    write: async (config, { captureUndo, writeOptions }) => {
      captureUndo(async (options) => {
        current = before;
        const application = getRuntimeConfigWriteApplication(options);
        if (mode === "prepare-first" || mode === "undo-first" || mode === "rollback-failed") {
          const claim = application?.claim();
          expect(claim).toBeTruthy();
          const apply = async () => {
            if (mode === "undo-first") {
              await rollbackEntered.promise;
            }
            try {
              await claim?.prepare?.(() => {});
              claim?.settle("applied");
            } catch {
              claim?.settle("failed");
            }
          };
          const applying = apply();
          if (mode !== "undo-first") {
            await applying;
          }
        }
        return { config: current, written: mode !== "no-write" };
      });
      current = config;
      const claim = getRuntimeConfigWriteApplication(writeOptions)?.claim();
      await claim?.prepare?.(() => {});
      claim?.settle("failed");
      return current;
    },
  };
  const activation = commitSetupInferenceActivation({
    configTarget: target,
    config: candidate,
    assertCurrent: () => {},
    activate: async () => ({
      rollback,
      assertCurrent: () => {
        throw activationFailure;
      },
    }),
    ...(mode !== "inline"
      ? {
          deferCompletion: (completion: () => Promise<boolean>) => {
            complete = completion;
          },
        }
      : {}),
  });
  const result = (async () => {
    await activation;
    return await complete?.();
  })();
  if (mode === "rollback-failed") {
    await expect(result).rejects.toMatchObject({
      cause: rollbackFailure,
      errors: [expect.any(Error), rollbackFailure],
    });
  } else if (mode === "inline") {
    await expect(result).rejects.toBe(activationFailure);
  } else {
    await expect(result).rejects.toThrow(
      mode === "unclaimed" ? "Gateway could not apply it" : "did not complete activation (failed)",
    );
  }
  expect(current).toEqual(before);
  expect(rollback).toHaveBeenCalledOnce();
});
