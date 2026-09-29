import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginCache,
  getPluginMetadataSnapshotCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { resolvePluginSetupRegistry } from "./setup-registry.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

describe("bundled setup code identity", () => {
  it.each(["cjs", "mjs"])(
    "reuses bundled %s setup code while retiring each inventory's callbacks",
    async (extension) => {
      const event = `bundled-setup-evaluation-${extension}`;
      const evaluated = vi.fn();
      process.on(event, evaluated);
      const rootDir = temp.make("bundled-setup-identity-");
      const source = path.join(rootDir, `setup-api.${extension}`);
      const record = {
        id: "bundled-owner",
        origin: "bundled",
        rootDir,
        source,
        setupSource: source,
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        channels: [],
        providers: ["bundled-owner"],
        cliBackends: [],
        skills: [],
        hooks: [],
        setup: { requiresRuntime: true, providers: [{ id: "bundled-owner" }] },
      } satisfies PluginManifestRegistry["plugins"][number];
      const definition = `{
        register(api) {
          const registration = ++registrations;
          api.registerProvider({ id: "bundled-owner", label: "Bundled setup", auth: [],
            resolveConfigApiKey: () => String(registration),
          });
        }
      }`;
      fs.writeFileSync(
        source,
        `process.emit(${JSON.stringify(event)}); let registrations = 0;
        ${extension === "mjs" ? "export default" : "module.exports ="} ${definition};`,
      );
      const manifestRegistry: PluginManifestRegistry = {
        plugins: [record],
        diagnostics: [],
      };
      const caches = Array.from({ length: 3 }, () => createPluginCache());
      try {
        let previous:
          | ReturnType<typeof resolvePluginSetupRegistry>["providers"][number]["provider"]
          | undefined;
        for (const [index, cache] of caches.entries()) {
          const result = withPluginCache(cache, () =>
            resolvePluginSetupRegistry({ manifestRegistry }),
          );
          expect(result.diagnostics).toEqual([]);
          expect(result.providers).toHaveLength(1);
          const current = result.providers[0]!.provider;
          expect(current.resolveConfigApiKey?.({ provider: record.id, env: {} })).toBe(
            String(index + 1),
          );
          if (index > 0) {
            await retirePluginCache(caches[index - 1]!);
            expect(previous).toBeDefined();
            expect(() => previous!.resolveConfigApiKey?.({ provider: record.id, env: {} })).toThrow(
              /reloaded|disabled|retir/,
            );
            expect(current.resolveConfigApiKey?.({ provider: record.id, env: {} })).toBe(
              String(index + 1),
            );
          }
          previous = current;
        }
        expect(evaluated).toHaveBeenCalledOnce();
      } finally {
        await Promise.all(caches.map((cache) => retirePluginCache(cache)));
        process.off(event, evaluated);
      }
    },
  );
});

