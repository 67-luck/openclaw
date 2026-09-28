import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
} from "../../scripts/lib/managed-child-process.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import type { InstalledFileIoDescriptor } from "./schtasks.installed-retirement-observation.test-support.js";

const sourceRoot = fileURLToPath(new URL("../../scripts/qa/windows-fileio/", import.meta.url));
const sourceSha256 = "8fc1495a0d7a828cdd611d376aebc4590747d1d855ed7e48d69d765eca3fe45d";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const runtimeSchema = z.object({
  executable: z.string().min(1).max(8192),
  psVersion: z
    .string()
    .max(64)
    .regex(/^5\.1\.\d+(?:\.\d+)?$/u),
  edition: z.literal("Desktop"),
  clrVersion: z
    .string()
    .max(64)
    .regex(/^4\.\d+(?:\.\d+){1,2}$/u),
  is64BitProcess: z.literal(true),
});
const receiptSchema = z.object({
  contract: z.literal("owned-fileio-v1"),
  guid: z.string().uuid(),
  name: z.string(),
  raw: z.string(),
  dll: z.string(),
  provider: z.literal("edd08927-9cc4-4e65-b970-c2560fb5c289"),
  dllSha256: sha256,
  sourceSha256: sha256,
  schemaSha256: sha256,
  helperSha256: sha256,
  factsSha256: sha256,
  cliSha256: sha256,
  runtime: runtimeSchema,
});

export type InstalledFileIoCommandFact = {
  phase: "prepare" | "cleanup";
  outcome: "failed" | "verified";
  joined: boolean;
  jobObserved: boolean;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  runtime?: z.infer<typeof runtimeSchema>;
};

async function hashRegularFile(file: string, maximumBytes = 2_097_152) {
  const before = await fs.lstat(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink());
  assert.ok(before.size > 0n && before.size <= BigInt(maximumBytes));
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file, { bigint: true });
  assert.equal(before.dev, after.dev);
  assert.equal(before.ino, after.ino);
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeNs, after.mtimeNs);
  assert.equal(BigInt(bytes.length), before.size);
  return createHash("sha256").update(bytes).digest("hex");
}

type FileIoTask = { rootDir: string; installRoot: string; env: NodeJS.ProcessEnv };
const directoryIdentitySchema = z.object({
  device: z.string().regex(/^\d{1,32}$/u),
  inode: z.string().regex(/^\d{1,32}$/u),
  birthtimeNs: z.string().regex(/^\d{1,32}$/u),
});
const custodySchema = z.object({
  contract: z.literal("installed-fileio-custody-v1"),
  toolingSha: z.string().regex(/^[a-f0-9]{40}$/u),
  privateRoot: z.string(),
  receiptPath: z.string(),
  expectedGuid: z.string().uuid(),
  name: z.string(),
  sourcePath: z.string(),
  sourceSha256: z.literal(sourceSha256),
  cliPath: z.string(),
  cliSha256: sha256,
  helperPath: z.string(),
  helperSha256: sha256,
  factsPath: z.string(),
  factsSha256: sha256,
  powerShellExe: z.string(),
  ownedPrefix: z.string(),
  directoryIdentity: directoryIdentitySchema.optional(),
});
type FileIoCustody = z.infer<typeof custodySchema>;

