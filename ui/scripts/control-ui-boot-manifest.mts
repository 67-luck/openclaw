#!/usr/bin/env -S node --import tsx
// Regenerates ui/config/control-ui-boot-modules.json: the measured module set
// shared shell and route-specific boot flows load lazily, plus evaluated dynamic
// entry points. Membership is authenticated foreground boot, before browser idle:
// hold idle callbacks and message-subscription admission while eager shell/profile
// work completes, then capture through the chat.startup send with its reply held.
// The default /chat landing also admits its initial roster before selection;
// explicit deep links retain foreground priority. /new ends at authenticated
// composer + roster readiness. The shared capture helper also owns the drift
// guard's ordering. No wall-clock settle window or previous boot grouping feeds
// membership; deferred idle chrome and post-transcript work stay outside it.
// Keep main's route reachability filter: fetched co-located modules belong only
// to routes that reach them through entry modules or evaluated dynamic imports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import {
  controlUiBootManifestKey,
  createControlUiCodeSplitting,
} from "../config/control-ui-chunking.ts";
import {
  bootDynamicImportMarkPrefix,
  captureControlUiBoot,
} from "../src/test-helpers/control-ui-boot-capture.ts";
import {
  startBuiltControlUiE2eServer,
  resolvePlaywrightChromiumExecutablePath,
} from "../src/test-helpers/control-ui-e2e.ts";
import controlUiViteConfig from "../vite.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, "ui", "config", "control-ui-boot-modules.json");

function readDistBuildId(distDir: string): string {
  const swSource = fs.readFileSync(path.join(distDir, "sw.js"), "utf8");
  const buildId = /EMBEDDED_CACHE_VERSION = "([^"]+)"/.exec(swSource)?.[1];
  if (!buildId) {
    throw new Error("Control UI boot manifest cannot read the dist build id from sw.js");
  }
  return buildId;
}

async function collectBootChunkPaths(
  baseUrl: string,
  distDir: string,
  route: "new" | "chat",
): Promise<{ chunks: Set<string>; entries: Set<string> }> {
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  try {
    const page = await browser.newPage();
    const chunkPaths = new Set<string>();
    const entries = new Set<string>();
    if (route === "chat") {
      // Both default-chat selection and a cold session deep link are shipped entry points.
      // Their independent bootstrap work can run before the selected transcript request.
      for (const mainSession of [false, true]) {
        const capturePage = mainSession ? await browser.newPage() : page;
        const capture = await captureControlUiBoot(capturePage, baseUrl, {
          serverBuildId: readDistBuildId(distDir),
          mainSession,
        });
        const login = [...capture.beforeStartup].filter((chunk) =>
          /\/login-(?:gate|runtime)-/.test(chunk),
        );
        console.log(
          `control-ui-boot-manifest: chat (${mainSession ? "main" : "deep link"}): ${capture.beforeStartup.size} before chat.startup; ${capture.afterStartup.size} later; login chunks excluded: ${login.length}`,
        );
        for (const chunk of capture.beforeStartup) {
          // Login loading has its own owner; an authenticated capture reports it,
          // but must never turn that regression into a chat preload requirement.
          if (!login.includes(chunk)) {
            chunkPaths.add(chunk);
          }
        }
        for (const entry of capture.entriesBeforeStartup) {
          if (entry !== "ui/src/components/login-gate.ts") {
            entries.add(entry);
          }
        }
        await capturePage.close();
      }
      return { chunks: chunkPaths, entries };
    }
    const capture = await captureControlUiBoot(page, baseUrl, {
      serverBuildId: readDistBuildId(distDir),
      route: "new",
    });
    for (const chunk of capture.beforeStartup) {
      chunkPaths.add(chunk);
    }
    for (const entry of capture.entriesBeforeStartup) {
      entries.add(entry);
    }
    return { chunks: chunkPaths, entries };
  } finally {
    await browser.close();
  }
}

function manifestKeysForChunks(chunkPaths: Iterable<string>, distDir: string): string[] {
  const keys = new Set<string>();
  for (const chunkPath of chunkPaths) {
    const mapPath = path.join(distDir, `${chunkPath}.map`);
    if (!fs.existsSync(mapPath)) {
      // Facade chunks for dynamic entries can omit maps; their modules are
      // covered by the chunks that carry the actual code.
      continue;
    }
    const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { sources?: string[] };
    for (const source of map.sources ?? []) {
      keys.add(controlUiBootManifestKey(path.resolve(path.join(distDir, "assets"), source)));
    }
  }
  return [...keys].toSorted();
}

type BootCaptureGraph = {
  entryModules: string[];
  imports: Map<string, readonly string[]>;
};

function routeModuleKeys(graph: BootCaptureGraph, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    pending.push(...(graph.imports.get(id) ?? []));
  }
  return new Set([...seen].map(controlUiBootManifestKey));
}

