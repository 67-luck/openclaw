# Canonical FileIO operations. Callers own streaming and work inside the capture window.
function Invoke-OwnedFileTraceOperation {
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('prepare','observe','cleanup')][string]$Mode,
  [Parameter(Mandatory)][string]$ReceiptPath,
  [Parameter(Mandatory)][guid]$ExpectedGuid,
  [uint32]$TargetProcessId,
  [string]$NativeStartFileTime,
  [string]$OwnedPrefix,
  [ValidateRange(100,1500)][int]$CaptureMilliseconds = 1000,
  [Diagnostics.Stopwatch]$ObservationClock,
  [scriptblock]$ObserveWork,
  [scriptblock]$PublishFact,
  [string]$ExpectedDllSha256,
  [string]$ExpectedSourceSha256,
  [string]$ExpectedSchemaSha256,
  [string]$ExpectedHelperSha256,
  [string]$ExpectedFactsSha256
)
$ErrorActionPreference = 'Stop'
$sessionName = 'OpenClaw-Owned-FileIO-' + $ExpectedGuid.ToString('N')
$receiptFile = [IO.Path]::GetFullPath($ReceiptPath)
$privateDirectory = [IO.Path]::GetDirectoryName($receiptFile)
$dll = [IO.Path]::Combine($privateDirectory, 'OwnedFileTrace.dll')
$raw = [IO.Path]::Combine($privateDirectory, 'private-host-events.etl')
$schemaFile = [IO.Path]::Combine($privateDirectory, 'provider-schema.json')
$providerName = 'Microsoft-Windows-Kernel-File'
$diagnosticAvailable=$false
$emitted=[Collections.Generic.List[object]]::new()

