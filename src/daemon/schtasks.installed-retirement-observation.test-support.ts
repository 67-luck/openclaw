import path from "node:path";
import { z } from "zod";
import { parseCmdScriptCommandLine } from "./cmd-argv.js";

export type InstalledUpdateRetirementBinding = Readonly<{
  launcherPid: number;
  commandPid: number;
  commandStartedAtMs: number;
  commandSpawnedAtMs: number;
  entry: string;
  profile: string;
  expectedNodeExe: string;
  /** Immutable run() arguments, beginning with entry and excluding the Node executable. */
  expectedArgv: readonly string[];
  runId: string;
  runCreatedAtMs: number;
  globalRoot: string;
  namespaceWasEmpty?: boolean;
  expectedAddon?: Readonly<{
    canonicalPath: string;
    relativePath: string;
    sha256: string;
    bytes: number;
  }>;
  pinnedProcess?: Readonly<{ pid: number; startTicks: string }>;
}>;

const limitation =
  "Diagnostic correlation only, never retirement authority. Loader paths may predate a rename; file hashes do not identify the mapped file object or a pending removal call.";

const nativeCandidateSchema = z.object({
  pid: z.number().int().positive(),
  parentPid: z.number().int().nonnegative(),
  createdAt: z.string().max(64),
  commandLine: z.string(),
  startTicks: z
    .string()
    .regex(/^\d{1,20}$/u)
    .optional(),
  afterStartTicks: z
    .string()
    .regex(/^\d{1,20}$/u)
    .optional(),
  hasExited: z.boolean().optional(),
  nodeReportedPath: z.string().max(8192).optional(),
  moduleReportedPaths: z.array(z.string().max(8192)).max(4),
  modulesComplete: z.boolean(),
  backupsComplete: z.boolean(),
  backups: z
    .array(
      z.object({
        root: z.string().max(8192),
        kind: z.enum(["pid-name-correlation", "shim-namespace"]),
        createdAtMs: z.number().optional(),
        complete: z.boolean(),
        unavailable: z.array(z.string().max(160)).max(16),
        leaves: z
          .array(
            z.object({
              relativePath: z.string().max(8192),
              bytes: z.number().int().nonnegative().optional(),
              sha256: z
                .string()
                .regex(/^[a-f0-9]{64}$/u)
                .optional(),
              unavailable: z.string().max(160).optional(),
            }),
          )
          .max(64),
      }),
    )
    .max(2),
  unavailable: z.array(z.string().max(160)).max(16),
});
const nativeRetirementSchema = z.object({
  candidates: z.array(nativeCandidateSchema).max(4),
  unavailable: z.string().max(160).optional(),
  startedAtMs: z.number(),
  finishedAtMs: z.number(),
});

type NativeBackup = z.infer<typeof nativeCandidateSchema>["backups"][number];
export type InstalledUpdateRetirementObservation = {
  runId: string;
  limitation: string;
  complete: boolean;
  unavailable?: string | string[];
  originalProcess?: { pid: number; startTicks: string };
  startedAtMs?: number;
  finishedAtMs?: number;
  parentPid?: number;
  createdAt?: string;
  moduleReportedPaths?: string[];
  moduleComparisonKeys?: string[];
  expectedModuleObserved?: boolean;
  modulesComplete?: boolean;
  backups?: Array<
    Omit<NativeBackup, "leaves"> & {
      leaves: Array<
        NativeBackup["leaves"][number] & {
          matchesExpectedDigest?: boolean;
          matchesExpectedRelativePath?: boolean;
        }
      >;
    }
  >;
  expectedAddon?: InstalledUpdateRetirementBinding["expectedAddon"];
};

function comparablePath(value: string): string {
  return path.win32.toNamespacedPath(path.win32.resolve(value)).toLowerCase();
}

