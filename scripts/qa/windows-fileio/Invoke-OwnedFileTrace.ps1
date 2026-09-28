[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('prepare','observe','cleanup')][string]$Mode,
  [Parameter(Mandatory)][string]$ReceiptPath,
  [Parameter(Mandatory)][guid]$ExpectedGuid,
  [uint32]$TargetProcessId,
  [string]$NativeStartFileTime,
  [string]$OwnedPrefix,
  [ValidateRange(100,1500)][int]$CaptureMilliseconds = 1000
)
$ErrorActionPreference = 'Stop'
$sessionName = 'OpenClaw-Owned-FileIO-' + $ExpectedGuid.ToString('N')
$receiptFile = [IO.Path]::GetFullPath($ReceiptPath)
$privateDirectory = [IO.Path]::GetDirectoryName($receiptFile)
$dll = [IO.Path]::Combine($privateDirectory, 'OwnedFileTrace.dll')
$raw = [IO.Path]::Combine($privateDirectory, 'private-host-events.etl')
$schemaFile = [IO.Path]::Combine($privateDirectory, 'provider-schema.json')
$providerName = 'Microsoft-Windows-Kernel-File'

function Write-ExclusiveJson([string]$File, $Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
  $temporary = $File + '.pending'
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Move($temporary,$File)
}
function Emit($Value) { $Value | ConvertTo-Json -Depth 12 -Compress }
function Read-Receipt {
  $r = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
  if ($r.contract -ne 'owned-fileio-v1' -or $r.guid -ne $ExpectedGuid.ToString() -or
      $r.name -ne $sessionName -or $r.raw -ne $raw -or $r.dll -ne $dll) { throw 'Ownership receipt mismatch' }
  return $r
}
function Test-TraceAbsent {
  try { $null = [OwnedFileTrace]::Query($sessionName,$ExpectedGuid); return $false }
  catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 4201) { return $true }
    throw
  }
}
function Stop-OwnedTrace {
  if (Test-TraceAbsent) { return $null }
  $stop = [OwnedFileTrace]::Stop($sessionName,$ExpectedGuid)
  if (-not (Test-TraceAbsent)) { throw 'Trace stop not verified' }
  if (-not $stop.StatisticsKnown) {
    return @{ stopStatus=$stop.Status; statisticsKnown=$false; eventsLost=$null;
      logBuffersLost=$null; realTimeBuffersLost=$null; buffersWritten=$null }
  }
  $p = $stop.Statistics
  return @{ stopStatus=$stop.Status; statisticsKnown=$true; eventsLost=$p.EventsLost;
    logBuffersLost=$p.LogBuffersLost; realTimeBuffersLost=$p.RealTimeBuffersLost; buffersWritten=$p.BuffersWritten }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows required' }
  if (-not [IO.Directory]::Exists($privateDirectory)) { throw 'Owner must admit and create private directory first' }
  if ($ExpectedGuid -eq [guid]::Empty) { throw 'Nonempty owner-admitted GUID required' }
  if ($Mode -eq 'prepare') {
    if ([IO.File]::Exists($receiptFile) -or [IO.File]::Exists($raw) -or [IO.File]::Exists($dll)) { throw 'Preparation paths already occupied' }
    # Kernel-File's manifest GUID is stable; discovery must independently agree.
    $providerGuid='edd08927-9cc4-4e65-b970-c2560fb5c289'
    $receipt = @{ contract='owned-fileio-v1'; guid=$ExpectedGuid.ToString(); name=$sessionName;
      raw=$raw; dll=$dll; provider=$providerGuid; preparedAt=[DateTime]::UtcNow.ToString('O') }
    Write-ExclusiveJson $receiptFile $receipt
    # All slow preparation precedes updater execution; no provider is enabled here.
    Add-Type -Path ([IO.Path]::Combine($PSScriptRoot,'OwnedFileTrace.cs')) -OutputAssembly $dll
    Add-Type -Path $dll
    $provider = Get-WinEvent -ListProvider $providerName
    if($provider.Id -ne [guid]$providerGuid){throw 'Unexpected provider identity'}
    $schemas = @($provider.Events | ForEach-Object {
      @{ id=[int]$_.Id; version=[int]$_.Version; task=[string]$_.Task.Name;
         opcode=[string]$_.Opcode.Name; template=[string]$_.Template }
    })
    if ($schemas.Count -eq 0 -or $schemas.Count -gt 512) { throw 'Provider schema unavailable or oversized' }
    Write-ExclusiveJson $schemaFile $schemas
    if (-not (Test-TraceAbsent)) { throw 'Session name occupied; refusing acquisition' }
    $handle = [OwnedFileTrace]::Start($sessionName,$ExpectedGuid,$raw)
    Write-ExclusiveJson ([IO.Path]::Combine($privateDirectory,'acquired.json')) @{ handle=$handle.ToString() }
    Emit @{ phase='prepared'; guid=$ExpectedGuid.ToString(); name=$sessionName;
      providerEnabled=$false; rawArtifactUploadAllowed=$false; cleanupVerified=$false }
    return
  }
  if ($Mode -eq 'cleanup') {
    # Cleanup must also work after interrupted DLL compilation. This runs only
    # in the existing owner's teardown budget, never in the five-second census.
    Add-Type -Path ([IO.Path]::Combine($PSScriptRoot,'OwnedFileTrace.cs'))
    if(-not [IO.File]::Exists($receiptFile)) {
      if(-not (Test-TraceAbsent) -or [IO.File]::Exists($raw)){throw 'Missing acquisition custody'}
      Emit @{phase='cleanup';name=$sessionName;guid=$ExpectedGuid.ToString();traceAbsent=$true;
        rawAbsent=$true;cleanupVerified=$true;acquisition='not-started';loss=$null}
      return
    }
    $receipt = Read-Receipt
    $stats = Stop-OwnedTrace
    # Delete only the receipt-bound raw ETL, never a directory or foreign session.
    if ([IO.File]::Exists($raw)) { [IO.File]::Delete($raw) }
    Emit @{ phase='cleanup'; name=$sessionName; guid=$ExpectedGuid.ToString();
      traceAbsent=(Test-TraceAbsent); rawAbsent=(-not [IO.File]::Exists($raw));
      cleanupVerified=$true; loss=$stats }
    return
  }
  $receipt = Read-Receipt
  Add-Type -Path $dll

  $clock = [Diagnostics.Stopwatch]::StartNew()
  $processHandle = [IntPtr]::Zero
  $threadLease = $null
  $rows = [Collections.Generic.List[object]]::new()
  $partial = [Collections.Generic.HashSet[string]]::new()
  $pending = @{}; $objects = @{}; $ownedKeys = @{}
  $excludedObjects = [Collections.Generic.HashSet[string]]::new()
  $counts = @{ parsed=0; ownBegins=0; unmatchedEnds=0; unresolvedTargets=0; unresolvedThreads=0; outOfScope=0 }
  $loss = $null; $stopped = $false; $start = $null; $end = $null
  $threadRefresh = 'not-attempted'
  $identityRefused = $false
  try {
    if ($TargetProcessId -eq 0 -or $NativeStartFileTime -notmatch '^[0-9]{15,20}$') { throw 'Exact native process identity required' }
    $startIdentity = [long]::Parse($NativeStartFileTime)
    $root = [IO.Path]::GetFullPath($OwnedPrefix).TrimEnd('\')
    if ($root -notmatch '^[A-Za-z]:\\.+' -or $root.Length -gt 1024 -or $root -match '[*?]') { throw 'Owned non-root local prefix required' }
    $rootDevice = [OwnedFileTrace]::Device($root.Substring(0,2)) + $root.Substring(2)
    $processHandle = [OwnedFileTrace]::HoldProcess($TargetProcessId,$startIdentity)
    $threadLease = [OwnedFileTrace+ThreadLease]::new($TargetProcessId,$startIdentity,$processHandle)
    $schemas = Get-Content -LiteralPath $schemaFile -Raw | ConvertFrom-Json
    $lookup = @{}
    foreach ($s in $schemas) { $lookup[([string]$s.id + ':' + [string]$s.version)] = $s }
    Write-ExclusiveJson ([IO.Path]::Combine($privateDirectory,'observe-claimed.json')) @{
      pid=$TargetProcessId; nativeStartFileTime=$NativeStartFileTime }
    $start = [DateTime]::UtcNow
    [OwnedFileTrace]::Enable($sessionName,$ExpectedGuid,[guid]$receipt.provider)
    # Optional fixture owner sends observe after this fixed-size readiness line.
    Emit @{ phase='observing'; pid=$TargetProcessId; nativeStartFileTime=$NativeStartFileTime }
    Start-Sleep -Milliseconds $CaptureMilliseconds
    $loss = Stop-OwnedTrace
    $stopped = $true
    $end = [DateTime]::UtcNow
    # Existing threads retain native handles through target exit. New threads are
    # usable only when their own creation/exit interval covers the request event.
    try { $threadLease.Refresh(); $threadRefresh='completed' } catch { $threadRefresh='unavailable' }
    Write-ExclusiveJson ([IO.Path]::Combine($privateDirectory,'stopped.json')) @{ loss=$loss; stoppedAt=$end.ToString('O') }
    if ($null -eq $loss) { $null = $partial.Add('trace-ended-before-stop-loss-unknown') }
    elseif (-not $loss.statisticsKnown) { $null = $partial.Add('stop-statistics-incomplete') }
    elseif ($loss.eventsLost -or $loss.logBuffersLost -or $loss.realTimeBuffersLost) { $null = $partial.Add('etw-loss') }
    if (-not [IO.File]::Exists($raw)) { throw 'No ETL' }
    if ((Get-Item -LiteralPath $raw).Length -ge 8MB) { $null = $partial.Add('etl-size-cap') }

    function Resolve-OwnedPath([string]$Candidate) {
      if (-not $Candidate -or $Candidate.Length -gt 2048) { return @{scope='unknown'} }
      $v = $Candidate
      if ($v.StartsWith('\??\')) { $v = $v.Substring(4) }
      elseif ($v.StartsWith('\\?\')) { $v = $v.Substring(4) }
      foreach ($prefix in @($root,$rootDevice)) {
        if($v.Equals($prefix,[StringComparison]::OrdinalIgnoreCase)){return @{scope='owned';relative='.'}}
        if ($v.StartsWith($prefix + '\',[StringComparison]::OrdinalIgnoreCase)) {
          $relative = $v.Substring($prefix.Length + 1)
          if ($relative -match '(^|\\)\.\.?($|\\)' -or $relative.Contains(':')) { return @{scope='unknown'} }
          return @{scope='owned';relative=$relative}
        }
      }
      if($v -match '^(?:[A-Za-z]:\\|\\Device\\)' -and $v -notmatch '(^|\\)\.\.?($|\\)'){return @{scope='outside'}}
      return @{scope='unknown'}
    }
    function Field($Map,[string[]]$Names) {
      foreach ($name in $Names) { if ($Map.ContainsKey($name)) { return [string]$Map[$name] } }
      return $null
    }
    function Pointer([string]$Value) {
      if (-not $Value) { return $null }
      $number = if ($Value.StartsWith('0x')) { [Convert]::ToUInt64($Value.Substring(2),16) } else { [uint64]::Parse($Value) }
      if ($number -eq 0) { return $null }
      return ('{0:X16}' -f $number)
    }
    Get-WinEvent -Path $raw -Oldest -MaxEvents 20001 | ForEach-Object {
      $event = $_
      try {
        $counts.parsed++
        if ($counts.parsed -gt 20000 -or $clock.ElapsedMilliseconds -ge 4500) { throw 'BoundReached' }
        if ($event.ProviderId -ne [guid]$receipt.provider) { return }
        $time = $event.TimeCreated.ToUniversalTime()
        if ($time -lt $start -or $time -gt $end) { return }
        if (-not $threadLease.ProcessContainsTime($time.ToFileTimeUtc())) { return }
        $s = $lookup[([string]$event.Id + ':' + [string]$event.Version)]
        if (-not $s) { $null = $partial.Add('unknown-event-schema'); return }
        [xml]$xml = $event.ToXml()
        $fields = @{}
        foreach ($data in $xml.Event.EventData.Data) { $fields[[string]$data.Name] = [string]$data.'#text' }
        $irp = Pointer (Field $fields @('Irp','IrpPtr'))
        $obj = Pointer (Field $fields @('FileObject'))
        $key = Pointer (Field $fields @('FileKey'))
        $tidText = Field $fields @('IssuingThreadId','TTID','ThreadId')
        $ntstatus = Field $fields @('Status')
        $name = Field $fields @('FileName','OpenPath','FilePath')
        $pathFact = Resolve-OwnedPath $name
        $relative = $pathFact.relative
        # Host-wide names are never retained. Unknown lifetimes invalidate maps.
        $kind = [string]$s.task + '/' + [string]$s.opcode
        $isCreate = $kind -match 'Create' -or $fields.ContainsKey('CreateOptions')
        $isClose = $kind -match 'Close|Cleanup'
        $previousTarget = if($obj){$objects[$obj]}else{$null}
        if(-not $previousTarget -and $key){$previousTarget=$ownedKeys[$key]}
        $previousExcluded = $obj -and $excludedObjects.Contains($obj)
        if ($obj -and ($isCreate -or $kind -match 'NameDelete|Close|Cleanup')) {
          foreach ($request in $pending.Values) {
            if ($request.isCreate -and $request.object -eq $obj) { $request.allowObjectMapping = $false }
          }
        }
        if ($isCreate) {
          if ($obj) { $objects.Remove($obj); $null=$excludedObjects.Remove($obj) }
        }
        if ($isClose -and $obj) { $objects.Remove($obj); $null=$excludedObjects.Remove($obj) }
        if ($kind -match 'NameDelete' -and $key) {
          $ownedKeys.Remove($key)
        }
        if (-not $irp -and $kind -match 'NameCreate' -and $key -and $name) {
          $ownedKeys.Remove($key)
          if ($relative) {
            if ($pending.Count + $objects.Count + $ownedKeys.Count + $excludedObjects.Count -ge 1024) { throw 'BoundReached' }
            $ownedKeys[$key] = $relative
          }
          return
        }
        if ($irp -and $ntstatus) {
          if ($pending.ContainsKey($irp)) {
            $begin = $pending[$irp]; $pending.Remove($irp)
            $statusNumber = if ($ntstatus.StartsWith('0x')) { [Convert]::ToUInt32($ntstatus.Substring(2),16) } else { [uint32]::Parse($ntstatus) }
            # A create path is provisional until its matching successful end.
            # Failed creates must never seed later object/key attribution.
            if ($begin.isCreate) {
              if ($begin.object) { $objects.Remove($begin.object); $null=$excludedObjects.Remove($begin.object) }
            }
            if ($time -lt $begin.time) { $null = $partial.Add('nonmonotonic-irp'); return }
            if ($partial.Count -gt 0) { return }
            if ($begin.isCreate -and $begin.allowObjectMapping -and $begin.object -and $statusNumber -lt 2147483648) {
              if ($pending.Count + $objects.Count + $ownedKeys.Count + $excludedObjects.Count -ge 1024) { throw 'BoundReached' }
              if($begin.outside){$null=$excludedObjects.Add($begin.object)}else{$objects[$begin.object] = $begin.target}
            }
            if($begin.outside){return}
            $rows.Add(@{ pid=$TargetProcessId; nativeStartFileTime=$NativeStartFileTime;
              threadId=$begin.tid; relativeTarget=$begin.target; operation=$begin.operation;
              eventId=$begin.id; eventVersion=$begin.version; infoClass=$begin.infoClass;
              beganAt=$begin.time.ToString('O'); completedAt=$time.ToString('O');
              ntStatus=('0x{0:X8}' -f $statusNumber) })
            if ($rows.Count -ge 256) { throw 'BoundReached' }
          } else { $counts.unmatchedEnds++ }
          return
        }
        if (-not $irp) { return }
        # A changed name cannot keep an earlier object target alive.
        if ($name -and $obj) { $objects.Remove($obj) }
        # Any second begin destroys the former correlation, including foreign IRPs.
        if ($pending.ContainsKey($irp)) { $pending.Remove($irp); $null = $partial.Add('irp-reuse-without-end') }
        if (-not $tidText) { return }
        $threadId = [uint32]$tidText
        if (-not $threadLease.BelongsAt($threadId,$time.ToFileTimeUtc())) {
          $counts.unresolvedThreads++; return
        }
        $counts.ownBegins++
        $outside = $pathFact.scope -eq 'outside'
        # An unnamed create starts a new lifetime; an explicit non-owned name
        # cannot fall back to a stale owned target from either lookup.
        if (-not $name -and -not $isCreate) {
          if($isClose){$relative=$previousTarget;$outside=$previousExcluded}
          else {
            if ($obj) { $relative = $objects[$obj]; $outside=$excludedObjects.Contains($obj) }
            if (-not $relative -and -not $outside -and $key) { $relative = $ownedKeys[$key] }
          }
        }
        if($outside){$counts.outOfScope++;if(-not $isCreate){return}}
        if (-not $relative -and -not $outside) { $counts.unresolvedTargets++; return }
        if ($pending.Count + $objects.Count + $ownedKeys.Count + $excludedObjects.Count -ge 1024) { throw 'BoundReached' }
        $pending[$irp] = @{ tid=$threadId; target=$relative; operation=$kind; time=$time;
          isCreate=$isCreate; allowObjectMapping=$true; object=$obj; key=$key; outside=$outside;
          id=[int]$event.Id; version=[int]$event.Version; infoClass=(Field $fields @('InfoClass')) }
      } finally { $event.Dispose() }
    }
  } catch {
    # No event XML, foreign path, or raw exception content crosses the boundary.
    $cause=$_.Exception
    while($cause.InnerException){$cause=$cause.InnerException}
    $identityRefused = $cause -is [InvalidOperationException] -and $cause.Message -eq 'Target creation identity mismatch'
    $null = $partial.Add('capture-or-projection-incomplete')
  } finally {
    if (-not $stopped) {
      try { $loss = Stop-OwnedTrace; $stopped = $true } catch { $null = $partial.Add('cleanup-unverified') }
    }
    if ($null -ne $threadLease) { $threadLease.Dispose() }
    if ($processHandle -ne [IntPtr]::Zero) { $null = [OwnedFileTrace]::CloseHandle($processHandle) }
  }
  if ($pending.Count) { $null = $partial.Add('requests-without-completion') }
  if ($counts.unresolvedTargets) { $null = $partial.Add('owned-requests-without-path') }
  if ($counts.unresolvedThreads) { $null = $partial.Add('unverified-issuing-threads') }
  if ($threadRefresh -ne 'completed') { $null = $partial.Add('thread-refresh-incomplete') }
  if ($clock.ElapsedMilliseconds -ge 4500) { $null = $partial.Add('observation-budget-reached') }
  $result = @{ phase='result'; observation= $(if ($rows.Count -gt 0) { 'attributed' } else { 'insufficient-evidence' });
    coverageComplete=($partial.Count -eq 0);
    pid=$TargetProcessId; nativeStartFileTime=$NativeStartFileTime; records=@($rows.ToArray());
    partial=@($partial); counts=$counts; loss=$loss; cleanupVerified=$stopped;
    elapsedMs=$clock.ElapsedMilliseconds; rawArtifactUploadAllowed=$false }
  $result.threadCoverage = @{ before='held-native-handles'; after=$threadRefresh; maximumHandles=256 }
  $result.identityRefused = $identityRefused
  $encoded = $result | ConvertTo-Json -Depth 12 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 256KB) {
    $result.records=@(); $result.observation='insufficient-evidence'; $result.partial=@('projection-byte-cap')
  }
  Emit $result
  if (-not $stopped) { exit 2 }
} catch {
  Emit @{ phase=$Mode; observation='insufficient-evidence'; cleanupVerified=$false;
    reason='native-probe-failed-or-ownership-refused'; rawArtifactUploadAllowed=$false }
  exit 2
}
