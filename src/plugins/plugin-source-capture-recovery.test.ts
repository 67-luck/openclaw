import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteLegacyPluginSourceCaptures } from "../commands/doctor-plugin-source-captures.js";
import { cleanupStartupPluginSourceCaptures } from "../commands/startup-plugin-source-captures.js";
import * as census from "../infra/openclaw-process-census.js";
import * as coordinator from "../infra/sqlite-coordinator.js";
import { acquireGatewayMaintenanceCoordinator } from "../infra/state-database-coordinator.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  createPluginNativeCaptureRoot,
  createPluginSourceCaptureRoot,
  retainPluginNativeCapturePath,
  retainPluginSourceCaptureInstance,
  sweepPluginSourceCaptureDirectories,
} from "./plugin-source-capture-directory.js";

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));

const temp = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const hour = 60 * 60 * 1_000;
const locked = Object.assign(new Error("Fixture Windows sharing violation"), { code: "EPERM" });

beforeEach(() => {
  const temporary = temp.make("capture-recovery-temp-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, temporary);
  }
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("recovers a removed captures directory without releasing a live instance", async () => {
  const stateDir = temp.make("capture-recovery-missing-");
  const instance = retainPluginSourceCaptureInstance(stateDir);
  const first = instance.createDirectory();
  const captures = path.dirname(first);
  const root = path.dirname(captures);
  await sweepPluginSourceCaptureDirectories(stateDir);
  fs.rmSync(captures, { recursive: true });
  let worker: ReturnType<typeof createPluginSourceCaptureRoot> | undefined;
  try {
    worker = createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    fs.writeFileSync(path.join(worker.directory, "source.js"), "recovered capture");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(path.join(worker.directory, "source.js"), "utf8")).toBe(
      "recovered capture",
    );
    await worker.release();
    expect(fs.existsSync(root)).toBe(true);
    const next = instance.createDirectory();
    expect(fs.readdirSync(captures)).toEqual([path.basename(next)]);
  } finally {
    await worker?.release();
    await instance.releaseAsync();
  }
  expect(fs.existsSync(root)).toBe(false);
});

it.each(["sync", "async"])(
  "keeps published native bytes across %s disposal and later ordinary sweeps",
  async (mode) => {
    const stateDir = temp.make("native-capture-retention-");
    const committed = createPluginNativeCaptureRoot(stateDir);
    const pending = createPluginNativeCaptureRoot(stateDir);
    const worker = createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    const payload = path.join(committed.directory, "package", "bin", "native");
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.writeFileSync(payload, "retained native bytes");
    fs.writeFileSync(path.join(pending.directory, "native"), "unpublished bytes");
    committed.commit();
    if (mode === "sync") {
      committed.dispose();
      pending.dispose();
    } else {
      await committed.disposeAsync();
      await pending.disposeAsync();
    }
    await worker.release();
    expect(fs.existsSync(pending.directory)).toBe(false);
    expect(fs.existsSync(worker.directory)).toBe(false);
    const instance = path.dirname(path.dirname(committed.directory));
    expect(fs.existsSync(path.join(instance, "owner.sqlite"))).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(payload, "utf8")).toBe("retained native bytes");
    expect(fs.existsSync(path.join(instance, "owner.sqlite"))).toBe(true);
    // A damaged native instance is not tokenless legacy scratch.
    fs.unlinkSync(path.join(instance, "owner.sqlite"));
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(payload, "utf8")).toBe("retained native bytes");
  },
);