function partitionBootKeys(routes: Record<"new" | "chat", Set<string>>) {
  const shared = new Set([...routes.new].filter((key) => routes.chat.has(key)));
  const sorted = (keys: Iterable<string>) =>
    [...keys].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    shared: sorted(shared),
    new: sorted([...routes.new].filter((key) => !shared.has(key))),
    chat: sorted([...routes.chat].filter((key) => !shared.has(key))),
  };
}

async function main(): Promise<void> {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-boot-"));
  try {
    const config = controlUiViteConfig({ outDir: distDir });
    const graph: BootCaptureGraph = { entryModules: [], imports: new Map() };
    await build({
      ...config,
      configFile: false,
      root: path.join(repoRoot, "ui"),
      plugins: [
        config.plugins,
        {
          name: "control-ui-measure-boot-dependencies",
          outputOptions(options) {
            // Old JavaScript and CSS boot groups would keep stale modules in fetched chunks,
            // feeding them back into every regenerated manifest.
            return {
              ...options,
              codeSplitting: createControlUiCodeSplitting({ includeBootGroups: false }),
            };
          },
          generateBundle(_options, bundle) {
            for (const id of this.getModuleIds()) {
              graph.imports.set(id, this.getModuleInfo(id)?.importedIds ?? []);
            }
            for (const chunk of Object.values(bundle)) {
              if (chunk.type === "chunk" && chunk.isEntry && chunk.facadeModuleId) {
                graph.entryModules.push(chunk.facadeModuleId);
              }
            }
          },
          enforce: "post",
          async transform(code, id) {
            if (!/\bimport\s*\(/.test(code)) {
              return;
            }
            const imports: Array<{ start: number; end: number; source: string }> = [];
            const visit = (node: unknown): void => {
              if (!node || typeof node !== "object") {
                return;
              }
              if (
                "type" in node &&
                node.type === "ImportExpression" &&
                "start" in node &&
                typeof node.start === "number" &&
                "end" in node &&
                typeof node.end === "number" &&
                "source" in node &&
                node.source &&
                typeof node.source === "object" &&
                "value" in node.source &&
                typeof node.source.value === "string"
              ) {
                imports.push({ start: node.start, end: node.end, source: node.source.value });
              }
              for (const child of Object.values(node)) {
                if (Array.isArray(child)) {
                  child.forEach(visit);
                } else {
                  visit(child);
                }
              }
            };
            visit(this.parse(code));
            // Measure evaluated import expressions, including targets Rolldown
            // merges into chunks without a dynamic-entry facade. Chunk membership
            // alone would also preload unused lazy entry points.
            let measured = code;
            for (const entry of imports.toSorted((a, b) => b.start - a.start)) {
              const target = await this.resolve(entry.source, id);
              if (!target || target.external) {
                continue;
              }
              const mark = JSON.stringify(
                bootDynamicImportMarkPrefix + controlUiBootManifestKey(target.id),
              );
              measured = `${measured.slice(0, entry.start)}(performance.mark(${mark}), ${measured.slice(entry.start, entry.end)})${measured.slice(entry.end)}`;
            }
            return imports.length ? { code: measured, map: null } : undefined;
          },
        },
      ],
    });
    const server = await startBuiltControlUiE2eServer(distDir);
    try {
      const routes = { new: new Set<string>(), chat: new Set<string>() };
      const routeEntries = { new: new Set<string>(), chat: new Set<string>() };
      for (const route of ["new", "chat"] as const) {
        const { chunks, entries } = await collectBootChunkPaths(server.baseUrl, distDir, route);
        routeEntries[route] = entries;
        const requestedEntries = [...graph.imports.keys()].filter((id) =>
          entries.has(controlUiBootManifestKey(id)),
        );
        const needed = routeModuleKeys(graph, [...graph.entryModules, ...requestedEntries]);
        const fetched = manifestKeysForChunks(chunks, distDir);
        routes[route] = new Set(fetched.filter((key) => needed.has(key)));
        if (routes[route].size < 100) {
          throw new Error(
            `Boot capture looks truncated: ${route} recorded only ${routes[route].size} modules`,
          );
        }
        console.log(
          `control-ui-boot-manifest: ${route}: ${chunks.size} chunks, ${routes[route].size} of ${fetched.length} fetched modules reachable, ${routeEntries[route].size} dynamic entries`,
        );
      }
      const modules = partitionBootKeys(routes);
      const manifest = {
        ...modules,
        entries: partitionBootKeys(routeEntries),
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
      console.log(
        `control-ui-boot-manifest: ${Object.entries(modules)
          .map(([name, keys]) => `${name}: ${keys.length}`)
          .join(", ")} -> ${path.relative(repoRoot, manifestPath)}`,
      );
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  console.error("[control-ui-boot-manifest] FAILED (exit 1)");
  process.exit(1);
});
