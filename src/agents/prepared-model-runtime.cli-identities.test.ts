import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getSessionDefaults,
  resolveSessionDisplayModelIdentityRefCached,
} from "../gateway/session-utils-model.js";
import {
  adoptProcessPluginCache,
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getProcessPluginCache,
  getPluginCacheRetirementSignal,
  retirePluginCache,
} from "../plugins/plugin-cache.js";
import * as moduleLoader from "../plugins/plugin-instance-module-loader.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as sourceCapture from "../plugins/plugin-source-capture-directory.js";
import { resolvePluginSourceCapturesDirectory } from "../plugins/plugin-source-capture-path.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCliBackendModelIdentitiesWithSource } from "./cli-backends.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { readPreparedModelRuntimeCliBackendModels } from "./prepared-model-runtime-auth.js";
import { backendId, writeSetupFixture } from "./prepared-model-runtime.cli-fixture.test-support.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

afterEach(() => cliBackendsTesting.resetDepsForTest());

function readRequiredCliBackendModels(snapshot: object) {
  const models = readPreparedModelRuntimeCliBackendModels(snapshot);
  if (models === undefined) {
    throw new Error("Expected CLI identities bound to the prepared snapshot");
  }
  return models;
}

it.each(["canonical", "standalone", "disabled", "ambiguous", "no-runtime", "refused"] as const)(
  "retains read-only setup CLI identity facts for %s without a display-time setup lookup",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pluginId = "setup-identity-owner";
      const root = await writeSetupFixture(
        state,
        pluginId,
        mode === "standalone" ? undefined : "canonical-fixture",
        mode === "refused",
        undefined,
        mode !== "no-runtime",
      );
      const paths = [root];
      const allowed = [pluginId];
      if (mode === "ambiguous") {
        allowed.push("setup-identity-other");
        paths.push(await writeSetupFixture(state, allowed[1]!, "other-fixture"));
      }
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: `${backendId}/brief`, utilityModel: "" },
        },
        plugins: {
          allow: allowed,
          load: { paths },
          entries: Object.fromEntries(allowed.map((id) => [id, { enabled: mode !== "disabled" }])),
        },
      };
      const unavailable =
        mode === "disabled" || mode === "ambiguous" || mode === "no-runtime"
          ? vi
              .spyOn(sourceCapture, "acquirePluginSourceCaptureScope")
              .mockRejectedValue(
                new Error("Metadata-only CLI facts cannot acquire capture custody"),
              )
          : undefined;
      using _ = {
        [Symbol.dispose]() {
          unavailable?.mockRestore();
        },
      };
      await using lease = await acquireReadOnlyPreparedModelRuntime(
        {
          agentId: "main",
          agentDir: state.agentDir(),
          env: state.env,
          config: cfg,
          skipCredentials: true,
        },
        { catalogMode: "static" },
      );
      if (unavailable) {
        expect(unavailable.mock.calls.length).toBe(0);
      }
      const { snapshot } = lease;
      const cliBackendModels = readRequiredCliBackendModels(snapshot);
      expect(snapshot.pluginRegistry).toBeUndefined();
      const expectedProvider = mode === "canonical" ? "canonical-fixture" : backendId;
      expect(cliBackendModels).toEqual(
        mode === "disabled"
          ? []
          : [
              {
                id: backendId,
                ...(mode === "canonical" ? { modelProvider: "canonical-fixture" } : {}),
              },
            ],
      );
      expect(Object.isFrozen(cliBackendModels)).toBe(true);
      for (const identity of cliBackendModels) {
        expect(Object.isFrozen(identity)).toBe(true);
      }
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => {
          throw new Error("Display reopened runtime lookup");
        },
        resolvePluginSetupCliBackend: () => {
          throw new Error("Display reopened setup lookup");
        },
      });
      const sql = observeMainThreadSql();
      try {
        sql.calibrate();
        withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot.metadataSnapshot }, () => {
          const prepared = {
            metadataSnapshot: snapshot.metadataSnapshot,
            preparedCliBackendModels: cliBackendModels,
          };
          expect(
            resolveSessionDisplayModelIdentityRefCached({
              cfg,
              provider: backendId,
              model: "brief",
              ...prepared,
            }),
          ).toEqual({ provider: expectedProvider, model: "brief" });
          expect(
            getSessionDefaults(cfg, [], {
              agentId: "main",
              allowPluginNormalization: false,
              providerPolicySource: "active",
              ...prepared,
            }),
          ).toMatchObject({ modelProvider: expectedProvider, model: "brief" });
        });
        sql.expectIdle();
      } finally {
        sql.restore();
        cliBackendsTesting.resetDepsForTest();
      }
    });
  },
);