it.each(["doctor", "startup"])(
  "%s reclaims only unreferenced native roots while preserving live custody",
  async (mode) => {
    const stateDir = temp.make("native-capture-maintenance-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const note = vi.spyOn(notes, "note").mockImplementation(() => {});
    const warning = vi.spyOn(process, "emitWarning");
    const inspectProcesses = vi.spyOn(census, "inspectOtherOpenClawProcesses");
    const realpath = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (target) =>
      realpath(String(target) === "/tmp" ? tmpdir() : target),
    );
    const runCaptureReport = async () => {
      note.mockClear();
      if (mode === "startup") {
        await cleanupStartupPluginSourceCaptures(env);
      } else {
        await noteLegacyPluginSourceCaptures(env, true);
      }
      return note.mock.calls.map(([message]) => String(message)).join("\n");
    };
    const duringMaintenance = async () => {
      const lease = acquireGatewayMaintenanceCoordinator({
        databasePath: path.join(stateDir, "openclaw.sqlite"),
        runtimeDirectory: path.join(stateDir, "locks"),
      });
      const scope = createOpenClawDatabaseMaintenanceScope(lease.createSchemaFenceDelegate);
      try {
        return await scope.run(runCaptureReport);
      } finally {
        await scope.close();
        lease.release();
      }
    };
    const write = (root: string, filename: string, contents: string) => {
      const file = path.join(root, filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
      return file;
    };
    const referenced = createPluginNativeCaptureRoot(stateDir);
    const captured = write(referenced.directory, "content/bin/native", "published native bytes");
    referenced.commit();
    referenced.dispose();
    const orphan = createPluginNativeCaptureRoot(stateDir);
    write(orphan.directory, "package/bin/native", "superseded native bytes");
    orphan.commit();
    orphan.dispose();
    const warm = createPluginNativeCaptureRoot(stateDir);
    const warmFile = write(warm.directory, "package/bin/native", "warm generation bytes");
    warm.commit();
    warm.dispose();
    const releaseWarm = retainPluginNativeCapturePath(warmFile);
    const live = createPluginNativeCaptureRoot(stateDir);
    const liveFile = write(live.directory, "package/bin/native", "currently in use");
    await writePersistedInstalledPluginIndex(
      {
        version: 1,
        hostContractVersion: "fixture",
        compatRegistryVersion: "fixture",
        migrationVersion: 1,
        policyHash: "fixture",
        generatedAtMs: Date.now(),
        installRecords: {},
        plugins: [
          {
            pluginId: "fixture",
            manifestPath: "/fixture/openclaw.plugin.json",
            manifestHash: "fixture",
            rootDir: "/fixture",
            origin: "global",
            enabled: true,
            startup: { sidecar: false, memory: false, agentHarnesses: [] },
            compat: [],
            sourceAdmissions: {
              fixture: {
                signature: "fixture",
                sourceDigest: "a".repeat(64),
                nativeArtifacts: {
                  "bin/native": {
                    sourceIdentity: "fixture",
                    contentHash: "b".repeat(64),
                    sizeBytes: 22,
                    capturedPath: captured,
                    namespace: referenced.directory,
                    capturedIdentity: "fixture",
                  },
                },
                nativeNamespaces: {
                  [referenced.directory]: {
                    sourceDirectory: "/fixture",
                    capturedRoot: referenced.directory,
                    managed: false,
                    members: {
                      "bin/native": {
                        source: "/fixture/bin/native",
                        sourceIdentity: "fixture",
                        capturedIdentity: "fixture",
                        boundaryChecked: false,
                        contentHash: "b".repeat(64),
                        sizeBytes: 22,
                      },
                    },
                  },
                },
              },
            },
          },
        ],
        diagnostics: [],
      },
      { stateDir },
    );
    if (mode === "doctor") {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
    }
    try {
      inspectProcesses.mockReturnValue({ error: "fixture unreadable host argv" });
      const output = await duringMaintenance();
      if (mode === "doctor") {
        expect(output).toContain("Removed 1 unreferenced native plugin capture root(s).");
      } else {
        expect(warning).not.toHaveBeenCalled();
      }
      expect(inspectProcesses).not.toHaveBeenCalled();
      expect(fs.existsSync(orphan.directory)).toBe(false);
      expect(fs.readFileSync(captured, "utf8")).toBe("published native bytes");
      expect(fs.readFileSync(warmFile, "utf8")).toBe("warm generation bytes");
      expect(fs.readFileSync(liveFile, "utf8")).toBe("currently in use");
      releaseWarm();
      await duringMaintenance();
      expect(fs.existsSync(warm.directory)).toBe(false);
    } finally {
      releaseWarm();
      live.dispose();
    }
  },
);

it.each(["sync", "async"])("preserves custody after partial %s disposal", async (mode) => {
  const stateDir = temp.make("capture-recovery-state-");
  const instance = mode === "sync" ? retainPluginSourceCaptureInstance(stateDir) : undefined;
  const worker =
    mode === "async"
      ? createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-")
      : undefined;
  await sweepPluginSourceCaptureDirectories(stateDir);
  const directory = worker?.directory ?? instance!.createDirectory();
  const root = path.dirname(path.dirname(directory));
  const payload = path.join(directory, "source.js");
  fs.writeFileSync(payload, "export default 1");
  const removeSync = fs.rmSync.bind(fs);
  const remove = fsPromises.rm.bind(fsPromises);
  const interruptRemoval = (target: fs.PathLike) => {
    if (target === root) {
      // Recursive rm can unlink the coordinator before encountering a locked payload.
      removeSync(path.join(root, "owner.sqlite"), { force: true });
      throw locked;
    }
    if (target === directory || target === path.join(root, "captures")) {
      throw locked;
    }
  };
  vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    interruptRemoval(target);
    removeSync(target, options);
  });
  vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    interruptRemoval(target);
    await remove(target, options);
  });
  try {
    if (instance) {
      expect(() => instance.release()).toThrow(locked);
    } else {
      await worker!.release();
    }
    expect(fs.readFileSync(payload, "utf8")).toBe("export default 1");
    const tokenless = fs
      .readdirSync(path.dirname(root))
      .filter((name) => !fs.existsSync(path.join(path.dirname(root), name, "owner.sqlite")));
    expect(tokenless).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    instance?.release();
    await worker?.release();
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * hour);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.existsSync(root)).toBe(false);
});

