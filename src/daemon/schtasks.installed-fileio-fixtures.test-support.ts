import type { InstalledRetirementBaseline } from "./schtasks.installed-retirement-baseline.test-support.js";
import type { InstalledFileIoDescriptor } from "./schtasks.installed-retirement-observation.test-support.js";

export const installedCandidateCheckNames = [
  "candidate migration rehearsal",
  "candidate doctor lint",
  "candidate config validation",
  "candidate plugin resolution",
  "candidate migration continuation",
  "candidate gateway canary",
];

export function createInstalledFileIoDescriptorFixture(
  ownedPrefix: string,
): InstalledFileIoDescriptor {
  const powerShellExe = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  return {
    privateRoot: "C:\\synthetic-private",
    receiptPath: "C:\\synthetic-private\\receipt.json",
    expectedGuid: "00000000-0000-0000-0000-000000000001",
    dllPath: "C:\\synthetic-private\\observer.dll",
    dllSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64),
    schemaSha256: "c".repeat(64),
    helperSha256: "d".repeat(64),
    helperPath: "C:\\synthetic-tools\\OwnedFileTraceOperations.ps1",
    factsPath: "C:\\synthetic-tools\\FileTraceFacts.ps1",
    factsSha256: "e".repeat(64),
    powerShellExe,
    powerShellSha256: "f".repeat(64),
    ownedPrefix,
    runtime: {
      executable: powerShellExe,
      psVersion: "7.6.6",
      edition: "Core",
      clrVersion: "10.0.12",
      is64BitProcess: true,
    },
  };
}

export function createInstalledRetirementBaselineFixture(
  observedAtMs: number,
): InstalledRetirementBaseline {
  return {
    packageRoot: "C:\\synthetic-update\\prefix\\node_modules\\openclaw",
    globalRoot: "C:\\synthetic-update\\prefix\\node_modules",
    namespaceWasEmpty: true,
    backupNamespaceBefore: [],
    observedAtMs,
    expectedAddon: {
      relativePath: "node_modules\\@koromix\\koffi-win32-x64\\win32_x64\\koffi.node",
      canonicalPath:
        "C:\\synthetic-update\\prefix\\node_modules\\openclaw\\node_modules\\@koromix\\koffi-win32-x64\\win32_x64\\koffi.node",
      sha256: "a".repeat(64),
      bytes: 1_044_480,
      fileIdentity: { device: "1", inode: "2" },
    },
  };
}
