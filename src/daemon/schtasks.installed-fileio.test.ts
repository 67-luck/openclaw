import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  cleanupInstalledFileIo,
  prepareInstalledFileIo,
  type InstalledFileIoCommandFact,
} from "./schtasks.installed-fileio.test-support.js";

const managed = vi.hoisted(() => ({ run: vi.fn(), inspect: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: managed.run,
  inspectManagedProcessGroup: managed.inspect,
}));
vi.mock("../infra/windows-install-roots.js", () => ({
  getWindowsPowerShellExePath: () =>
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));
const temporary = useAutoCleanupTempDirTracker(afterEach);
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  managed.run.mockReset();
  managed.inspect.mockReset().mockReturnValue("dead");
});

const runtimeFaults = [
  "runtime-executable",
  "runtime-version",
  "runtime-edition",
  "runtime-clr",
  "runtime-bitness",
] as const;
async function fixture(
  fault?:
    | "persist"
    | "persist-identity"
    | "compile"
    | "schema"
    | "unjoined"
    | (typeof runtimeFaults)[number],
) {
  const rootDir = temporary.make("installed-fileio-");
  const installRoot = path.join(rootDir, "install");
  const ownedPrefix = path.join(installRoot, "node_modules");
  await fs.mkdir(ownedPrefix, { recursive: true });
  const admission: Record<string, unknown> = { role: "selected", rootDir, installRoot };
  // Simulated cleanup uncertainty must retain its own claim, not the test runner's namespace.
  const resourceOwner = createVitestResourceOwner(rootDir);
  const lifetime = createFixtureLifetime(rootDir);
  const commandFacts: InstalledFileIoCommandFact[] = [];
  const phases: string[] = [];
  let persisted = false;
  let identityPersisted = false;
  const privateRoot = path.join(rootDir, ".fileio-private");
  const persistAdmission = vi.fn(async () => {
    expect(admission.fileIo).toMatchObject({
      privateRoot,
      receiptPath: path.join(privateRoot, "trace.json"),
    });
    if (!persisted) {
      await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      if (fault === "persist") {
        throw new Error("synthetic-private-persist-error");
      }
      persisted = true;
    } else {
      const stat = await fs.lstat(privateRoot, { bigint: true });
      expect(admission.fileIo).toMatchObject({
        directoryIdentity: {
          device: stat.dev.toString(),
          inode: stat.ino.toString(),
          birthtimeNs: stat.birthtimeNs.toString(),
        },
      });
      if (fault === "persist-identity") {
        throw new Error("synthetic-private-identity-persist-error");
      }
      identityPersisted = true;
    }
  });
  managed.run.mockImplementation(async (options) => {
    expect(persisted).toBe(true);
    expect(options.bin).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(options.env).toEqual({ SystemRoot: "C:\\Windows", TEMP: rootDir });
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    options.onReady(child);
    child.emit("message", { type: "spawned", pid: 124, job: "fixture" });
    const phase = options.args[options.args.indexOf("-Mode") + 1];
    if (phase === "prepare") {
      expect(identityPersisted).toBe(true);
    }
    const receiptPath = options.args[options.args.indexOf("-ReceiptPath") + 1];
    const guid = options.args[options.args.indexOf("-ExpectedGuid") + 1];
    const name = `OpenClaw-Owned-FileIO-${guid.replaceAll("-", "")}`;
    phases.push(phase);
    if (phase === "prepare") {
      const dll = path.join(privateRoot, "OwnedFileTrace.dll");
      const schema = path.join(privateRoot, "provider-schema.json");
      await fs.writeFile(dll, "synthetic-dll");
      if (fault === "compile") {
        child.stderr.write("synthetic-private-compiler-error");
        throw new Error("synthetic-private-compiler-error");
      }
      if (fault === "unjoined") {
        managed.inspect.mockReturnValue("indeterminate");
        throw Object.assign(new Error("synthetic-private-unjoined-error"), {
          processTreeState: "indeterminate",
        });
      }
      const custody = admission.fileIo as Record<string, unknown>;
      await fs.writeFile(schema, "[]");
      await fs.writeFile(
        receiptPath,
        JSON.stringify({
          contract: "owned-fileio-v1",
          guid,
          name,
          dll,
          raw: path.join(privateRoot, "private-host-events.etl"),
          provider: "edd08927-9cc4-4e65-b970-c2560fb5c289",
          dllSha256: sha256("synthetic-dll"),
          schemaSha256: sha256(fault === "schema" ? "different" : "[]"),
          sourceSha256: custody.sourceSha256,
          helperSha256: custody.helperSha256,
          factsSha256: custody.factsSha256,
          cliSha256: custody.cliSha256,
          runtime: {
            executable:
              fault === "runtime-executable"
                ? "C:\\foreign\\powershell.exe"
                : "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe",
            psVersion: fault === "runtime-version" ? "7.5.2" : "5.1.26100.4652",
            edition: fault === "runtime-edition" ? "Core" : "Desktop",
            clrVersion: fault === "runtime-clr" ? "9.0.0" : "4.0.30319.42000",
            is64BitProcess: fault !== "runtime-bitness",
          },
        }),
      );
      child.stdout.write(
        JSON.stringify({
          phase: "prepared",
          guid,
          name,
          providerEnabled: false,
          rawArtifactUploadAllowed: false,
        }) + "\n",
      );
    } else {
      child.stdout.write(
        JSON.stringify({
          phase: "cleanup",
          guid,
          name,
          cleanupVerified: true,
          traceAbsent: true,
          rawAbsent: true,
        }) + "\n",
      );
    }
    return 0;
  });
  const task = {
    rootDir,
    installRoot,
    env: {
      SystemRoot: "C:\\Windows",
      TEMP: rootDir,
      NODE_OPTIONS: "synthetic-private-node-option",
      PRIVATE_TOKEN: "synthetic-private-token",
    },
  };
  const prepare = () =>
    prepareInstalledFileIo({
      task,
      toolingSha: "a".repeat(40),
      admission,
      persistAdmission,
      lifetime,
      ownedPrefix,
      commandFacts,
    });
  const recover = () =>
    cleanupInstalledFileIo({
      task,
      toolingSha: "a".repeat(40),
      admission,
      lifetime,
      commandFacts,
    });
  return {
    prepare,
    recover,
    lifetime,
    privateRoot,
    phases,
    commandFacts,
    admission,
    resourceOwner,
  };
}