it.each(["lease", "canonical path", "captures", "first capture"])(
  "leaves no tokenless roots when %s preparation fails",
  async (stage) => {
    const stateDir = temp.make("capture-recovery-allocation-");
    const instance = retainPluginSourceCaptureInstance(stateDir);
    await sweepPluginSourceCaptureDirectories(stateDir);
    const managed = path.join(stateDir, "tmp", "plugin-captures");
    const acquire = coordinator.tryAcquireExclusiveSqliteCoordinator;
    const realpath = fs.realpathSync.bind(fs);
    const mkdir = fs.mkdirSync.bind(fs);
    const mkdtemp = fs.mkdtempSync.bind(fs);
    if (stage === "lease") {
      vi.spyOn(coordinator, "tryAcquireExclusiveSqliteCoordinator").mockImplementation((file) => {
        if (file.startsWith(managed + path.sep)) {
          throw locked;
        }
        return acquire(file);
      });
    } else if (stage === "canonical path") {
      vi.spyOn(fs, "realpathSync").mockImplementation((file, options) => {
        if (String(file).startsWith(managed + path.sep)) {
          throw locked;
        }
        return realpath(file, options);
      });
    } else if (stage === "captures") {
      vi.spyOn(fs, "mkdirSync").mockImplementation((file, options) => {
        if (
          String(file).startsWith(managed + path.sep) &&
          path.basename(String(file)) === "captures"
        ) {
          throw locked;
        }
        return mkdir(file, options);
      });
    } else {
      vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix, options) => {
        if (prefix.startsWith(managed + path.sep)) {
          throw locked;
        }
        return mkdtemp(prefix, options);
      });
    }
    try {
      const directory = instance.createDirectory();
      fs.writeFileSync(path.join(directory, "source.js"), "captured after fallback");
      expect(fs.readdirSync(managed)).toEqual([]);
      expect(fs.existsSync(path.join(path.dirname(path.dirname(directory)), "owner.sqlite"))).toBe(
        true,
      );
    } finally {
      vi.restoreAllMocks();
      await instance.releaseAsync();
    }
    expect(
      fs.readdirSync(tmpdir()).filter((name) => name.startsWith("openclaw-plugin-captures-")),
    ).toEqual([]);
  },
);