export function readInstalledUpdateRetirementObservation(
  value: unknown,
  binding: InstalledUpdateRetirementBinding,
): InstalledUpdateRetirementObservation {
  const parsed = nativeRetirementSchema.safeParse(value);
  const common = { runId: binding.runId, limitation };
  if (
    !binding.expectedArgv[0] ||
    comparablePath(binding.expectedArgv[0]) !== comparablePath(binding.entry) ||
    binding.expectedArgv[1] !== "--profile" ||
    binding.expectedArgv[2] !== binding.profile ||
    binding.expectedArgv[3] !== "update"
  ) {
    return {
      ...common,
      complete: false,
      unavailable: "Expected invocation is not the selected profile updater",
    };
  }
  if (!parsed.success || parsed.data.unavailable) {
    return {
      ...common,
      complete: false,
      unavailable: parsed.success
        ? parsed.data.unavailable
        : "Invalid native retirement observation",
    };
  }
  const native = parsed.data;
  const expectedAddon = binding.expectedAddon;
  const exact = native.candidates.filter((candidate) => {
    const argv = parseCmdScriptCommandLine(candidate.commandLine);
    if (!argv[0] || comparablePath(argv[0]) !== comparablePath(binding.expectedNodeExe)) {
      return false;
    }
    const offset = argv[1] === "--stack-size=8192" ? 2 : 1;
    const actual = argv.slice(offset);
    return (
      actual.length === binding.expectedArgv.length &&
      actual.every((arg, index) =>
        index === 0
          ? comparablePath(arg) === comparablePath(binding.entry)
          : arg === binding.expectedArgv[index],
      )
    );
  });
  const leaves = exact.filter(
    (candidate) => !native.candidates.some((other) => other.parentPid === candidate.pid),
  );
  if (leaves.length !== 1) {
    return {
      ...common,
      complete: false,
      unavailable: "Original updater process is missing or ambiguous",
    };
  }
  const selected = leaves[0]!;
  if (
    !selected.startTicks ||
    selected.startTicks !== selected.afterStartTicks ||
    selected.hasExited !== false ||
    !selected.nodeReportedPath ||
    comparablePath(selected.nodeReportedPath) !== comparablePath(binding.expectedNodeExe) ||
    (binding.pinnedProcess &&
      (selected.pid !== binding.pinnedProcess.pid ||
        selected.startTicks !== binding.pinnedProcess.startTicks))
  ) {
    return {
      ...common,
      complete: false,
      unavailable: "Original updater identity could not be revalidated",
    };
  }
  return {
    ...common,
    startedAtMs: native.startedAtMs,
    finishedAtMs: native.finishedAtMs,
    originalProcess: { pid: selected.pid, startTicks: selected.startTicks },
    parentPid: selected.parentPid,
    createdAt: selected.createdAt,
    moduleReportedPaths: selected.moduleReportedPaths,
    moduleComparisonKeys: selected.moduleReportedPaths.map(comparablePath),
    expectedModuleObserved: expectedAddon
      ? selected.moduleReportedPaths.some(
          (reported) => comparablePath(reported) === comparablePath(expectedAddon.canonicalPath),
        )
      : undefined,
    modulesComplete: selected.modulesComplete,
    backups: selected.backups.map((backup) => ({
      ...backup,
      leaves: backup.leaves.map((leaf) => ({
        ...leaf,
        ...(binding.expectedAddon
          ? {
              matchesExpectedRelativePath:
                path.win32.normalize(leaf.relativePath).toLowerCase() ===
                path.win32.normalize(binding.expectedAddon.relativePath).toLowerCase(),
              matchesExpectedDigest:
                leaf.sha256 === undefined
                  ? undefined
                  : leaf.sha256 === binding.expectedAddon.sha256 &&
                    leaf.bytes === binding.expectedAddon.bytes,
            }
          : {}),
      })),
    })),
    expectedAddon: binding.expectedAddon,
    complete:
      selected.modulesComplete &&
      selected.backupsComplete &&
      selected.unavailable.length === 0 &&
      selected.backups.every(
        (backup) =>
          backup.complete &&
          backup.unavailable.length === 0 &&
          backup.leaves.every(
            (leaf) => leaf.unavailable === undefined && leaf.sha256 !== undefined,
          ),
      ),
    unavailable: selected.unavailable,
  };
}