it("keeps compatible passive views runtime-first without reusing facts across activation changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pluginId = "runtime-identity-owner";
    const root = await writeSetupFixture(
      state,
      pluginId,
      "setup-fixture",
      false,
      "runtime-fixture",
    );
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model: `${backendId}/brief`, utilityModel: "" },
      },
      plugins: {
        allow: [pluginId],
        load: { paths: [root] },
        entries: { [pluginId]: { enabled: true } },
      },
    };
    const input = {
      agentId: "main",
      agentDir: state.agentDir(),
      env: state.env,
      config: cfg,
      skipCredentials: true,
    };
    await using full = await acquireAgentRunPreparedModelRuntime(
      {
        ...input,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: backendId, modelId: "brief", runtime: backendId }],
      },
      { catalogMode: "static" },
    );
    expect(full.snapshot.pluginRegistry).toBeDefined();
    expect(readRequiredCliBackendModels(full.snapshot)).toEqual([
      { id: backendId, modelProvider: "runtime-fixture" },
    ]);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => {
        throw new Error("Passive view reopened setup lookup");
      },
    });
    try {
      await using passive = await acquireReadOnlyPreparedModelRuntime(input, {
        catalogMode: "static",
        pluginGeneration: full.pluginGeneration,
      });
      expect(passive.snapshot.pluginRegistry).toBeUndefined();
      expect(readRequiredCliBackendModels(passive.snapshot)).toEqual([
        { id: backendId, modelProvider: "runtime-fixture" },
      ]);
      await using nextPassive = await acquireReadOnlyPreparedModelRuntime(
        { ...input, agentDir: state.path("second-agent") },
        { catalogMode: "static", pluginGeneration: passive.pluginGeneration },
      );
      expect(nextPassive.snapshot.pluginRegistry).toBeUndefined();
      expect(readRequiredCliBackendModels(nextPassive.snapshot)).toEqual([
        { id: backendId, modelProvider: "runtime-fixture" },
      ]);
      await using disabled = await acquireReadOnlyPreparedModelRuntime(
        {
          ...input,
          config: {
            ...cfg,
            plugins: { ...cfg.plugins, entries: { [pluginId]: { enabled: false } } },
          },
        },
        { catalogMode: "static", pluginGeneration: passive.pluginGeneration },
      );
      expect(disabled.snapshot.pluginRegistry).toBeUndefined();
      expect(readRequiredCliBackendModels(disabled.snapshot)).toEqual([]);
      expect(readRequiredCliBackendModels(full.snapshot)).toEqual([
        { id: backendId, modelProvider: "runtime-fixture" },
      ]);
    } finally {
      cliBackendsTesting.resetDepsForTest();
    }
  });
});