describe("installed setup artifacts", () => {
  afterEach(clearPluginMetadataLifecycleCaches);

  it("uses each explicit metadata projection when setup views share a module cache", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const ids = ["snapshot-first", "snapshot-second"];
        const roots = ids.map((id) => {
          const root = state.path(id);
          fs.mkdirSync(root);
          fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({
              name: id,
              version: "1.0.0",
              openclaw: { extensions: ["./runtime.cjs"], setupEntry: "./setup-api.cjs" },
            }),
          );
          fs.writeFileSync(
            path.join(root, "openclaw.plugin.json"),
            JSON.stringify({
              id,
              providers: [id],
              configSchema: { type: "object", properties: {} },
              setup: { requiresRuntime: true, providers: [{ id }] },
            }),
          );
          fs.writeFileSync(
            path.join(root, "runtime.cjs"),
            'throw new Error("Setup inspection must not load the runtime entry");',
          );
          fs.writeFileSync(
            path.join(root, "setup-api.cjs"),
            `module.exports = { register(api) {
              api.registerProvider({ id: ${JSON.stringify(id)}, label: "Snapshot setup", auth: [] });
            } };`,
          );
          return root;
        });
        const config: OpenClawConfig = {
          plugins: { allow: ids, load: { paths: roots }, slots: { memory: "none" } },
        };
        const snapshot = loadPluginMetadataSnapshot({ config, allowCurrent: false });
        const narrowed = projectPluginMetadataSnapshot(snapshot, ["snapshot-first"]);
        const cache = getPluginMetadataSnapshotCache(snapshot);
        try {
          expect(getPluginMetadataSnapshotCache(narrowed)).toBe(cache);
          withPluginMetadataSnapshotScope(
            snapshot,
            () => {
              const read = (metadataSnapshot: typeof snapshot) => {
                const registry = resolvePluginSetupRegistry({ config, metadataSnapshot });
                expect(registry.diagnostics).toEqual([]);
                return registry.providers.map(({ provider }) => provider.id).toSorted();
              };
              expect(read(snapshot)).toEqual(["snapshot-first", "snapshot-second"]);
              expect(read(narrowed)).toEqual(["snapshot-first"]);
              expect(read(snapshot)).toEqual(["snapshot-first", "snapshot-second"]);
            },
            { config },
          );
        } finally {
          await retirePluginCache(cache);
        }
      },
    );
  });

  it.each<{
    artifactDir: string;
    declared: boolean;
    competingDist?: string;
    extension: string;
  }>(
    [
      { artifactDir: ".", declared: true },
      { artifactDir: ".", declared: false },
      { artifactDir: "dist", declared: false },
      { artifactDir: ".", declared: false, competingDist: "setup-api.ts" },
      {
        artifactDir: ".",
        declared: false,
        competingDist: "setup-api.js",
      },
    ].flatMap((entry) =>
      ["cjs", "mjs", "ts"].map((extension) => Object.assign({ extension }, entry)),
    ),
  )(
    "reloads installed $extension $artifactDir setup artifacts (declared: $declared, dist conflict: $competingDist)",
    ({ artifactDir, declared, competingDist, extension }) => {
      const rootDir = temp.make("openclaw-setup-lifecycle-");
      const artifactRoot = path.join(rootDir, artifactDir);
      fs.mkdirSync(artifactRoot, { recursive: true });
      const setupSource = path.join(artifactRoot, `setup-api.${extension}`);
      const dependencyPath = path.join(artifactRoot, "setup-dependency.cjs");
      if (competingDist) {
        fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
        fs.writeFileSync(
          path.join(rootDir, "dist", competingDist),
          'module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "wrong-dist-entry" }); } };\n',
          "utf8",
        );
      }
      const writeSetupArtifact = (version: string) => {
        fs.writeFileSync(dependencyPath, `module.exports = "dependency-${version}";\n`, "utf8");
        fs.writeFileSync(
          setupSource,
          `${extension === "mjs" ? 'import dependency from "./setup-dependency.cjs"; export default' : "module.exports ="}
          { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "entry-${version}:" + ${extension === "mjs" ? "dependency" : 'require("./setup-dependency.cjs")'} }); } };\n`,
          "utf8",
        );
      };
      const manifestRegistry = {
        plugins: [
          {
            id: "setup-lifecycle",
            rootDir,
            source: setupSource,
            ...(declared ? { setupSource } : {}),
            manifestPath: path.join(rootDir, "openclaw.plugin.json"),
            origin: "global",
            channels: [],
            providers: ["setup-lifecycle"],
            cliBackends: [],
            skills: [],
            hooks: [],
            setup: { requiresRuntime: true, providers: [{ id: "setup-lifecycle" }] },
          },
        ],
        diagnostics: [],
      } satisfies PluginManifestRegistry;

      writeSetupArtifact("before");
      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-before:dependency-before",
      );

      writeSetupArtifact("after");
      clearPluginMetadataLifecycleCaches();

      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-after:dependency-after",
      );
    },
  );
});