function Write-ExclusiveJson([string]$File, $Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
  $temporary = $File + '.pending'
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Move($temporary,$File)
}
function Emit($Value) {
  $emitted.Add($Value)
  if($PublishFact){$null=& $PublishFact $Value}
}
function Hash-OwnedFile([string]$File) {
  if((Get-Item -LiteralPath $File -ErrorAction Stop).Length -gt 4MB){throw 'Prepared input byte cap'}
  return (Get-FileHash -LiteralPath $File -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Read-TraceRuntime {
  $current=[Diagnostics.Process]::GetCurrentProcess()
  try {
    return @{executable=$current.MainModule.FileName;psVersion=$PSVersionTable.PSVersion.ToString();
      edition=$PSVersionTable.PSEdition;clrVersion=[Environment]::Version.ToString();
      is64BitProcess=[Environment]::Is64BitProcess}
  } finally {$current.Dispose()}
}
function Update-PrivateReceipt($Value) {
  $temporary=$receiptFile+'.ready-pending'
  Write-ExclusiveJson $temporary $Value
  [IO.File]::Replace($temporary,$receiptFile,$null)
}
function Assert-PreparedInput($Receipt) {
  $runtime=Read-TraceRuntime
  foreach($key in @('executable','psVersion','edition','clrVersion','is64BitProcess')) {
    if([string]$Receipt.runtime.$key -ine [string]$runtime[$key]){throw 'Prepared runtime mismatch'}
  }
  foreach($entry in @(
    @('dllSha256',$dll,$ExpectedDllSha256),
    @('sourceSha256',(Join-Path $PSScriptRoot 'OwnedFileTrace.cs'),$ExpectedSourceSha256),
    @('schemaSha256',$schemaFile,$ExpectedSchemaSha256),
    @('helperSha256',(Join-Path $PSScriptRoot 'OwnedFileTraceOperations.ps1'),$ExpectedHelperSha256),
    @('factsSha256',(Join-Path $PSScriptRoot 'FileTraceFacts.ps1'),$ExpectedFactsSha256),
    @('cliSha256',(Join-Path $PSScriptRoot 'Invoke-OwnedFileTrace.ps1'),$null)
  )) {
    $recorded=[string]$Receipt.($entry[0])
    if($recorded -cnotmatch '^[0-9a-f]{64}$' -or (Hash-OwnedFile $entry[1]) -cne $recorded -or
        ($entry[2] -and [string]$entry[2] -cne $recorded)){throw 'Prepared input binding mismatch'}
  }
}
function Read-Receipt {
  $r = Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json
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
  if($Mode -eq 'prepare'){Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='entered'}}
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows required' }
  if (-not [Environment]::Is64BitProcess) {throw '64-bit PowerShell required'}
  if ($Mode -ne 'cleanup' -and -not [IO.Directory]::Exists($privateDirectory)) { throw 'Owner must admit and create private directory first' }
  if ($ExpectedGuid -eq [guid]::Empty) { throw 'Nonempty owner-admitted GUID required' }
  if ($Mode -eq 'prepare') {
    if ([IO.File]::Exists($receiptFile) -or [IO.File]::Exists($raw) -or [IO.File]::Exists($dll)) { throw 'Preparation paths already occupied' }
    # Kernel-File's manifest GUID is stable; discovery must independently agree.
    $providerGuid='edd08927-9cc4-4e65-b970-c2560fb5c289'
    $receipt = @{ contract='owned-fileio-v1'; guid=$ExpectedGuid.ToString(); name=$sessionName;
      raw=$raw; dll=$dll; provider=$providerGuid; preparedAt=[DateTime]::UtcNow.ToString('O');
      sourceSha256=(Hash-OwnedFile (Join-Path $PSScriptRoot 'OwnedFileTrace.cs'));
      helperSha256=(Hash-OwnedFile (Join-Path $PSScriptRoot 'OwnedFileTraceOperations.ps1'));
      factsSha256=(Hash-OwnedFile (Join-Path $PSScriptRoot 'FileTraceFacts.ps1'));
      cliSha256=(Hash-OwnedFile (Join-Path $PSScriptRoot 'Invoke-OwnedFileTrace.ps1'));
      runtime=(Read-TraceRuntime) }
    Write-ExclusiveJson $receiptFile $receipt
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='custody-written'}
    # All slow preparation precedes updater execution; no provider is enabled here.
    Add-Type -Path ([IO.Path]::Combine($PSScriptRoot,'OwnedFileTrace.cs')) -OutputAssembly $dll
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='dll-compiled'}
    Add-Type -Path $dll
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='dll-loaded'}
    $provider = Get-WinEvent -ListProvider $providerName
    if($provider.Id -ne [guid]$providerGuid){throw 'Unexpected provider identity'}
    $schemas = @($provider.Events | ForEach-Object {
      @{ id=[int]$_.Id; version=[int]$_.Version; task=[string]$_.Task.Name;
         opcode=[string]$_.Opcode.Name; template=[string]$_.Template }
    })
    if ($schemas.Count -eq 0 -or $schemas.Count -gt 512) { throw 'Provider schema unavailable or oversized' }
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='schema-discovered'}
    Write-ExclusiveJson $schemaFile $schemas
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='schema-written'}
    $receipt.dllSha256=Hash-OwnedFile $dll
    $receipt.schemaSha256=Hash-OwnedFile $schemaFile
    Update-PrivateReceipt $receipt
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='inputs-bound'}
    . (Join-Path $PSScriptRoot 'FileTraceFacts.ps1')
    try { Emit (Get-FileTracePublicSchema $schemas) }
    catch { Emit @{phase='provider-metadata';diagnosticOnly=$true;unavailable=$true;events=@()} }
    if (-not (Test-TraceAbsent)) { throw 'Session name occupied; refusing acquisition' }
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='trace-absent'}
    $handle = [OwnedFileTrace]::Start($sessionName,$ExpectedGuid,$raw)
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='trace-started'}
    Write-ExclusiveJson ([IO.Path]::Combine($privateDirectory,'acquired.json')) @{ handle=$handle.ToString() }
    Emit @{phase='prepare-stage';diagnosticOnly=$true;stage='acquisition-written'}
    Emit @{ phase='prepared'; guid=$ExpectedGuid.ToString(); name=$sessionName;
      providerEnabled=$false; rawArtifactUploadAllowed=$false; cleanupVerified=$false; runtime=$receipt.runtime }
    return @{records=@($emitted.ToArray());exitCode=0}
  }
  if ($Mode -eq 'cleanup') {
    # Cleanup must also work after interrupted DLL compilation. This runs only
    # in the existing owner's teardown budget, never in the five-second census.
    Add-Type -Path ([IO.Path]::Combine($PSScriptRoot,'OwnedFileTrace.cs'))
    if(-not [IO.File]::Exists($receiptFile)) {
      if(-not (Test-TraceAbsent) -or [IO.File]::Exists($raw)){throw 'Missing acquisition custody'}
      Emit @{phase='cleanup';name=$sessionName;guid=$ExpectedGuid.ToString();traceAbsent=$true;
        rawAbsent=$true;cleanupVerified=$true;acquisition=$(if([IO.Directory]::Exists($privateDirectory)){'not-started'}else{'previously-cleaned-or-never-started'});loss=$null}
      return @{records=@($emitted.ToArray());exitCode=0}
    }
    $receipt = Read-Receipt
    $stats = Stop-OwnedTrace
    # Delete only the receipt-bound raw ETL, never a directory or foreign session.
    if ([IO.File]::Exists($raw)) { [IO.File]::Delete($raw) }
    Emit @{ phase='cleanup'; name=$sessionName; guid=$ExpectedGuid.ToString();
      traceAbsent=(Test-TraceAbsent); rawAbsent=(-not [IO.File]::Exists($raw));
      cleanupVerified=$true; loss=$stats }
    return @{records=@($emitted.ToArray());exitCode=0}
  }
  $receipt = Read-Receipt
  Assert-PreparedInput $receipt
  Add-Type -LiteralPath $dll
  . (Join-Path $PSScriptRoot 'FileTraceFacts.ps1')
  $diagnosticAvailable=$true

  $clock = if($ObservationClock){$ObservationClock}else{[Diagnostics.Stopwatch]::StartNew()}
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
  $postStopAdmission=$null; $projectionRefused=$false; $projectionStarted=$false
  $diagnosticFacts = if($diagnosticAvailable){New-FileTraceFacts}else{@{unavailable=$true}}
  $filterCensus = if($diagnosticAvailable){New-FileTraceCensus}else{@{unavailable=$true}}
  try {
    if ($TargetProcessId -eq 0 -or $NativeStartFileTime -notmatch '^[0-9]{15,20}$') { throw 'Exact native process identity required' }
    $startIdentity = [long]::Parse($NativeStartFileTime)
    $root = [IO.Path]::GetFullPath($OwnedPrefix).TrimEnd('\')
    if ($root -notmatch '^[A-Za-z]:\\.+' -or $root.Length -gt 1024 -or $root -match '[*?]') { throw 'Owned non-root local prefix required' }
    $rootDevice = [OwnedFileTrace]::Device($root.Substring(0,2)) + $root.Substring(2)
    $processHandle = [OwnedFileTrace]::HoldProcess($TargetProcessId,$startIdentity)
    $threadLease = [OwnedFileTrace+ThreadLease]::new($TargetProcessId,$startIdentity,$processHandle)
    $schemas = Get-Content -LiteralPath $schemaFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $lookup = @{}
    foreach ($s in $schemas) { $lookup[([string]$s.id + ':' + [string]$s.version)] = $s }
    Write-ExclusiveJson ([IO.Path]::Combine($privateDirectory,'observe-claimed.json')) @{
      pid=$TargetProcessId; nativeStartFileTime=$NativeStartFileTime }
    if(-not $ObserveWork){throw 'Observation work required'}
    if($clock.ElapsedMilliseconds -ge 4500){throw 'BoundReached'}
    $start = [DateTime]::UtcNow
    [OwnedFileTrace]::Enable($sessionName,$ExpectedGuid,[guid]$receipt.provider)
    # Optional fixture owner sends observe after this fixed-size readiness line.
    Emit @{ phase='observing'; pid=$TargetProcessId; nativeStartFileTime=$NativeStartFileTime }
    $null=& $ObserveWork
    $loss = Stop-OwnedTrace
    $stopped = $true
    $end = [DateTime]::UtcNow
    Write-ExclusiveJson ([IO.Path]::Combine($privateDirectory,'stopped.json')) @{ loss=$loss; stoppedAt=$end.ToString('O') }
    if ($null -eq $loss) { $null = $partial.Add('trace-ended-before-stop-loss-unknown') }
    elseif (-not $loss.statisticsKnown) { $null = $partial.Add('stop-statistics-incomplete') }
    elseif ($loss.eventsLost -or $loss.logBuffersLost -or $loss.realTimeBuffersLost) { $null = $partial.Add('etw-loss') }
    $admission=$threadLease.ObserveProjectionAdmission()
    $refusalReason=switch([string]$admission.State){
      'Live' {$null}
      'QueryFailed' {'post-stop-process-query-failed'}
      'IdentityMismatch' {'post-stop-process-identity-mismatch'}
      'Exited' {'post-stop-process-exited'}
      'WaitFailed' {'post-stop-process-wait-failed'}
      default {'post-stop-process-state-unavailable'}
    }
    $postStopAdmission=@{state=[string]$admission.State;admitted=$admission.Admitted;
      nativeError=$admission.NativeError;waitStatus=$admission.WaitStatus;reason=$refusalReason}
    if(-not $admission.Admitted){
      $projectionRefused=$true
      throw [InvalidOperationException]::new('Post-stop projection refused')
    }
    # Per-event lifetime checks remain independent; this only declines starting
    # retrospective projection when the original target is no longer live.
    try { $threadLease.Refresh(); $threadRefresh='completed' } catch { $threadRefresh='unavailable' }
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
    $projectionStarted=$true
    Get-WinEvent -Path $raw -Oldest -MaxEvents 20001 | ForEach-Object {
      $event = $_
      $censusRow=$null; $censusId=0; $censusReason='processing-interrupted'
      try {
        $counts.parsed++
        if ($counts.parsed -gt 20000 -or $clock.ElapsedMilliseconds -ge 4500) { throw 'BoundReached' }
        if ($event.ProviderId -ne [guid]$receipt.provider) { return }
        if($diagnosticAvailable){try {
          $censusId=[int]$event.Id
          $censusRow=Start-FileTraceCensusEvent $filterCensus $event $TargetProcessId
        } catch {$filterCensus.unavailable=$true}}
        $time = $event.TimeCreated.ToUniversalTime()
        if ($time -lt $start -or $time -gt $end) {
          if($null -ne $censusRow){$censusRow.timeWindowMatched=$false}
          $censusReason='outside-capture-window'; return
        }
        if($null -ne $censusRow){$censusRow.timeWindowMatched=$true}
        $processTime=$threadLease.ObserveProcessTime($time.ToFileTimeUtc())
        if($null -ne $censusRow){
          $censusRow.processTime=@{querySucceeded=$processTime.QuerySucceeded;nativeError=$processTime.NativeError;
            creationMatches=$processTime.CreationMatches;eventNotBeforeCreation=$processTime.EventNotBeforeCreation;
            exitTimePresent=$processTime.ExitTimePresent;eventNotAfterExit=$processTime.EventNotAfterExit}
        }
        if (-not $processTime.ContainsTime) {
          if($null -ne $censusRow){$censusRow.processLifetimeMatched=$false}
          $censusReason='outside-original-lifetime'; return
        }
        if($null -ne $censusRow){$censusRow.processLifetimeMatched=$true}
        $s = $lookup[([string]$event.Id + ':' + [string]$event.Version)]
        if (-not $s) { $null = $partial.Add('unknown-event-schema'); $censusReason='unknown-schema'; return }
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
        if($diagnosticAvailable){
          try { Update-FileTraceFacts $diagnosticFacts ([int]$event.Id) $irp $key ([bool]$ntstatus) ($pathFact.scope -eq 'owned') $fields $obj ([int]$event.Version) }
          catch { $diagnosticFacts.unavailable=$true }
        }
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
          $censusReason='name-event'
          $ownedKeys.Remove($key)
          if ($relative) {
            if ($pending.Count + $objects.Count + $ownedKeys.Count + $excludedObjects.Count -ge 1024) { throw 'BoundReached' }
            $ownedKeys[$key] = $relative
          }
          return
        }
        if ($irp -and $ntstatus) {
          $censusReason='completion-event'
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
        if (-not $irp) { $censusReason='missing-or-zero-irp'; return }
        # A changed name cannot keep an earlier object target alive.
        if ($name -and $obj) { $objects.Remove($obj) }
        # Any second begin destroys the former correlation, including foreign IRPs.
        if ($pending.ContainsKey($irp)) {
          if($diagnosticAvailable){try {Mark-FileTracePendingConflict $diagnosticFacts $irp}
            catch {$diagnosticFacts.unavailable=$true}}
          $pending.Remove($irp); $null = $partial.Add('irp-reuse-without-end')
        }
        if (-not $tidText) { $censusReason='missing-issuing-thread'; return }
        $threadId = [uint32]$tidText
        if (-not $threadLease.BelongsAt($threadId,$time.ToFileTimeUtc())) {
          if($null -ne $censusRow){$censusRow.issuingThreadVerified=$false}
          $censusReason='unverified-issuing-thread'
          $counts.unresolvedThreads++; return
        }
        if($null -ne $censusRow){$censusRow.issuingThreadVerified=$true}
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
        if($diagnosticAvailable){try {
          $resolvedScope=if($outside){'outside'}elseif($relative){'owned'}else{'unknown'}
          $requestEvent=$null
          if([int]$event.Id -eq 26 -and [int]$event.Version -eq 1 -and $fields.FilePath -and
              $fields.IssuingThreadId -and $pathFact.scope -eq 'owned' -and $name -ceq $fields.FilePath){
            $informationClass=Get-FileTracePrivateNumber $fields.InfoClass
            if($informationClass -in @(13,64)){
              # This event's admitted identity/path is independent of IRP completion.
              $requestEvent=@{evidenceKind='request-event-only';pathProvenance='explicit-FilePath';
                pid=$TargetProcessId;nativeStartFileTime=$NativeStartFileTime;threadId=$threadId;
                relativeTarget=$pathFact.relative;eventId=26;eventVersion=1;infoClass=$informationClass;
                eventAt=$time.ToString('O');completion='unknown';ntStatus=$null}
            }
          }
          Add-OwnFileTraceFact $diagnosticFacts $s $fields $irp $obj $key $pathFact.scope $resolvedScope `
            ([bool]($obj -and $objects.ContainsKey($obj))) ([bool]($key -and $ownedKeys.ContainsKey($key))) ([bool]$isCreate) ([bool]$isClose) $requestEvent
        } catch { $diagnosticFacts.unavailable=$true }}
        if($outside){$counts.outOfScope++;if(-not $isCreate){$censusReason='outside-owned-path';return}}
        if (-not $relative -and -not $outside) { $counts.unresolvedTargets++; $censusReason='unresolved-target'; return }
        if ($pending.Count + $objects.Count + $ownedKeys.Count + $excludedObjects.Count -ge 1024) { throw 'BoundReached' }
        $pending[$irp] = @{ tid=$threadId; target=$relative; operation=$kind; time=$time;
          isCreate=$isCreate; allowObjectMapping=$true; object=$obj; key=$key; outside=$outside;
          id=[int]$event.Id; version=[int]$event.Version; infoClass=(Field $fields @('InfoClass')) }
        $censusReason='request-retained'
      } finally {
        if($diagnosticAvailable){try {Complete-FileTraceCensusEvent $filterCensus $censusId $censusRow $censusReason}
          catch {$filterCensus.unavailable=$true}}
        $event.Dispose()
      }
    }
  } catch {
    # No event XML, foreign path, or raw exception content crosses the boundary.
    $cause=$_.Exception
    while($cause.InnerException){$cause=$cause.InnerException}
    $identityRefused = $cause -is [InvalidOperationException] -and $cause.Message -eq 'Target creation identity mismatch'
    if($projectionRefused){$null=$partial.Add($refusalReason)}
    else {$null = $partial.Add('capture-or-projection-incomplete')}
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
  $result.postStopAdmission=$postStopAdmission
  $result.projectionStarted=$projectionStarted
  $result.captureInterval=@{startedAt=$(if($start){$start.ToString('O')}else{$null});
    endedAt=$(if($end){$end.ToString('O')}else{$null})}
  $encoded = $result | ConvertTo-Json -Depth 12 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 256KB) {
    $result.records=@(); $result.observation='insufficient-evidence'; $result.partial=@('projection-byte-cap')
  }
  try { Emit (Get-FileTraceFacts $diagnosticFacts) }
  catch { Emit @{phase='owned-begin-facts';diagnosticOnly=$true;unavailable=$true;events=@()} }
  try { Emit (Get-FileTraceCensus $filterCensus) }
  catch { Emit @{phase='filter-census';diagnosticOnly=$true;unavailable=$true;events=@()} }
  Emit $result
  return @{records=@($emitted.ToArray());exitCode=$(if($stopped){0}else{2})}
} catch {
  if($Mode -eq 'prepare'){
    $failure=$_.Exception
    $diagnostic=@{phase='prepare-failure';diagnosticOnly=$true;errorCategory='other';truncated=$false}
    for($depth=0;$depth -lt 8 -and $null -ne $failure;$depth++){
      if($failure -is [ComponentModel.Win32Exception]){
        $diagnostic.errorCategory='win32'
        $diagnostic.nativeErrorCode=$failure.NativeErrorCode
      } elseif($diagnostic.errorCategory -ne 'win32'){
        if($failure -is [UnauthorizedAccessException]){$diagnostic.errorCategory='unauthorized-access'}
        elseif($failure -is [IO.IOException]){$diagnostic.errorCategory='io'}
        elseif($failure -is [InvalidOperationException]){$diagnostic.errorCategory='invalid-operation'}
      }
      $failure=$failure.InnerException
    }
    $diagnostic.truncated=$null -ne $failure
    Emit $diagnostic
  }
  Emit @{ phase=$Mode; observation='insufficient-evidence'; cleanupVerified=$false;
    reason='native-probe-failed-or-ownership-refused'; rawArtifactUploadAllowed=$false }
  return @{records=@($emitted.ToArray());exitCode=2}
}

}