it.each([
  "retained-cache",
  "build-withdrawal",
  "release-withdrawal",
  "cache-retirement",
  "bind-refusal",
] as const)("keeps prepared setup source custody through %s", async (mode) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pluginId = "captured-cli-owner";
    const root = await writeSetupFixture(state, pluginId, "captured-provider");
    const marker = state.path("setup-registered.txt");
    const event = "openclaw-prepared-cli-fixture-disposed";
    const withdrawalEvent = `${event}:withdraw`;
    const disposed = vi.fn();
    await state.writeText(
      path.join("cli-identity-plugins", pluginId, "setup-api.cjs"),
      `module.exports = { register(api) {
          require("node:fs").writeFileSync(${JSON.stringify(marker)}, "registered");
          api.lifecycle.onDispose(() => process.emit(${JSON.stringify(event)}, "captured"));
          api.registerCliBackend({ id: ${JSON.stringify(backendId)}, modelProvider: "captured-provider", config: { command: "unused" } });
          ${mode === "release-withdrawal" ? `queueMicrotask(() => process.emit(${JSON.stringify(withdrawalEvent)}));` : ""}
        } };\n`,
    );
    const previous = getProcessPluginCache();
    const captured = createPluginCache({ kind: "process" });
    const successor = createPluginCache({ kind: "process" });
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: pluginId,
          rootDir: root,
          source: path.join(root, "index.cjs"),
          setupSource: path.join(root, "setup-api.cjs"),
          origin: "config",
          cliBackends: [backendId],
          setup: { requiresRuntime: true, cliBackends: [backendId] },
        },
      ],
    });
    bindPluginMetadataSnapshotCache(metadataSnapshot, captured);
    process.on(event, disposed);
    adoptProcessPluginCache(successor);
    const admitted = createDeferredCore<string>();
    const resume = createDeferredCore();
    const acquire = sourceCapture.acquirePluginSourceCaptureScope;
    const held = vi
      .spyOn(sourceCapture, "acquirePluginSourceCaptureScope")
      .mockImplementationOnce(async (...args) => {
        const original = await acquire(...args);
        let returned = false;
        try {
          const captures = resolvePluginSourceCapturesDirectory(state.stateDir);
          const roots = fs.readdirSync(captures);
          expect(roots.length).toBe(1);
          admitted.resolve(path.join(captures, roots[0]!));
          await resume.promise;
          returned = true;
          return original;
        } finally {
          if (!returned) {
            await original.release();
          }
        }
      });
    const binding =
      mode === "bind-refusal"
        ? vi.spyOn(moduleLoader, "bindPluginInstanceModuleLoader")
        : undefined;
    const resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    let withdrawal: Promise<void> | undefined;
    const withdrawn = createDeferredCore();
    const withdrawBuild = () => {
      withdrawal = resources[Symbol.asyncDispose]();
      withdrawn.resolve();
    };
    process.on(withdrawalEvent, withdrawBuild);
    const preparing = withPluginRuntimeGenerationScope(
      { metadataSnapshot },
      async () =>
        await prepareCliBackendModelIdentitiesWithSource(
          {
            config: {
              plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
            },
            env: state.env,
            metadataSnapshot,
            runtimeBackends: [],
          },
          (read) => resources.prepareSetup(read, () => {}),
        ),
    );
    const settled = Promise.allSettled([preparing]);
    try {
      const captureRoot = await Promise.race([
        admitted.promise,
        preparing.then(() => {
          throw new Error("Setup preparation bypassed capture admission");
        }),
      ]);
      expect(fs.existsSync(marker)).toBe(false);
      if (mode === "build-withdrawal") {
        await resources[Symbol.asyncDispose]();
      }
      if (mode === "cache-retirement") {
        await retirePluginCache(captured);
      }
      if (mode === "bind-refusal") {
        fs.writeFileSync(path.join(root, "package.json"), "{ invalid");
      }
      resume.resolve();
      if (mode === "release-withdrawal") {
        await Promise.race([
          withdrawn.promise,
          preparing.then(() => {
            throw new Error("Setup preparation settled before actual release withdrawal");
          }),
        ]);
        expect(fs.existsSync(marker)).toBe(true);
      }
      if (mode === "build-withdrawal" || mode === "release-withdrawal") {
        await expect(preparing).rejects.toThrow(
          "Prepared registry construction resources have been released",
        );
      } else if (mode === "cache-retirement") {
        await expect(preparing).rejects.toBe(getPluginCacheRetirementSignal(captured).reason);
      } else {
        const identities = await preparing;
        expect(identities).toEqual([
          {
            id: backendId,
            ...(mode === "retained-cache" ? { modelProvider: "captured-provider" } : {}),
          },
        ]);
        await resources[Symbol.asyncDispose]();
        if (mode === "retained-cache") {
          expect(fs.existsSync(marker)).toBe(true);
          expect(fs.existsSync(captureRoot)).toBe(true);
          expect(disposed).not.toHaveBeenCalled();
          await retirePluginCache(captured);
          expect(disposed).toHaveBeenCalledExactlyOnceWith("captured");
          expect(identities).toEqual([{ id: backendId, modelProvider: "captured-provider" }]);
        } else {
          expect(
            binding?.mock.calls.some(
              ([params]) => params.source === path.join(root, "setup-api.cjs"),
            ),
          ).toBe(true);
        }
      }
      if (mode === "release-withdrawal") {
        expect(withdrawal !== undefined).toBe(true);
        await withdrawal;
        expect(fs.existsSync(marker)).toBe(true);
        expect(fs.existsSync(captureRoot)).toBe(true);
      } else if (mode !== "retained-cache") {
        expect(fs.existsSync(marker)).toBe(false);
      }
      await resources[Symbol.asyncDispose]();
      await retirePluginCache(captured);
      expect(fs.existsSync(captureRoot)).toBe(false);
      if (mode === "release-withdrawal") {
        expect(disposed).toHaveBeenCalledExactlyOnceWith("captured");
      } else if (mode !== "retained-cache") {
        expect(disposed).not.toHaveBeenCalled();
      }
    } finally {
      resume.resolve();
      await settled;
      try {
        await resources[Symbol.asyncDispose]();
        await Promise.all([retirePluginCache(captured), retirePluginCache(successor)]);
      } finally {
        adoptProcessPluginCache(previous);
        process.off(event, disposed);
        process.off(withdrawalEvent, withdrawBuild);
        held.mockRestore();
        binding?.mockRestore();
      }
    }
  });
});