/** Runs inside the existing single five-second PowerShell census, never another process. */
export function buildInstalledUpdateRetirementCensus(
  binding: InstalledUpdateRetirementBinding,
): string {
  const encoded = Buffer.from(JSON.stringify(binding), "utf8").toString("base64");
  return String.raw`
$ErrorActionPreference='Stop'
$watch=[Diagnostics.Stopwatch]::StartNew()
$binding=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$startedAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$all=@(Get-CimInstance Win32_Process)
$rows=@($all | Select-Object ProcessId,ParentProcessId,CommandLine,UserModeTime,KernelModeTime,ReadOperationCount,WriteOperationCount,OtherOperationCount,@{Name='CreationDate';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}})
$retirement=@{startedAtMs=$startedAtMs;finishedAtMs=$startedAtMs;candidates=@()}
function Check-Budget([int]$limit=3800) {
  if ($watch.ElapsedMilliseconds -ge $limit) {throw 'observation-budget-exhausted'}
}
function Get-FailureReason($failure) {
  $known=@('observation-budget-exhausted','reparse-leaf-refused','hash-byte-limit','leaf-changed-during-read','reparse-root-refused','directory-depth-limit','reparse-directory-refused','inventory-entry-limit','reparse-entry-refused','inventory-leaf-limit','command-anchor-missing','command-anchor-creation-mismatch','startup-chain-limit','reparse-global-root-refused','native-start-outside-invocation','pinned-start-mismatch','module-path-limit','backup-parent-entry-limit','reparse-shim-root-refused','shim-creation-outside-invocation','backup-root-limit')
  $message=[string]$failure.Exception.Message
  if ($known -ccontains $message) {return $message}
  return $failure.Exception.GetType().Name
}
function Is-Reparse([string]$itemPath) {
  return (([IO.File]::GetAttributes($itemPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Read-Leaf([string]$itemPath,[string]$relative,[hashtable]$bounds) {
  $leaf=@{relativePath=$relative}
  $stream=$null
  $digest=$null
  try {
    Check-Budget
    if (Is-Reparse $itemPath) {throw 'reparse-leaf-refused'}
    $sharing=[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream=[IO.File]::Open($itemPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,$sharing)
    $leaf.bytes=$stream.Length
    if ($stream.Length -gt 2097152 -or $bounds.bytes + $stream.Length -gt 8388608) {throw 'hash-byte-limit'}
    $digest=[Security.Cryptography.SHA256]::Create()
    $buffer=New-Object byte[] 65536
    $readBytes=0L
    while (($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0) {
      Check-Budget
      $readBytes += $count
      $bounds.bytes += $count
      if ($readBytes -gt 2097152 -or $bounds.bytes -gt 8388608) {throw 'hash-byte-limit'}
      [void]$digest.TransformBlock($buffer,0,$count,$buffer,0)
    }
    [void]$digest.TransformFinalBlock($buffer,0,0)
    if ($stream.Length -ne $leaf.bytes -or $readBytes -ne $leaf.bytes) {throw 'leaf-changed-during-read'}
    $leaf.sha256=([BitConverter]::ToString($digest.Hash)).Replace('-','').ToLowerInvariant()
  } catch {
    $leaf.unavailable='leaf-read-unavailable:' + (Get-FailureReason $_)
  } finally {
    if ($stream) {$stream.Dispose()}
    if ($digest) {$digest.Dispose()}
  }
  return $leaf
}
function Read-Backup([string]$root,[hashtable]$bounds,[string]$kind) {
  $result=@{root=$root;kind=$kind;complete=$true;unavailable=@();leaves=@()}
  try {
    Check-Budget
    if (Is-Reparse $root) {throw 'reparse-root-refused'}
    $pending=New-Object Collections.Stack
    $pending.Push(@{path=$root;relative='';depth=0})
    while ($pending.Count -gt 0) {
      Check-Budget
      $directory=$pending.Pop()
      if ($directory.depth -gt 16) {throw 'directory-depth-limit'}
      if (Is-Reparse $directory.path) {throw 'reparse-directory-refused'}
      foreach ($itemPath in [IO.Directory]::EnumerateFileSystemEntries($directory.path)) {
        Check-Budget
        $bounds.entries++
        if ($bounds.entries -gt 256) {throw 'inventory-entry-limit'}
        $relative=if ($directory.relative) {[IO.Path]::Combine($directory.relative,[IO.Path]::GetFileName($itemPath))} else {[IO.Path]::GetFileName($itemPath)}
        if (Is-Reparse $itemPath) {throw 'reparse-entry-refused'}
        $attributes=[IO.File]::GetAttributes($itemPath)
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
          $pending.Push(@{path=$itemPath;relative=$relative;depth=$directory.depth+1})
        } else {
          if ($result.leaves.Count -ge 64) {throw 'inventory-leaf-limit'}
          $leaf=Read-Leaf $itemPath $relative $bounds
          $result.leaves += $leaf
          if ($leaf.unavailable) {$result.complete=$false}
        }
      }
    }
  } catch {
    $result.complete=$false
    $result.unavailable += 'inventory-unavailable:' + (Get-FailureReason $_)
  }
  return $result
}
try {
  Check-Budget
  $command=@($all | Where-Object {$_.ProcessId -eq $binding.commandPid})
  if ($command.Count -ne 1 -or $command[0].ParentProcessId -ne $binding.launcherPid) {throw 'command-anchor-missing'}
  $lower=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$binding.commandStartedAtMs).UtcDateTime
  $spawnUpper=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$binding.commandSpawnedAtMs + 1).UtcDateTime
  $runUpper=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$binding.runCreatedAtMs + 1).UtcDateTime
  $created=$command[0].CreationDate.ToUniversalTime()
  if ($created -lt $lower -or $created -ge $spawnUpper -or $created -ge $runUpper) {throw 'command-anchor-creation-mismatch'}
  $chain=@{}
  $chain[[int]$binding.commandPid]=$command[0]
  do {
    $changed=$false
    foreach ($row in $all) {
      if ($chain.ContainsKey([int]$row.ProcessId) -or !$chain.ContainsKey([int]$row.ParentProcessId)) {continue}
      $parent=$chain[[int]$row.ParentProcessId]
      if (!$row.CreationDate -or $row.CreationDate -lt $parent.CreationDate -or $row.CreationDate.ToUniversalTime() -ge $runUpper) {continue}
      $chain[[int]$row.ProcessId]=$row
      $changed=$true
      if ($chain.Count -gt 4) {throw 'startup-chain-limit'}
    }
  } while ($changed)
  $globalRoot=[IO.Path]::GetFullPath([string]$binding.globalRoot)
  if (Is-Reparse $globalRoot) {throw 'reparse-global-root-refused'}
  $bounds=@{entries=0;bytes=0L}
  foreach ($row in $chain.Values) {
    $candidate=@{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;createdAt=$row.CreationDate.ToUniversalTime().ToString('o');commandLine=[string]$row.CommandLine;moduleReportedPaths=@();modulesComplete=$false;backupsComplete=$false;backups=@();unavailable=@()}
    $process=$null
    $fresh=$null
    try {
      Check-Budget
      $process=Get-Process -Id $candidate.pid -ErrorAction Stop
      $start=$process.StartTime.ToUniversalTime()
      if ($start -lt $lower -or $start -ge $runUpper -or $process.HasExited) {throw 'native-start-outside-invocation'}
      $candidate.startTicks=$start.ToFileTimeUtc().ToString()
      $candidate.nodeReportedPath=$process.MainModule.FileName
      if ($binding.pinnedProcess -and $candidate.pid -eq $binding.pinnedProcess.pid -and $candidate.startTicks -ne $binding.pinnedProcess.startTicks) {throw 'pinned-start-mismatch'}
      try {
        foreach ($module in $process.Modules) {
          Check-Budget
          if ([IO.Path]::GetFileName($module.FileName) -ine 'koffi.node') {continue}
          if ($candidate.moduleReportedPaths.Count -ge 4) {throw 'module-path-limit'}
          $candidate.moduleReportedPaths += [string]$module.FileName
        }
        $candidate.modulesComplete=$true
      } catch {$candidate.unavailable += 'module-enumeration-unavailable:' + (Get-FailureReason $_)}
      try {
        $rootEntries=0
        foreach ($rootPath in [IO.Directory]::EnumerateDirectories($globalRoot)) {
          Check-Budget
          $rootEntries++
          if ($rootEntries -gt 256) {throw 'backup-parent-entry-limit'}
          $name=[IO.Path]::GetFileName($rootPath)
          $pattern='^\.openclaw[.-]package-backup-' + $candidate.pid + '-([0-9]{13})$'
          $kind=$null
          $shimCreatedAtMs=$null
          if ($name -match $pattern) {
            $stamp=[long]$Matches[1]
            if ($stamp -lt $binding.commandStartedAtMs -or $stamp -gt $startedAtMs) {continue}
            $kind='pid-name-correlation'
          } elseif ($binding.namespaceWasEmpty -eq $true -and $name -cmatch '^\.openclaw\.shim-backup-[A-Za-z0-9]{6}$') {
            if (Is-Reparse $rootPath) {throw 'reparse-shim-root-refused'}
            $shimCreatedAtMs=([DateTimeOffset][IO.Directory]::GetCreationTimeUtc($rootPath)).ToUnixTimeMilliseconds()
            if ($shimCreatedAtMs -lt $binding.commandStartedAtMs -or $shimCreatedAtMs -gt $startedAtMs) {throw 'shim-creation-outside-invocation'}
            $kind='shim-namespace'
          } else {continue}
          if ($candidate.backups.Count -ge 2) {throw 'backup-root-limit'}
          $backup=Read-Backup $rootPath $bounds $kind
          if ($null -ne $shimCreatedAtMs) {$backup.createdAtMs=$shimCreatedAtMs}
          $candidate.backups += $backup
        }
        $candidate.backupsComplete=@($candidate.backups | Where-Object {!$_.complete}).Count -eq 0
      } catch {$candidate.unavailable += 'backup-enumeration-unavailable:' + (Get-FailureReason $_)}
    } catch {$candidate.unavailable += 'process-observation-unavailable:' + (Get-FailureReason $_)}
    finally {
      try {
        Check-Budget 4500
        $fresh=Get-Process -Id $candidate.pid -ErrorAction Stop
        $candidate.afterStartTicks=$fresh.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        $candidate.hasExited=(!$process -or $process.HasExited -or $fresh.HasExited)
      } catch {$candidate.unavailable += 'process-recheck-unavailable:' + (Get-FailureReason $_)}
      if ($fresh) {$fresh.Dispose()}
      if ($process) {$process.Dispose()}
    }
    $retirement.candidates += $candidate
  }
} catch {$retirement.unavailable='retirement-observation-unavailable:' + (Get-FailureReason $_)}
$retirement.finishedAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
@{processes=$rows;retirement=$retirement} | ConvertTo-Json -Depth 12 -Compress
`;
}
