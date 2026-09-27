import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as databaseIdentity from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  captureActiveOpenClawAgentHostExecution,
  captureOpenClawAgentHostExecution,
  runOpenClawAgentWriteAdmission,
  runReadyOpenClawAgentWriteAdmission,
} from "./openclaw-agent-write-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function aliasFixture() {
  const root = await fs.realpath(tempDirs.make("agent-write-target-"));
  const original = path.join(root, "original.sqlite");
  const alias = path.join(root, "alias.sqlite");
  await fs.writeFile(original, "original");
  await fs.symlink(original, alias);
  return {
    root,
    original: { agentId: "main", path: original },
    alias: { agentId: "main", path: alias },
  };
}

it.skipIf(process.platform === "win32")(
  "shares canonical queued, ready and host admission without letting an alias bypass a writer",
  async () => {
    const { original, alias } = await aliasFixture();
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    let host: ReturnType<typeof captureOpenClawAgentHostExecution> | undefined;
    const running = runOpenClawAgentWriteAdmission(original, async () => {
      host = captureOpenClawAgentHostExecution(alias);
      expect(captureActiveOpenClawAgentHostExecution(alias)).toBeDefined();
      expect(host.run(() => runReadyOpenClawAgentWriteAdmission(alias, () => "ready"))).toBe(
        "ready",
      );
      entered.resolve();
      await finish.promise;
    });
    try {
      await Promise.race([entered.promise, running]);
      expect(host).toBeDefined();
      expect(captureActiveOpenClawAgentHostExecution(alias)).toBeUndefined();
      const bypass = vi.fn();
      expect(() => runReadyOpenClawAgentWriteAdmission(alias, bypass)).toThrow("quiescent store");
      expect(bypass).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await running;
    }
    expect(() => host?.run(() => "stale")).toThrow("not active");
    expect(() => host?.beginNative()).toThrow("not active");
  },
);

it.skipIf(process.platform === "win32")(
  "retains both original and requested-alias fences across a native host continuation",
  async () => {
    const { root, original, alias } = await aliasFixture();
    const replacement = path.join(root, "replacement.sqlite");
    await fs.writeFile(replacement, "replacement");
    await runOpenClawAgentWriteAdmission(original, async () => {
      const host = captureOpenClawAgentHostExecution(alias);
      const native = host.beginNative();
      try {
        await fs.unlink(alias.path);
        await fs.symlink(replacement, alias.path);
        const enter = vi.fn();
        expect(() => native.runHostStep(enter)).toThrow("target changed");
        expect(enter).not.toHaveBeenCalled();
      } finally {
        native.settle();
      }
      expect(() => host.run(() => "replacement")).toThrow("target changed");
      expect(() => host.beginNative()).toThrow("target changed");
      expect(runReadyOpenClawAgentWriteAdmission(original, () => "original")).toBe("original");
    });
  },
);

it.skipIf(process.platform === "win32")(
  "does not adopt a replacement through the original alias during ready reentry",
  async () => {
    const { root, original, alias } = await aliasFixture();
    const replacement = path.join(root, "replacement.sqlite");
    await fs.writeFile(replacement, "replacement");
    await runOpenClawAgentWriteAdmission(alias, async () => {
      const host = captureOpenClawAgentHostExecution(original);
      await fs.unlink(alias.path);
      await fs.symlink(replacement, alias.path);
      expect(() => runReadyOpenClawAgentWriteAdmission(alias, () => "replacement")).toThrow(
        "target changed",
      );
      expect(() => host.run(() => "original")).toThrow("target changed");
    });
  },
);

it("keeps the incognito sentinel lexical without probing a physical database", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-write-incognito-") };
  const options = {
    agentId: "main",
    env,
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const inspect = vi.spyOn(databaseIdentity, "readDatabasePathIdentitySync");
  await runOpenClawAgentWriteAdmission(options, async (identity) => {
    expect(identity.canonicalPath).toBe(options.path);
    const host = captureOpenClawAgentHostExecution(options);
    expect(host.run(() => runReadyOpenClawAgentWriteAdmission(options, () => "private"))).toBe(
      "private",
    );
  });
  expect(inspect).not.toHaveBeenCalled();
});