it("admits exact custody before preparation and releases the trace before private files", async () => {
  const f = await fixture();
  const resource = await f.prepare();
  expect(resource.descriptor).toMatchObject({
    privateRoot: f.privateRoot,
    dllSha256: sha256("synthetic-dll"),
    schemaSha256: sha256("[]"),
    runtime: {
      psVersion: "5.1.26100.4652",
      edition: "Desktop",
      clrVersion: "4.0.30319.42000",
      is64BitProcess: true,
    },
  });
  expect(f.commandFacts[0]?.runtime).toEqual(resource.descriptor.runtime);
  await resource.cleanup();
  await f.lifetime.cleanup();
  expect(() => f.resourceOwner.assertReleased()).not.toThrow();
  expect(f.phases).toEqual(["prepare", "cleanup"]);
  expect(
    f.commandFacts.every((fact) => fact.joined && fact.jobObserved && fact.outcome === "verified"),
  ).toBe(true);
  await expect(fs.stat(f.privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(f.commandFacts)).not.toContain("synthetic-private");
});

it.each(["persist", "persist-identity", "compile", "schema"] as const)(
  "rolls back %s failure without releasing unverified custody or private output",
  async (fault) => {
    const f = await fixture(fault);
    await expect(f.prepare()).rejects.toThrow("FileIO preparation or custody validation failed");
    await f.lifetime.cleanup();
    expect(f.phases).toEqual(
      fault === "persist"
        ? []
        : fault === "persist-identity"
          ? ["cleanup"]
          : ["prepare", "cleanup"],
    );
    await expect(fs.stat(f.privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(f.commandFacts)).not.toContain("synthetic-private");
  },
);

it("retains private recovery inputs when compiler descendant settlement is uncertain", async () => {
  const f = await fixture("unjoined");
  await expect(f.prepare()).rejects.toThrow("Fixture acquisition rollback failed");
  await expect(f.lifetime.cleanup()).rejects.toThrow("Fixture cleanup unverified");
  expect(f.phases).toEqual(["prepare"]);
  expect((await fs.stat(f.privateRoot)).isDirectory()).toBe(true);
  expect(f.commandFacts[0]).toMatchObject({ outcome: "failed", joined: false });
  expect(() => f.resourceOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
});

it("rechecks exact native absence when workflow recovery follows completed private cleanup", async () => {
  const f = await fixture();
  const resource = await f.prepare();
  await resource.cleanup();
  await f.recover();
  await f.lifetime.cleanup();
  expect(f.phases).toEqual(["prepare", "cleanup", "cleanup"]);
  await expect(fs.stat(f.privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["privateRoot", "helperSha256", "directoryIdentity"] as const)(
  "refuses changed %s recovery custody before dispatch or deletion",
  async (field) => {
    const f = await fixture();
    const resource = await f.prepare();
    const custody = f.admission.fileIo as Record<string, unknown>;
    const original = custody[field];
    custody[field] =
      field === "privateRoot"
        ? path.dirname(f.privateRoot)
        : field === "directoryIdentity"
          ? undefined
          : "0".repeat(64);
    await expect(f.recover()).rejects.toThrow("FileIO cleanup or custody validation failed");
    expect(f.phases).toEqual(["prepare"]);
    expect((await fs.stat(f.privateRoot)).isDirectory()).toBe(true);
    custody[field] = original;
    await resource.cleanup();
    await expect(f.lifetime.cleanup()).rejects.toThrow("Fixture cleanup unverified");
  },
);

it.each(runtimeFaults)("refuses %s preparation and cleans the admitted trace", async (fault) => {
  const f = await fixture(fault);
  await expect(f.prepare()).rejects.toThrow("FileIO preparation or custody validation failed");
  await f.lifetime.cleanup();
  expect(f.phases).toEqual(["prepare", "cleanup"]);
  expect(f.commandFacts[0]).toMatchObject({ outcome: "failed", joined: true });
  expect(f.commandFacts[0]).not.toHaveProperty("runtime");
  await expect(fs.stat(f.privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["before", "during"] as const)(
  "refuses a private directory replacement %s the cleanup command",
  async (when) => {
    const f = await fixture();
    const resource = await f.prepare();
    const saved = f.privateRoot + ".original";
    const canary = path.join(f.privateRoot, "replacement-canary");
    const replace = async () => {
      await fs.rename(f.privateRoot, saved);
      await fs.mkdir(f.privateRoot);
      await fs.writeFile(canary, "replacement directory must survive");
    };
    if (when === "before") {
      await replace();
    } else {
      const nativeCommand = managed.run.getMockImplementation();
      expect(nativeCommand).toBeDefined();
      managed.run.mockImplementationOnce(async (options) => {
        await replace();
        return nativeCommand!(options);
      });
    }
    let refused = false;
    try {
      const failure = await resource.cleanup().catch((error: unknown) => {
        refused = true;
        return error;
      });
      expect(failure).toBeInstanceOf(Error);
      expect(await fs.readFile(canary, "utf8")).toBe("replacement directory must survive");
      expect(f.phases).toEqual(when === "before" ? ["prepare"] : ["prepare", "cleanup"]);
    } finally {
      // Restore only the known synthetic replacement; recovery still reports the
      // original failed retirement rather than upgrading that cleanup receipt.
      if (
        await fs.stat(f.privateRoot).then(
          () => true,
          () => false,
        )
      ) {
        expect(await fs.readdir(f.privateRoot)).toEqual(["replacement-canary"]);
        await fs.unlink(canary);
        await fs.rmdir(f.privateRoot);
      }
      await fs.rename(saved, f.privateRoot);
      await f.recover();
      if (refused) {
        await expect(f.lifetime.cleanup()).rejects.toThrow("Fixture cleanup unverified");
      } else {
        await f.lifetime.cleanup();
      }
    }
  },
);

it.each([
  [
    "explicit timeout",
    Object.assign(new Error("synthetic-private-timeout"), { code: "ETIMEDOUT" }),
    "ETIMEDOUT",
  ],
  [
    "abort cause",
    new AggregateError(
      [
        new Error("synthetic-private-wrapper", {
          cause: Object.assign(new Error("synthetic-private-abort"), { code: "ABORT_ERR" }),
        }),
      ],
      "synthetic-private-aggregate",
    ),
    "ABORT_ERR",
  ],
  [
    "unknown code",
    Object.assign(new Error("synthetic-private-error"), { code: "synthetic-private-code" }),
    null,
  ],
  ["non-error rejection", "synthetic-private-rejection", null],
] as const)(
  "retains bounded %s facts before sanitized rollback",
  async (_label, failure, expectedCode) => {
    const f = await fixture();
    managed.run.mockImplementationOnce(async (options) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      options.onReady(child);
      child.emit("message", { type: "spawned", pid: 124 });
      const lines =
        JSON.stringify({
          phase: "prepare-stage",
          diagnosticOnly: true,
          stage: "dll-compiled",
          secret: "synthetic-private-stage",
        }) +
        "\n" +
        JSON.stringify({
          phase: "prepare-failure",
          diagnosticOnly: true,
          errorCategory: "win32",
          nativeErrorCode: 5,
          truncated: false,
        }) +
        "\n" +
        JSON.stringify({
          phase: "prepare-stage",
          diagnosticOnly: true,
          stage: "synthetic-private-unknown",
        }) +
        "\n" +
        '{"phase":"prepare-stage"';
      child.stdout.write(lines.slice(0, 19));
      child.stdout.write(lines.slice(19));
      child.stderr.write("synthetic-private-stderr");
      const result = Promise.withResolvers<number>();
      result.reject(failure);
      return result.promise;
    });
    await expect(f.prepare()).rejects.toThrow("FileIO preparation or custody validation failed");
    await f.lifetime.cleanup();
    expect(f.commandFacts[0]).toMatchObject({
      outcome: "failed",
      joined: true,
      jobObserved: true,
      exitCode: null,
      diagnostics: {
        commandStage: "spawned",
        lastPrepareStage: "dll-compiled",
        incompleteOutputLine: true,
        outputTruncated: false,
        nativeFailure: { errorCategory: "win32", nativeErrorCode: 5, truncated: false },
        errorsTruncated: false,
      },
    });
    const diagnostics = f.commandFacts[0]!.diagnostics;
    expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.elapsedMs).toBeLessThan(30_000);
    expect(diagnostics.errors.some((error) => error.code === expectedCode)).toBe(true);
    if (expectedCode === null) {
      expect(diagnostics.errors.every((error) => error.code === null)).toBe(true);
    }
    expect(JSON.stringify(f.commandFacts)).not.toContain("synthetic-private");
    expect(f.phases).toEqual(["cleanup"]);
    await expect(fs.stat(f.privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("caps failure traversal and output without claiming an unseen stage", async () => {
  const f = await fixture();
  const failure = new AggregateError(
    Array.from({ length: 20 }, () => new Error("synthetic-private-member")),
    "synthetic-private-root",
  );
  managed.run.mockImplementationOnce(async (options) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    options.onReady(child);
    child.stdout.write("x".repeat(65_536));
    child.stdout.write(
      '\n{"phase":"prepare-stage","diagnosticOnly":true,"stage":"trace-started"}\n',
    );
    throw failure;
  });
  await expect(f.prepare()).rejects.toThrow("FileIO preparation or custody validation failed");
  await f.lifetime.cleanup();
  expect(f.commandFacts[0]!.diagnostics).toMatchObject({
    commandStage: "on-ready",
    lastPrepareStage: null,
    outputTruncated: true,
    errorsTruncated: true,
  });
  expect(f.commandFacts[0]!.diagnostics.errors).toHaveLength(8);
  expect(JSON.stringify(f.commandFacts)).not.toContain("synthetic-private");
});

it("retains native refusal facts on nonzero exit without inventing a managed error", async () => {
  const f = await fixture();
  managed.run.mockImplementationOnce(async (options) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    options.onReady(child);
    child.emit("message", { type: "spawned", pid: 124 });
    child.stdout.write(
      JSON.stringify({ phase: "prepare-stage", diagnosticOnly: true, stage: "custody-written" }) +
        "\n",
    );
    child.stdout.write(
      JSON.stringify({
        phase: "prepare-failure",
        diagnosticOnly: true,
        errorCategory: "other",
        truncated: false,
      }) + "\n",
    );
    return 2;
  });
  await expect(f.prepare()).rejects.toThrow("FileIO preparation or custody validation failed");
  await f.lifetime.cleanup();
  expect(f.commandFacts[0]).toMatchObject({
    exitCode: 2,
    outcome: "failed",
    joined: true,
    diagnostics: {
      commandStage: "spawned",
      lastPrepareStage: "custody-written",
      errors: [],
      errorsTruncated: false,
      nativeFailure: { errorCategory: "other", truncated: false },
    },
  });
  expect(f.commandFacts[0]!.diagnostics.nativeFailure).not.toHaveProperty("nativeErrorCode");
});