it.each([
  {
    name: "host visibility is unavailable",
    result: { error: "Host process visibility cannot be established from this container." },
  },
  {
    name: "process ancestry is incomplete",
    result: { error: "OpenClaw process ancestry is incomplete." },
  },
  { name: "another producer is present", result: { pids: [12345] } },
])("preserves aged legacy roots when $name", async ({ result }) => {
  const stateDir = temp.make("capture-recovery-census-");
  const roots = [
    path.join(stateDir, "tmp", "openclaw-model-catalog-retained"),
    path.join(tmpdir(), "openclaw-plugin-build-retained"),
  ];
  const capturedRoots = roots.map((directory) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "source.js"), "producer still needs this path");
    const { dev, ino } = fs.lstatSync(directory, { bigint: true });
    return { directory, identity: { dev, ino } };
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * hour);
  const inspect = vi.spyOn(census, "inspectOtherOpenClawProcesses").mockReturnValue(result);
  // These spies retain real filesystem behavior: a successful rename is not custody proof.
  const rename = vi.spyOn(fsPromises, "rename");
  const remove = vi.spyOn(fsPromises, "rm");

  await sweepPluginSourceCaptureDirectories(stateDir);

  expect(inspect).toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  for (const { directory, identity } of capturedRoots) {
    expect(fs.lstatSync(directory, { bigint: true })).toMatchObject(identity);
    expect(fs.readFileSync(path.join(directory, "source.js"), "utf8")).toBe(
      "producer still needs this path",
    );
  }
});

it("reclaims aged tokenless roots after a complete empty census and retries locked roots", async () => {
  const stateDir = temp.make("capture-recovery-legacy-");
  const stateTemp = path.join(stateDir, "tmp");
  fs.mkdirSync(stateTemp);
  vi.spyOn(census, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
  const create = (parent: string, name: string) => {
    const directory = path.join(parent, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "source.js"), Buffer.alloc(1024));
    return directory;
  };
  const old = Array.from({ length: 87 }, (_, index) =>
    create(tmpdir(), `openclaw-plugin-build-${index}`),
  );
  const catalog = create(stateTemp, "openclaw-model-catalog-old");
  const busy = create(tmpdir(), "openclaw-plugin-build-locked");
  const tokened = create(tmpdir(), "openclaw-plugin-build-owned");
  fs.writeFileSync(path.join(tokened, "owner.sqlite"), "");
  const unrelated = create(tmpdir(), "unrelated");
  const link = path.join(tmpdir(), "openclaw-plugin-build-link");
  fs.symlinkSync(unrelated, link, "junction");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * hour);
  const fresh = create(tmpdir(), "openclaw-plugin-build-fresh");
  // Filesystem timestamps use the real clock even when Date is faked.
  fs.utimesSync(fresh, new Date(), new Date());
  const rename = fsPromises.rename.bind(fsPromises);
  const probe = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    if (from === busy) {
      throw locked;
    }
    await rename(from, to);
  });
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(old.filter((directory) => fs.existsSync(directory))).toHaveLength(0);
  expect(fs.existsSync(catalog)).toBe(false);
  for (const kept of [fresh, busy, tokened, unrelated, link]) {
    expect(fs.existsSync(kept)).toBe(true);
  }
  // Renaming alone must not count as reclaiming the payload.
  expect(fs.readdirSync(stateTemp)).toEqual([]);
  const retainedNames = () =>
    fs
      .readdirSync(tmpdir())
      .filter((name) => name.startsWith("openclaw-"))
      .toSorted();
  expect(retainedNames()).toEqual(
    [fresh, busy, tokened, link].map((file) => path.basename(file)).toSorted(),
  );
  probe.mockRestore();
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.existsSync(busy)).toBe(false);
  expect(retainedNames()).toEqual(
    [fresh, tokened, link].map((file) => path.basename(file)).toSorted(),
  );
});

it("retries partial tokenless removal without exhausting directory name limits", async () => {
  const stateDir = temp.make("capture-recovery-retry-");
  const managed = path.join(stateDir, "tmp", "plugin-captures");
  const directory = path.join(managed, "interrupted-instance");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "source.js"), "retained payload");
  vi.useFakeTimers({ toFake: ["Date"] });
  const fault = vi.spyOn(fsPromises, "rm").mockRejectedValue(locked);
  for (let cycle = 0; cycle < 8; cycle++) {
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCaptureDirectories(stateDir);
  }
  fault.mockRestore();
  vi.setSystemTime(Date.now() + 2 * hour);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.readdirSync(managed)).toEqual([]);
});
