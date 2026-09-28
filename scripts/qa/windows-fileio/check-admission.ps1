# Executes the actual stopped-observer continuation, including catch/finally and
# result emission. Native acquisition is already complete at this boundary.
param([string]$SourcePath=(Join-Path $PSScriptRoot 'OwnedFileTraceOperations.ps1'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'FileTraceFacts.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedFileTrace.cs')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $SourcePath),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed'}
$inner=$ast.Find({param($n) $n -is [Management.Automation.Language.TryStatementAst] -and
  @($n.CatchClauses | Where-Object {$_.Extent.Text.Contains('capture-or-projection-incomplete')}).Count -gt 0},$true)
$outer=$ast.Find({param($n) $n -is [Management.Automation.Language.TryStatementAst] -and
  @($n.Body.Statements | Where-Object {$_.Extent.StartOffset -eq $inner.Extent.StartOffset}).Count -gt 0},$true)
$entry=@($inner.Body.Statements | Where-Object {
  $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$admission'
}) | Select-Object -First 1
if(-not $entry){
  # The original source began directly with Refresh; retaining this boundary
  # allows the causal RED to execute its old enumeration, not fail a source grep.
  $entry=@($inner.Body.Statements | Where-Object {
    $_ -is [Management.Automation.Language.TryStatementAst] -and $_.Body.Extent.Text.Contains('$threadLease.Refresh()')
  }) | Select-Object -First 1
}
if(-not $entry -or -not $outer){throw 'Stopped-observer boundary not found'}
$source=[IO.File]::ReadAllText((Resolve-Path $SourcePath))
$continuation=$source.Substring($entry.Extent.StartOffset,$inner.Body.Extent.EndOffset-1-$entry.Extent.StartOffset)
$tail=($outer.Body.Statements | Where-Object {$_.Extent.StartOffset -gt $inner.Extent.EndOffset} | ForEach-Object {$_.Extent.Text}) -join "`n"
$boundary=[scriptblock]::Create("try {`n"+$continuation+"`n}`n"+($inner.CatchClauses.Extent.Text -join "`n")+"`nfinally "+$inner.Finally.Extent.Text+"`n"+$tail)
$emit=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Emit'},$true)
Invoke-Expression $emit.Extent.Text
function Write-ExclusiveJson($File,$Value) { $script:receiptWrites++ }
function Get-WinEvent {param($Path,[switch]$Oldest,[int]$MaxEvents)
  $script:enumerations++
  return $script:fixtureEvents
}
function Event([int]$Id,[hashtable]$Fields,[int]$Tick) {
  $data=($Fields.GetEnumerator() | ForEach-Object {
    '<Data Name="'+$_.Key+'">'+[Security.SecurityElement]::Escape([string]$_.Value)+'</Data>'
  }) -join ''
  $event=[pscustomobject]@{Id=$Id;Version=0;ProviderId=[guid]$receipt.provider;ProcessId=$TargetProcessId;
    TimeCreated=$start.AddMilliseconds($Tick);Xml='<Event><EventData>'+$data+'</EventData></Event>'}
  $event | Add-Member ScriptMethod ToXml {return $this.Xml}
  $event | Add-Member ScriptMethod Dispose {$script:disposedEvents++}
  return $event
}
foreach($state in @('Exited','QueryFailed','IdentityMismatch','WaitFailed','WaitUnexpected','Live')) {
  $script:admissionFact=[OwnedFileTrace+ProcessAdmissionObservation]::new()
  $script:admissionFact.State=[OwnedFileTrace+ProcessAdmissionState]::$state
  $script:admissionFact.WaitStatus=switch($state){'Exited'{0};'Live'{258};'WaitFailed'{[uint32]::MaxValue};'WaitUnexpected'{128};default{$null}}
  $script:admissionFact.NativeError=if($state -in @('QueryFailed','WaitFailed')){6}else{$null}
  $script:admissionCalls=0;$script:refreshes=0;$script:enumerations=0;$script:disposals=0;$script:disposedEvents=0;$script:receiptWrites=0
  $threadLease=[pscustomobject]@{}
  $threadLease | Add-Member ScriptMethod ObserveProjectionAdmission {$script:admissionCalls++;return $script:admissionFact}
  $threadLease | Add-Member ScriptMethod Refresh {
    $script:refreshes++
    if(-not $script:admissionFact.Admitted){throw 'Target not live for refresh'}
  }
  $threadLease | Add-Member ScriptMethod ObserveProcessTime {param($time)
    $query=$script:admissionFact.State -ne [OwnedFileTrace+ProcessAdmissionState]::QueryFailed
    $identity=$script:admissionFact.State -ne [OwnedFileTrace+ProcessAdmissionState]::IdentityMismatch
    return [pscustomobject]@{QuerySucceeded=$query;CreationMatches=$identity;NativeError=$null;
      EventNotBeforeCreation=$true;ExitTimePresent=$true;EventNotAfterExit=$true;ContainsTime=($query -and $identity)}
  }
  $threadLease | Add-Member ScriptMethod BelongsAt {param($tid,$time) return $tid -eq 22}
  $threadLease | Add-Member ScriptMethod Dispose {$script:disposals++}
  $TargetProcessId=1234;$NativeStartFileTime='133000000000000000'
  $root='C:\owned';$rootDevice='\Device\HarddiskVolume3\owned'
  $receipt=@{provider='edd08927-9cc4-4e65-b970-c2560fb5c289'}
  $start=[DateTime]::UtcNow;$end=$start.AddSeconds(1);$clock=[Diagnostics.Stopwatch]::StartNew()
  $raw=$PSCommandPath;$privateDirectory=$PSScriptRoot
  $stopped=$true;$processHandle=[IntPtr]::Zero;$identityRefused=$false
  $postStopAdmission=$null;$projectionRefused=$false;$projectionStarted=$false
  $threadRefresh='not-attempted';$diagnosticAvailable=$true
  $loss=@{statisticsKnown=$true;eventsLost=0;logBuffersLost=0;realTimeBuffersLost=0}
  $partial=[Collections.Generic.HashSet[string]]::new();$rows=[Collections.Generic.List[object]]::new()
  $pending=@{};$objects=@{};$ownedKeys=@{};$excludedObjects=[Collections.Generic.HashSet[string]]::new()
  $counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
  $diagnosticFacts=New-FileTraceFacts;$filterCensus=New-FileTraceCensus
  $lookup=@{'12:0'=@{id=12;version=0;task='Create';opcode='Info'};'24:0'=@{id=24;version=0;task='OperationEnd';opcode='Info'}}
  $script:fixtureEvents=@((Event 12 @{Irp='0x1';FileObject='0x9';IssuingThreadId='22';FileName='C:\owned\fixture.node';CreateOptions='0'} 10),
    (Event 24 @{Irp='0x1';Status='0'} 20))
  $emitted=[Collections.Generic.List[object]]::new();$PublishFact=$null
  $output=& $boundary
  $result=@($output.records | Where-Object {$_.phase -eq 'result'})
  if($result.Count -ne 1 -or $script:disposals -ne 1 -or -not $result[0].cleanupVerified){throw 'Entry refusal skipped cleanup or result emission'}
  if($state -eq 'Live') {
    if($script:refreshes -ne 1 -or $script:enumerations -ne 1 -or $script:disposedEvents -ne 2 -or $result[0].records.Count -ne 1){throw 'Live target lost normal enumeration'}
    if(-not $result[0].projectionStarted -or -not $result[0].postStopAdmission.admitted){throw 'Live admission missing'}
  } else {
    if($script:refreshes -ne 0 -or $script:enumerations -ne 0 -or $result[0].counts.parsed -ne 0){throw "Refused target started refresh/enumeration: $state"}
    if($result[0].records.Count -ne 0 -or $result[0].observation -ne 'insufficient-evidence' -or $result[0].projectionStarted){throw 'Refusal claimed projection'}
    $reason=switch($state){'Exited'{'post-stop-process-exited'};'QueryFailed'{'post-stop-process-query-failed'};'IdentityMismatch'{'post-stop-process-identity-mismatch'};'WaitFailed'{'post-stop-process-wait-failed'};default{'post-stop-process-state-unavailable'}}
    if($result[0].postStopAdmission.reason -ne $reason -or $reason -notin $result[0].partial){throw 'Wrong fixed refusal category'}
  }
  if($script:admissionCalls -ne 1){throw 'Admission observation was not singular'}
  @{scenario=$state;passed=$true;refreshCalls=$script:refreshes;enumerationCalls=$script:enumerations;disposed=$script:disposals;nativeProof=$false} | ConvertTo-Json -Compress
}