async function readPrivateDirectoryIdentity(privateRoot: string) {
  let stat;
  try {
    assert.equal(
      path.toNamespacedPath(await fs.realpath(privateRoot)).toLowerCase(),
      path.toNamespacedPath(path.resolve(privateRoot)).toLowerCase(),
    );
    stat = await fs.lstat(privateRoot, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.ino > 0n);
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

function readCustody(admission: Record<string, unknown>, task: FileIoTask, toolingSha: string) {
  assert.equal(admission.role, "selected");
  assert.equal(admission.rootDir, task.rootDir);
  assert.equal(admission.installRoot, task.installRoot);
  const custody = custodySchema.parse(admission.fileIo);
  assert.equal(custody.toolingSha, toolingSha);
  assert.equal(custody.privateRoot, path.join(task.rootDir, ".fileio-private"));
  assert.equal(custody.receiptPath, path.join(custody.privateRoot, "trace.json"));
  assert.equal(custody.name, `OpenClaw-Owned-FileIO-${custody.expectedGuid.replaceAll("-", "")}`);
  assert.equal(custody.sourcePath, path.join(sourceRoot, "OwnedFileTrace.cs"));
  assert.equal(custody.cliPath, path.join(sourceRoot, "Invoke-OwnedFileTrace.ps1"));
  assert.equal(custody.helperPath, path.join(sourceRoot, "OwnedFileTraceOperations.ps1"));
  assert.equal(custody.factsPath, path.join(sourceRoot, "FileTraceFacts.ps1"));
  assert.equal(custody.powerShellExe, getWindowsPowerShellExePath());
  assert.equal(
    path.toNamespacedPath(custody.ownedPrefix).toLowerCase(),
    path.toNamespacedPath(path.join(task.installRoot, "node_modules")).toLowerCase(),
  );
  return custody;
}

async function verifySources(custody: FileIoCustody) {
  for (const [file, expected] of [
    [custody.sourcePath, custody.sourceSha256],
    [custody.cliPath, custody.cliSha256],
    [custody.helperPath, custody.helperSha256],
    [custody.factsPath, custody.factsSha256],
  ] as const) {
    assert.equal(await hashRegularFile(file), expected, "FileIO source binding changed");
  }
  const directoryIdentity = await readPrivateDirectoryIdentity(custody.privateRoot);
  if (directoryIdentity) {
    assert.deepEqual(directoryIdentity, custody.directoryIdentity);
  }
  return directoryIdentity;
}

function fileIoCommand(
  custody: FileIoCustody,
  task: FileIoTask,
  commandFacts: InstalledFileIoCommandFact[],
  signal?: AbortSignal,
) {
  const { expectedGuid, name, cliPath, receiptPath, powerShellExe } = custody;
  const env = Object.fromEntries(
    Object.entries(task.env).filter(([key]) =>
      [
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMDATA",
        "NUMBER_OF_PROCESSORS",
      ].includes(key.toUpperCase()),
    ),
  );
  return async (phase: "prepare" | "cleanup") => {
    const directoryIdentity = await verifySources(custody);
    const fact: InstalledFileIoCommandFact = {
      phase,
      outcome: "failed",
      joined: false,
      jobObserved: false,
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    commandFacts.push(fact);
    let child: ChildProcess | undefined;
    let output = "";
    let failure: unknown;
    try {
      fact.exitCode = await runManagedCommand({
        bin: powerShellExe,
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          cliPath,
          "-Mode",
          phase,
          "-ReceiptPath",
          receiptPath,
          "-ExpectedGuid",
          expectedGuid,
        ],
        cwd: task.rootDir,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 30_000,
        signal: phase === "prepare" ? signal : undefined,
        onReady(launched) {
          child = launched;
          launched.on("message", (message: unknown) => {
            const control = z
              .object({ type: z.literal("spawned"), pid: z.number().int().positive() })
              .safeParse(message);
            if (control.success) {
              fact.jobObserved = true;
            }
          });
          launched.stdout?.on("data", (chunk: Buffer) => {
            fact.stdoutBytes += chunk.length;
            if (fact.stdoutBytes <= 65_536) {
              output += chunk.toString("utf8");
            }
          });
          launched.stderr?.on("data", (chunk: Buffer) => {
            fact.stderrBytes += chunk.length;
          });
        },
      });
    } catch (error) {
      failure = error;
    }
    fact.joined =
      (!child || inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) === "dead") &&
      !hasUnjoinedWork(failure);
    if (!fact.joined) {
      throw Object.assign(new Error("FileIO command join unverified"), {
        processTreeState: "indeterminate",
      });
    }
    assert.ok(!failure && fact.exitCode === 0 && fact.jobObserved, "FileIO managed command failed");
    assert.ok(
      fact.stdoutBytes <= 65_536 && fact.stderrBytes === 0,
      "FileIO output contract failed",
    );
    const lines = output.trim().split(/\r?\n/u);
    const result = z
      .object({
        phase: z.literal(phase === "prepare" ? "prepared" : "cleanup"),
        guid: z.literal(expectedGuid),
        name: z.literal(name),
        ...(phase === "prepare"
          ? { providerEnabled: z.literal(false), rawArtifactUploadAllowed: z.literal(false) }
          : {
              cleanupVerified: z.literal(true),
              traceAbsent: z.literal(true),
              rawAbsent: z.literal(true),
            }),
      })
      .parse(JSON.parse(lines.at(-1) ?? ""));
    fact.outcome = "verified";
    return { result, directoryIdentity };
  };
}

export async function cleanupInstalledFileIo(params: {
  task: FileIoTask;
  toolingSha: string;
  admission: Record<string, unknown>;
  lifetime: ReturnType<typeof createFixtureLifetime>;
  commandFacts?: InstalledFileIoCommandFact[];
}) {
  const commandFacts = params.commandFacts ?? [];
  return params.lifetime.verifyCleanup(async () => {
    const firstCommand = commandFacts.length;
    try {
      const custody = readCustody(params.admission, params.task, params.toolingSha);
      const command = fileIoCommand(custody, params.task, commandFacts);
      const cleaned = await command("cleanup");
      assert.deepEqual(
        await readPrivateDirectoryIdentity(custody.privateRoot),
        cleaned.directoryIdentity,
        "FileIO private directory changed during native cleanup",
      );
      if (cleaned.directoryIdentity) {
        await fs.rm(custody.privateRoot, { recursive: true });
      }
    } catch (error) {
      const fact = commandFacts.at(-1);
      if (commandFacts.length > firstCommand && fact?.phase === "cleanup") {
        fact.outcome = "failed";
      }
      throw Object.assign(
        new Error("FileIO cleanup or custody validation failed"),
        hasUnjoinedWork(error) ? { processTreeState: "indeterminate" } : {},
      );
    }
  });
}

export async function prepareInstalledFileIo(params: {
  task: FileIoTask;
  toolingSha: string;
  admission: Record<string, unknown>;
  persistAdmission: () => Promise<void>;
  lifetime: ReturnType<typeof createFixtureLifetime>;
  ownedPrefix: string;
  signal?: AbortSignal;
  commandFacts?: InstalledFileIoCommandFact[];
}) {
  const commandFacts = params.commandFacts ?? [];
  return params.lifetime.acquire(async (rejectAfterCleanup) => {
    let allocated = false;
    let commandsJoined = true;
    const privateRoot = path.join(params.task.rootDir, ".fileio-private");
    const receiptPath = path.join(privateRoot, "trace.json");
    const expectedGuid = randomUUID();
    const name = `OpenClaw-Owned-FileIO-${expectedGuid.replaceAll("-", "")}`;
    const cliPath = path.join(sourceRoot, "Invoke-OwnedFileTrace.ps1");
    const helperPath = path.join(sourceRoot, "OwnedFileTraceOperations.ps1");
    const factsPath = path.join(sourceRoot, "FileTraceFacts.ps1");
    const sourcePath = path.join(sourceRoot, "OwnedFileTrace.cs");
    const powerShellExe = getWindowsPowerShellExePath();
    const cleanup = async () => {
      if (!allocated) {
        return;
      }
      if (!commandsJoined) {
        throw Object.assign(new Error("FileIO cleanup refused while owned work is unjoined"), {
          processTreeState: "indeterminate",
        });
      }
      await cleanupInstalledFileIo({ ...params, commandFacts });
      allocated = false;
    };
    try {
      assert.match(params.toolingSha, /^[a-f0-9]{40}$/u);
      assert.equal(params.admission.role, "selected");
      assert.equal(params.admission.rootDir, params.task.rootDir);
      assert.equal(params.admission.installRoot, params.task.installRoot);
      assert.equal(params.admission.fileIo, undefined, "FileIO custody already admitted");
      assert.equal(
        path.toNamespacedPath(await fs.realpath(params.task.rootDir)).toLowerCase(),
        path.toNamespacedPath(path.resolve(params.task.rootDir)).toLowerCase(),
      );
      assert.equal(
        await fs.realpath(params.ownedPrefix),
        await fs.realpath(path.join(params.task.installRoot, "node_modules")),
      );
      assert.equal(await hashRegularFile(sourcePath), sourceSha256);
      const cliSha256 = await hashRegularFile(cliPath);
      const helperSha256 = await hashRegularFile(helperPath);
      const factsSha256 = await hashRegularFile(factsPath);
      params.admission.fileIo = {
        contract: "installed-fileio-custody-v1",
        toolingSha: params.toolingSha,
        privateRoot,
        receiptPath,
        expectedGuid,
        name,
        sourcePath,
        sourceSha256,
        cliPath,
        cliSha256,
        helperPath,
        helperSha256,
        factsPath,
        factsSha256,
        powerShellExe,
        ownedPrefix: params.ownedPrefix,
      };
      // Publish exact recovery authority before any compiler, trace, or private allocation.
      await params.persistAdmission();
      await fs.mkdir(privateRoot);
      allocated = true;
      const custody = readCustody(params.admission, params.task, params.toolingSha);
      custody.directoryIdentity = await readPrivateDirectoryIdentity(privateRoot);
      assert.ok(custody.directoryIdentity);
      params.admission.fileIo = custody;
      // Bind the exclusive allocation before compiler or trace effects can begin.
      await params.persistAdmission();
      const command = fileIoCommand(custody, params.task, commandFacts, params.signal);
      try {
        await command("prepare");
      } finally {
        commandsJoined = commandFacts.every((fact) => fact.joined);
      }
      await verifySources(custody);
      await hashRegularFile(receiptPath, 16_384);
      const receipt = receiptSchema.parse(JSON.parse(await fs.readFile(receiptPath, "utf8")));
      assert.equal(receipt.guid, expectedGuid);
      assert.equal(receipt.name, name);
      assert.equal(receipt.raw, path.join(privateRoot, "private-host-events.etl"));
      assert.equal(receipt.dll, path.join(privateRoot, "OwnedFileTrace.dll"));
      assert.equal(receipt.sourceSha256, sourceSha256);
      assert.equal(receipt.helperSha256, helperSha256);
      assert.equal(receipt.factsSha256, factsSha256);
      assert.equal(receipt.cliSha256, cliSha256);
      assert.equal(receipt.runtime.executable.toLowerCase(), powerShellExe.toLowerCase());
      assert.equal(await hashRegularFile(receipt.dll), receipt.dllSha256);
      assert.equal(
        await hashRegularFile(path.join(privateRoot, "provider-schema.json")),
        receipt.schemaSha256,
      );
      const preparation = commandFacts.at(-1);
      assert.equal(preparation?.phase, "prepare");
      assert.ok(preparation);
      preparation.runtime = receipt.runtime;
      const descriptor: InstalledFileIoDescriptor = {
        privateRoot,
        receiptPath,
        expectedGuid,
        dllPath: receipt.dll,
        dllSha256: receipt.dllSha256,
        sourceSha256,
        schemaSha256: receipt.schemaSha256,
        helperPath,
        helperSha256,
        factsPath,
        factsSha256,
        powerShellExe,
        ownedPrefix: params.ownedPrefix,
        runtime: receipt.runtime,
      };
      return { descriptor, cleanup, commandFacts };
    } catch (error) {
      const fact = commandFacts.at(-1);
      if (fact?.phase === "prepare") {
        fact.outcome = "failed";
      }
      const safeFailure = Object.assign(
        new Error("FileIO preparation or custody validation failed"),
        hasUnjoinedWork(error) ? { processTreeState: "indeterminate" } : {},
      );
      return rejectAfterCleanup(safeFailure, cleanup);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const lifetime = createFixtureLifetime();
  const commandFacts: InstalledFileIoCommandFact[] = [];
  let verified = false;
  try {
    const [mode, admissionPath, rootDir, installRoot, toolingSha] = process.argv.slice(2);
    assert.equal(process.platform, "win32");
    assert.equal(mode, "cleanup");
    assert.equal(process.argv.length, 7);
    assert.ok(admissionPath && rootDir && installRoot && toolingSha);
    // The workflow first validates its complete finite task authority set, then
    // supplies independently derived roots; the adapter owns nested trace custody.
    const admissions = z
      .array(z.record(z.string(), z.unknown()))
      .parse(JSON.parse(await fs.readFile(admissionPath, "utf8")));
    const selected = admissions.filter(
      (record) => record.role === "selected" && record.fileIo !== undefined,
    );
    assert.equal(selected.length, 1);
    await cleanupInstalledFileIo({
      task: { rootDir, installRoot, env: process.env },
      toolingSha,
      admission: selected[0]!,
      lifetime,
      commandFacts,
    });
    await lifetime.cleanup();
    verified = true;
  } catch {
    try {
      await lifetime.cleanup();
    } catch {
      /* Retain failed custody for runner teardown. */
    }
  }
  process.stdout.write(
    JSON.stringify({ phase: "cleanup", cleanupVerified: verified, commandFacts }) + "\n",
  );
  process.exitCode = verified ? 0 : 1;
}
