# Synthetic parser-boundary checks only; no native API or Windows proof.
param([string]$SourcePath = (Join-Path $PSScriptRoot 'OwnedFileTraceOperations.ps1'),
  [string]$FactsPath = (Join-Path $PSScriptRoot 'FileTraceFacts.ps1'))
$ErrorActionPreference = 'Stop'
. $FactsPath
$diagnosticAvailable=$true
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(
  $SourcePath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Parse failure' }
foreach ($name in @('Field','Pointer','Resolve-OwnedPath')) {
  $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  Invoke-Expression $definition.Extent.Text
}
$pipeline=$ast.Find({param($node)
  $node -is [Management.Automation.Language.PipelineAst] -and $node.Extent.Text.StartsWith('Get-WinEvent -Path $raw')
},$true)
$processor=$pipeline.PipelineElements[1].CommandElements[1].ScriptBlock.GetScriptBlock()
$TargetProcessId=1234; $NativeStartFileTime='133000000000000000'; $startIdentity=[long]$NativeStartFileTime
$root='C:\owned'; $rootDevice='\Device\HarddiskVolume3\owned'
$receipt=@{provider='edd08927-9cc4-4e65-b970-c2560fb5c289'}
$lookup=@{
  '1:0'=@{task='FileIO';opcode='Create'}; '2:0'=@{task='FileIO';opcode='OperationEnd'}
  '3:0'=@{task='FileIO';opcode='SetInfo'}; '4:0'=@{task='FileIO';opcode='Close'}
  '5:0'=@{task='NameCreate';opcode='Info'}; '6:0'=@{task='NameDelete';opcode='Info'}
}
$threadLease=[pscustomobject]@{}
$threadLease | Add-Member ScriptMethod BelongsAt {param($tid,$time) return $tid -eq 22}
$threadLease | Add-Member ScriptMethod ObserveProcessTime {param($time)
  $script:queryCount++
  if($script:queryFailure){return [pscustomobject]@{QuerySucceeded=$false;NativeError=6;
    CreationMatches=$null;EventNotBeforeCreation=$null;ExitTimePresent=$null;EventNotAfterExit=$null;ContainsTime=$false}}
  return [pscustomobject]@{QuerySucceeded=$true;NativeError=$null;CreationMatches=$true;
    EventNotBeforeCreation=$true;ExitTimePresent=$true;EventNotAfterExit=($time -le $script:lifetimeEnd);
    ContainsTime=($time -le $script:lifetimeEnd)}
}
function Event([int]$Id,[hashtable]$Fields,[int]$Tick,[int]$Version=0) {
  $data=($Fields.GetEnumerator() | ForEach-Object {
    '<Data Name="'+[Security.SecurityElement]::Escape($_.Key)+'">'+[Security.SecurityElement]::Escape([string]$_.Value)+'</Data>'
  }) -join ''
  $event=[pscustomobject]@{Id=$Id;Version=$Version;ProviderId=[guid]$receipt.provider;
    TimeCreated=$start.AddMilliseconds($Tick); Xml='<Event><EventData>'+$data+'</EventData></Event>'}
  $event | Add-Member ScriptMethod ToXml {return $this.Xml}
  $event | Add-Member ScriptMethod Dispose {}
  return $event
}
foreach ($scenario in @('success','failed-create','unnamed-create','late-old-create','foreign-explicit-name','after-process-exit','foreign-thread','filekey-name','filekey-deleted','close-target','outside-object')) {
  $start=[DateTime]::UtcNow; $end=$start.AddSeconds(1); $clock=[Diagnostics.Stopwatch]::StartNew()
  $script:lifetimeEnd=if($scenario -eq 'after-process-exit') {$start.AddMilliseconds(4).ToFileTimeUtc()} else {[long]::MaxValue}
  $rows=[Collections.Generic.List[object]]::new(); $partial=[Collections.Generic.HashSet[string]]::new()
  $pending=@{}; $objects=@{}; $ownedKeys=@{}
  $diagnosticFacts=New-FileTraceFacts
  $filterCensus=New-FileTraceCensus
  $excludedObjects=[Collections.Generic.HashSet[string]]::new()
  $counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
  $events=[Collections.Generic.List[object]]::new()
  $events.Add((Event 1 @{Irp='0x1';FileObject='0x9';TTID='22';OpenPath='C:\owned\old.node';CreateOptions='0'} 1))
  if ($scenario -eq 'late-old-create') {
    $events.Add((Event 1 @{Irp='0x8';FileObject='0x9';TTID='22';CreateOptions='0'} 2))
  }
  $failureCode=if($scenario -eq 'failed-create') {'0xC0000022'} else {'0'}
  $events.Add((Event 2 @{Irp='0x1';Status=$failureCode} 3))
  if ($scenario -eq 'unnamed-create') {
    $events.Add((Event 1 @{Irp='0x8';FileObject='0x9';TTID='22';CreateOptions='0'} 4))
  }
  $info=@{Irp='0x2';FileObject='0x9';TTID='22';InfoClass='13'}
  if($scenario -in @('filekey-name','filekey-deleted')) {
    $events.Add((Event 5 @{FileKey='0x7';FileName='C:\owned\old.node'} 4))
    $info=@{Irp='0x2';FileKey='0x7';IssuingThreadId='22';InfoClass='13'}
    if($scenario -eq 'filekey-deleted') {$events.Add((Event 6 @{FileKey='0x7';FileName='C:\owned\old.node'} 4))}
  }
  if($scenario -eq 'foreign-explicit-name') {$info.FileName='C:\elsewhere\unrelated.node'}
  if($scenario -eq 'foreign-thread') {$info.TTID='33'}
  if($scenario -eq 'outside-object') {
    $events.Add((Event 1 @{Irp='0x8';FileObject='0xA';IssuingThreadId='22';FileName='C:\source\koffi.node';CreateOptions='0'} 4))
    $events.Add((Event 2 @{Irp='0x8';Status='0'} 4))
    $info.FileObject='0xA'
  }
  $wantedId=if($scenario -eq 'close-target'){4}else{3}
  $events.Add((Event $wantedId $info 5))
  $events.Add((Event 2 @{Irp='0x2';Status='0xC0000022'} 6))
  $events | ForEach-Object $processor
  $setInfo=@($rows | Where-Object {$_.eventId -eq $wantedId})
  if ($scenario -in @('success','filekey-name','close-target')) {
    if($setInfo.Count -ne 1 -or $setInfo[0].relativeTarget -ne 'old.node' -or $setInfo[0].ntStatus -ne '0xC0000022') {throw 'Valid attribution lost'}
  } elseif($setInfo.Count -ne 0) {throw "False target attribution: $scenario"}
  if($scenario -in @('foreign-explicit-name','outside-object') -and $counts.unresolvedTargets -ne 0){throw 'Known outside path treated as unresolved'}
  if($scenario -eq 'foreign-thread' -and $diagnosticFacts.entries.Count -ne 1){throw 'Foreign thread entered diagnostic facts'}
  [pscustomobject]@{scenario=$scenario;passed=$true;setInfoRecords=$setInfo.Count} | ConvertTo-Json -Compress
}

# Actual relevant IDs exercise the census at the original parser's early exits.
$lookup['12:0']=@{id=12;version=0;task='Create';opcode='Info'}
$lookup['15:0']=@{id=15;version=0;task='Read';opcode='Info'}
$lookup['24:0']=@{id=24;version=0;task='OperationEnd';opcode='Info'}
foreach($case in @(
  @{name='query-failure';reason='outside-original-lifetime';tick=1;id=12;fields=@{Irp='0xC0FFEE';IssuingThreadId='22'}}
  @{name='capture-window';reason='outside-capture-window';tick=-1;id=12;fields=@{Irp='0xC0FFEE';IssuingThreadId='22';FileName='C:\foreign\PRIVATE_CANARY'}}
  @{name='original-lifetime';reason='outside-original-lifetime';tick=2;id=12;fields=@{Irp='0xC0FFEE';IssuingThreadId='22'}}
  @{name='zero-irp';reason='missing-or-zero-irp';tick=1;id=12;fields=@{Irp='0x0';IssuingThreadId='22'}}
  @{name='missing-thread';reason='missing-issuing-thread';tick=1;id=12;fields=@{Irp='0xC0FFEE'}}
  @{name='unverified-thread';reason='unverified-issuing-thread';tick=1;id=12;fields=@{Irp='0xC0FFEE';IssuingThreadId='33'}}
  @{name='unresolved-read';reason='unresolved-target';tick=1;id=15;fields=@{Irp='0xC0FFEE';IssuingThreadId='22';FileKey='0xDEADBEEF'}}
)) {
  $start=[DateTime]::UtcNow;$end=$start.AddSeconds(1);$clock=[Diagnostics.Stopwatch]::StartNew()
  $script:queryFailure=$case.name -eq 'query-failure';$script:queryCount=0
  $script:lifetimeEnd=if($case.name -eq 'original-lifetime'){$start.AddMilliseconds(1).ToFileTimeUtc()}else{[long]::MaxValue}
  $rows=[Collections.Generic.List[object]]::new();$partial=[Collections.Generic.HashSet[string]]::new()
  $pending=@{};$objects=@{};$ownedKeys=@{};$excludedObjects=[Collections.Generic.HashSet[string]]::new()
  $counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
  $diagnosticFacts=New-FileTraceFacts;$filterCensus=New-FileTraceCensus
  $event=Event $case.id $case.fields $case.tick
  $event | Add-Member NoteProperty ProcessId $TargetProcessId
  @($event) | ForEach-Object $processor
  $fact=Get-FileTraceCensus $filterCensus
  if($fact.events.Count -ne 1 -or $fact.events[0].filterReason -ne $case.reason){throw "Census missed exclusion: $($case.name)"}
  if($fact.filterReasonCounts[$case.reason] -ne 1 -or $fact.relevantEventCounts[[string]$case.id] -ne 1){throw 'Census counts missed early event'}
  if($rows.Count -ne 0 -or $pending.Count -ne 0){throw 'Header census granted attribution'}
  if($case.name -eq 'capture-window' -and ($fact.events[0].timeWindowMatched -ne $false -or $null -ne $fact.events[0].processLifetimeMatched)){throw 'Skipped lifetime test claimed a result'}
  if($case.name -eq 'original-lifetime' -and $fact.events[0].processLifetimeMatched -ne $false){throw 'Header PID confused with process lifetime'}
  if($case.name -eq 'unverified-thread' -and $fact.events[0].issuingThreadVerified -ne $false){throw 'Header PID confused with issuing thread'}
  if($script:queryCount -ne $(if($case.name -eq 'capture-window'){0}else{1})){throw 'Diagnostic repeated native lifetime query'}
  if($case.name -eq 'query-failure' -and ($fact.events[0].processTime.querySucceeded -ne $false -or $fact.events[0].processTime.nativeError -ne 6 -or $null -ne $fact.events[0].processTime.creationMatches)){throw 'Query failure facts became interval evidence'}
  if($case.name -eq 'zero-irp' -and $fact.events[0].irpValueNonzero -ne $false){throw 'Zero IRP reported nonzero'}
  $encoded=$fact | ConvertTo-Json -Depth 8 -Compress
  foreach($canary in @('PRIVATE_CANARY','C0FFEE','DEADBEEF')){if($encoded.Contains($canary)){throw 'Private event value leaked'}}
  [pscustomobject]@{scenario=$case.name;passed=$true;diagnosticOnly=$true} | ConvertTo-Json -Compress
}

# Explicit owned paths select diagnostics only after the original parsing guards.
$lookup['26:1']=@{id=26;version=1;task='DeletePath';opcode='Info'}
foreach($scenario in @('owned-unverified','owned-zero-irp','owned-missing-thread','owned-header',
  'foreign-path','prefix-sibling','unnamed','before-capture','query-failure','unknown-schema')) {
  $start=[DateTime]::UtcNow;$end=$start.AddSeconds(1);$clock=[Diagnostics.Stopwatch]::StartNew()
  $script:queryFailure=$scenario -eq 'query-failure';$script:queryCount=0;$script:lifetimeEnd=[long]::MaxValue
  $rows=[Collections.Generic.List[object]]::new();$partial=[Collections.Generic.HashSet[string]]::new()
  $pending=@{};$objects=@{};$ownedKeys=@{};$excludedObjects=[Collections.Generic.HashSet[string]]::new()
  $counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
  $diagnosticFacts=New-FileTraceFacts;$filterCensus=New-FileTraceCensus
  $fields=@{Irp='0xC0FFEE';IssuingThreadId='987654321';FilePath='C:\owned\PRIVATE_CANARY';InfoClass='64'}
  $tick=1;$version=1
  switch($scenario){
    'owned-zero-irp' {$fields.Irp='0'}
    'owned-missing-thread' {$fields.Remove('IssuingThreadId')}
    'foreign-path' {$fields.FilePath='C:\foreign\PRIVATE_CANARY'}
    'prefix-sibling' {$fields.FilePath='C:\owned-sibling\PRIVATE_CANARY'}
    'unnamed' {$fields.Remove('FilePath');$ownedKeys['0xBEEF']='PRIVATE_CANARY';$fields.FileKey='0xBEEF'}
    'before-capture' {$tick=-1}
    'unknown-schema' {$version=99}
  }
  $event=Event 26 $fields $tick $version
  $event | Add-Member NoteProperty ProcessId $(if($scenario -eq 'owned-header'){$TargetProcessId}else{0})
  $event | Add-Member NoteProperty XmlReads 0
  $event | Add-Member ScriptMethod ToXml {$this.XmlReads++;return $this.Xml} -Force
  @($event) | ForEach-Object $processor
  $fact=Get-FileTraceCensus $filterCensus
  $selected=$scenario.StartsWith('owned-')
  if($fact.events.Count -ne [int]$selected){throw "Explicit-path diagnostic selection lost: $scenario"}
  if($selected){
    $row=$fact.events[0];$header=$scenario -eq 'owned-header'
    if($row.headerPidMatched -ne $header -or $row.selectionReason -ne $(if($header){'header-pid'}else{'owned-path'})){throw 'Selector provenance changed'}
    if(-not $row.timeWindowMatched -or -not $row.processLifetimeMatched -or -not $row.processTime.querySucceeded -or -not $row.fieldPresence.FilePath){throw 'Existing interval/field observations lost'}
    $expectedReason=switch($scenario){'owned-zero-irp'{'missing-or-zero-irp'};'owned-missing-thread'{'missing-issuing-thread'};default{'unverified-issuing-thread'}}
    if($row.filterReason -ne $expectedReason){throw 'Path selector bypassed original refusal'}
  }
  if($rows.Count -ne 0 -or $pending.Count -ne 0 -or $diagnosticFacts.entries.Count -ne 0){throw 'Diagnostic path granted request or completion authority'}
  if($fact.relevantEventCounts['26'] -ne 1 -or $fact.headerPidMatchCounts['26'] -ne [int]($scenario -eq 'owned-header')){throw 'Late selection changed early counts'}
  $expectedReads=if($scenario -eq 'owned-header'){2}elseif($scenario -in @('before-capture','query-failure','unknown-schema')){0}else{1}
  if($event.XmlReads -ne $expectedReads -or $script:queryCount -ne [int]($scenario -ne 'before-capture')){throw 'Selector reparsed payload or repeated native query'}
  $encoded=$fact | ConvertTo-Json -Depth 8 -Compress
  foreach($canary in @('PRIVATE_CANARY','C0FFEE','BEEF','987654321')){if($encoded.Contains($canary)){throw 'Path selector leaked native value'}}
  @{scenario=('path-selector-'+$scenario);passed=$true;diagnosticOnly=$true} | ConvertTo-Json -Compress
}
$script:queryFailure=$false

# Earlier nonpriority traffic must not consume deletion facts; the parser still
# invalidates the same pending IRP and suppresses its result exactly as before.
$lookup['18:0']=@{id=18;version=0;task='SetDelete';opcode='Info'}
$lookup['26:0']=@{id=26;version=0;task='DeletePath';opcode='Info'}
$start=[DateTime]::UtcNow;$end=$start.AddSeconds(1);$clock=[Diagnostics.Stopwatch]::StartNew()
$script:lifetimeEnd=[long]::MaxValue;$script:queryFailure=$false
$rows=[Collections.Generic.List[object]]::new();$partial=[Collections.Generic.HashSet[string]]::new()
$pending=@{};$objects=@{};$ownedKeys=@{};$excludedObjects=[Collections.Generic.HashSet[string]]::new()
$counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
$diagnosticFacts=New-FileTraceFacts;$filterCensus=New-FileTraceCensus
$events=[Collections.Generic.List[object]]::new()
for($n=1;$n -le 20;$n++){
  $token=('0x{0:X}' -f $n)
  $events.Add((Event 12 @{Irp=$token;FileObject=$token;IssuingThreadId='22';FileName='C:\outside\PRIORITY_PATH_CANARY';CreateOptions='0'} ($n*2)))
  $events.Add((Event 24 @{Irp=$token;Status='0'} ($n*2+1)))
}
$events.Add((Event 12 @{Irp='0x21';FileObject='0xBEEF1234';IssuingThreadId='22';FileName='C:\owned\old.node';CreateOptions='0'} 50))
$events.Add((Event 24 @{Irp='0x21';Status='0'} 51))
$events.Add((Event 18 @{Irp='0xCAB01234';FileObject='0xBEEF1234';FileKey='0xFEED5678';IssuingThreadId='22';InfoClass='64'} 52))
$events.Add((Event 26 @{Irp='0xCAB01234';FileObject='0xBEEF1234';FileKey='0xFEED5678';IssuingThreadId='22';InfoClass='0x40';FilePath='C:\owned\old.node'} 53))
$events.Add((Event 24 @{Irp='0xCAB01234';Status='0'} 54))
foreach($event in $events){$event | Add-Member NoteProperty ProcessId $TargetProcessId}
$events | ForEach-Object $processor
$own=Get-FileTraceFacts $diagnosticFacts;$census=Get-FileTraceCensus $filterCensus
$priority=@($own.events | Where-Object {$_.schema.eventId -in @(18,26)})
if($priority.Count -ne 2 -or @($census.events | Where-Object {$_.eventId -in @(18,26)}).Count -ne 2){throw 'Earlier traffic starved deletion facts'}
$relation=$priority[0].nextSameIrpBegin
if($relation.eventId -ne 26 -or -not $relation.parserPendingConflict -or -not $relation.nextBeginOwnAdmission){throw 'Exact conflict event was not retained'}
if(-not $relation.sameObject -or -not $relation.sameKey -or -not $relation.sameIssuingThread -or -not $relation.sameInfoClass){throw 'Private equalities were not preserved'}
if(-not $partial.Contains('irp-reuse-without-end') -or @($rows | Where-Object {$_.eventId -in @(18,26)}).Count -ne 0){throw 'Capture facts altered conservative parser outcome'}
if(-not $own.nonPriorityTruncated -or -not $census.nonPriorityTruncated -or $own.priorityTruncated -or $census.priorityTruncated){throw 'Selection loss was not explicit'}
$encoded=@($own,$census) | ConvertTo-Json -Depth 10 -Compress
foreach($canary in @('PRIORITY_PATH_CANARY','CAB01234','BEEF1234','FEED5678','0x40')){if($encoded.Contains($canary)){throw 'Private conflict value leaked'}}
@{scenario='priority-after-overflow-keeps-conflict-without-authority';passed=$true;diagnosticOnly=$true} | ConvertTo-Json -Compress

# A header mismatch changes only the fixed-ID census, never creates a detail row.
$filterCensus=New-FileTraceCensus
$foreign=Event 12 @{Irp='0xDEADBEEF';FileName='C:\foreign\PRIVATE_CANARY'} 1
$foreign | Add-Member NoteProperty ProcessId 9999
Start-FileTraceCensusEvent $filterCensus $foreign $TargetProcessId | Out-Null
Complete-FileTraceCensusEvent $filterCensus 12 $null 'processing-interrupted'
$fact=Get-FileTraceCensus $filterCensus
if($fact.events.Count -ne 0 -or $fact.relevantEventCounts['12'] -ne 1 -or $fact.headerPidMatchCounts['12'] -ne 0){throw 'Foreign header entered detail projection'}
# Unknown IDs must not allocate new count keys, even on a matching header.
$unknown=Event 9999 @{} 1
$unknown | Add-Member NoteProperty ProcessId $TargetProcessId
for($n=0;$n -lt 100;$n++){
  Start-FileTraceCensusEvent $filterCensus $unknown $TargetProcessId | Out-Null
  $own=Event 12 @{Irp='0xC0FFEE';FileName='C:\foreign\PRIVATE_CANARY'} 1
  $own | Add-Member NoteProperty ProcessId $TargetProcessId
  $row=Start-FileTraceCensusEvent $filterCensus $own $TargetProcessId
  Complete-FileTraceCensusEvent $filterCensus 12 $row 'processing-interrupted'
}
for($n=0;$n -lt 100;$n++){
  $deletion=Event 18 @{Irp='0xC0FFEE';FileName='C:\foreign\PRIVATE_CANARY'} 1
  $deletion | Add-Member NoteProperty ProcessId $TargetProcessId
  $row=Start-FileTraceCensusEvent $filterCensus $deletion $TargetProcessId
  Complete-FileTraceCensusEvent $filterCensus 18 $row 'processing-interrupted'
}
$fact=Get-FileTraceCensus $filterCensus
if(-not $fact.priorityTruncated -or -not $fact.nonPriorityTruncated){throw 'Census quota truncation hidden'}
if($fact.events.Count -ne 32 -or -not $fact.truncated){throw 'Census row cap failed'}
if($fact.relevantEventCounts.Count+$fact.headerPidMatchCounts.Count+$fact.filterReasonCounts.Count -ne 32){throw 'Census count keys grew'}
if([Text.Encoding]::UTF8.GetByteCount(($fact | ConvertTo-Json -Depth 8 -Compress)) -gt 32768){throw 'Census byte cap failed'}
@{scenario='header-selector-and-census-bounds';passed=$true;diagnosticOnly=$true} | ConvertTo-Json -Compress

# Header and path selections share each quota; neither can refill the other's overflow.
$start=[DateTime]::UtcNow;$end=$start.AddSeconds(1);$clock=[Diagnostics.Stopwatch]::StartNew()
$script:queryFailure=$false;$script:queryCount=0;$script:lifetimeEnd=[long]::MaxValue
$rows=[Collections.Generic.List[object]]::new();$partial=[Collections.Generic.HashSet[string]]::new()
$pending=@{};$objects=@{};$ownedKeys=@{};$excludedObjects=[Collections.Generic.HashSet[string]]::new()
$counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
$diagnosticFacts=New-FileTraceFacts;$filterCensus=New-FileTraceCensus
foreach($id in @(12,26)){
  for($n=0;$n -lt 20;$n++){
    $event=Event $id @{Irp='0xC0FFEE';IssuingThreadId='987654321';FilePath='C:\owned\PRIVATE_CANARY'} 1 $(if($id -eq 26){1}else{0})
    $event | Add-Member NoteProperty ProcessId $(if($n%2){0}else{$TargetProcessId})
    @($event) | ForEach-Object $processor
  }
}
$fact=Get-FileTraceCensus $filterCensus
if($fact.events.Count -ne 32 -or -not $fact.priorityTruncated -or -not $fact.nonPriorityTruncated -or -not $fact.truncated){throw 'Selectors did not share capped quotas'}
foreach($id in @(12,26)){
  $selected=@($fact.events | Where-Object {$_.eventId -eq $id})
  if($selected.Count -ne 16 -or @($selected | Where-Object {$_.selectionReason -eq 'owned-path'}).Count -ne 8 -or
    $fact.relevantEventCounts[[string]$id] -ne 20 -or $fact.headerPidMatchCounts[[string]$id] -ne 10){throw 'Mixed selector overflow changed counters or admitted duplicates'}
}
if($script:queryCount -ne 40 -or $rows.Count -ne 0 -or $pending.Count -ne 0 -or $diagnosticFacts.entries.Count -ne 0){throw 'Mixed selection changed native calls or attribution'}
if($fact.relevantEventCounts.Count+$fact.headerPidMatchCounts.Count+$fact.filterReasonCounts.Count -ne 32 -or
  [Text.Encoding]::UTF8.GetByteCount(($fact | ConvertTo-Json -Depth 8 -Compress)) -gt 32768){throw 'Mixed selection expanded diagnostic bounds'}
@{scenario='mixed-selectors-share-quotas-without-authority';passed=$true;diagnosticOnly=$true} | ConvertTo-Json -Compress

# Request evidence comes from the actual admitted event, never maps or relation facts.
$lookup['18:1']=@{id=18;version=1;task='SetDelete';opcode='Info'}
$lookup['26:1']=@{id=26;version=1;task='DeletePath';opcode='Info'}
foreach($scenario in @('exact','class13','hex-class','repeated','foreign-path','missing-path','alias-path',
  'conflicting-name','wrong-class','missing-class','wrong-version','foreign-provider','unknown-schema',
  'zero-irp','missing-thread','foreign-thread','process-query-failure','after-process-exit','before-capture',
  'after-capture','priority-overflow','byte-overflow','diagnostics-disabled')) {
  $start=[DateTime]::UtcNow;$end=$start.AddSeconds(1);$clock=[Diagnostics.Stopwatch]::StartNew()
  $script:queryFailure=$scenario -eq 'process-query-failure';$script:queryCount=0
  $script:lifetimeEnd=if($scenario -eq 'after-process-exit'){$start.AddMilliseconds(3).ToFileTimeUtc()}else{[long]::MaxValue}
  $rows=[Collections.Generic.List[object]]::new();$partial=[Collections.Generic.HashSet[string]]::new()
  $pending=@{};$objects=@{};$ownedKeys=@{};$excludedObjects=[Collections.Generic.HashSet[string]]::new()
  $counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
  $diagnosticFacts=New-FileTraceFacts;$filterCensus=New-FileTraceCensus
  $diagnosticAvailable=$scenario -ne 'diagnostics-disabled'
  $events=[Collections.Generic.List[object]]::new()
  $events.Add((Event 12 @{Irp='0x1';FileObject='0xBEEF1234';IssuingThreadId='22';FileName='C:\owned\old.node';CreateOptions='0'} 1))
  $events.Add((Event 24 @{Irp='0x1';Status='0'} 2))
  $begin=@{Irp='0xCAB01234';FileObject='0xBEEF1234';FileKey='0xFEED5678';IssuingThreadId='22';InfoClass='64'}
  $events.Add((Event 18 $begin 3 1))
  $fields=$begin.Clone();$fields.FilePath='C:\owned\old.node';$tick=4;$version=1
  switch($scenario){
    'class13' {$fields.InfoClass='13'}
    'hex-class' {$fields.InfoClass='0x40'}
    'foreign-path' {$fields.FilePath='C:\foreign\PRIVATE_CANARY'}
    'missing-path' {$fields.Remove('FilePath')}
    'alias-path' {$fields.Remove('FilePath');$fields.FileName='C:\owned\old.node'}
    'conflicting-name' {$fields.FileName='C:\owned\different.node'}
    'wrong-class' {$fields.InfoClass='4'}
    'missing-class' {$fields.Remove('InfoClass')}
    'wrong-version' {$version=0}
    'unknown-schema' {$version=99}
    'zero-irp' {$fields.Irp='0'}
    'missing-thread' {$fields.Remove('IssuingThreadId')}
    'foreign-thread' {$fields.IssuingThreadId='33'}
    'before-capture' {$tick=-1}
    'after-capture' {$tick=1001}
  }
  $request=Event 26 $fields $tick $version
  if($scenario -eq 'foreign-provider'){$request.ProviderId=[guid]::Empty}
  $events.Add($request)
  if($scenario -eq 'repeated'){$events.Add((Event 26 $fields 5 1))}
  if($scenario -in @('priority-overflow','byte-overflow')){
    for($n=0;$n -lt 10;$n++){
      $extra=$fields.Clone();$extra.Irp=('0x{0:X}' -f (100+$n))
      if($scenario -eq 'byte-overflow'){$extra.FilePath='C:\owned\'+([string][char]0x6F22)*1700+$n}
      $events.Add((Event 26 $extra (5+$n) 1))
    }
  }
  $events.Add((Event 24 @{Irp='0xCAB01234';Status='0xC0000121'} 20))
  $events | ForEach-Object $processor
  $facts=Get-FileTraceFacts $diagnosticFacts
  $requests=@($facts.events | Where-Object {$null -ne $_.requestEvent} | ForEach-Object {$_.requestEvent})
  $wanted=switch($scenario){'exact'{1};'class13'{1};'hex-class'{1};'repeated'{2};'priority-overflow'{7};default{0}}
  if($requests.Count -ne $wanted){throw "Wrong request-only projection count: $scenario ($($requests.Count))"}
  foreach($request in $requests){
    if($request.evidenceKind -ne 'request-event-only' -or $request.pathProvenance -ne 'explicit-FilePath' -or
      $request.pid -ne $TargetProcessId -or $request.nativeStartFileTime -ne $NativeStartFileTime -or
      $request.threadId -ne 22 -or $request.relativeTarget -ne 'old.node' -or $request.eventId -ne 26 -or
      $request.eventVersion -ne 1 -or $request.infoClass -notin @(13,64) -or
      ([datetime]$request.eventAt).ToUniversalTime() -lt $start -or ([datetime]$request.eventAt).ToUniversalTime() -gt $end -or
      $request.completion -ne 'unknown' -or $null -ne $request.ntStatus){throw "Request contract changed: $scenario"}
  }
  if($scenario -in @('exact','class13','hex-class','repeated','diagnostics-disabled')){
    if(-not $partial.Contains('irp-reuse-without-end') -or @($rows | Where-Object {$_.eventId -in @(18,26)}).Count){throw 'Request evidence gained completion authority'}
  }
  if($scenario -eq 'priority-overflow' -and (-not $facts.priorityTruncated -or $facts.events.Count -gt 16)){throw 'Request row overflow hidden'}
  if($scenario -eq 'byte-overflow' -and (-not $facts.truncated -or $facts.events.Count)){throw 'Request byte overflow hidden'}
  $encoded=$facts | ConvertTo-Json -Depth 8 -Compress
  if([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 32768){throw 'Request facts exceeded byte cap'}
  foreach($canary in @('PRIVATE_CANARY','CAB01234','BEEF1234','FEED5678','C:\owned')){
    if($encoded.Contains($canary)){throw 'Request projection leaked private values'}
  }
  @{scenario="request-only-$scenario";passed=$true;requestEvents=$requests.Count;nativeProof=$false} | ConvertTo-Json -Compress
}
$diagnosticAvailable=$true;$script:queryFailure=$false

# Diagnostic capture failure cannot alter a successful parser result or partiality.
function Start-FileTraceCensusEvent {throw 'Synthetic diagnostic failure'}
$start=[DateTime]::UtcNow;$end=$start.AddSeconds(1);$clock=[Diagnostics.Stopwatch]::StartNew()
$script:lifetimeEnd=[long]::MaxValue
$rows=[Collections.Generic.List[object]]::new();$partial=[Collections.Generic.HashSet[string]]::new()
$pending=@{};$objects=@{};$ownedKeys=@{};$excludedObjects=[Collections.Generic.HashSet[string]]::new()
$counts=@{parsed=0;ownBegins=0;unmatchedEnds=0;unresolvedTargets=0;unresolvedThreads=0;outOfScope=0}
$diagnosticFacts=New-FileTraceFacts;$filterCensus=New-FileTraceCensus
@((Event 12 @{Irp='0x1';FileObject='0x9';IssuingThreadId='22';FileName='C:\owned\old.node';CreateOptions='0'} 1),
  (Event 24 @{Irp='0x1';Status='0'} 2)) | ForEach-Object $processor
if($rows.Count -ne 1 -or $rows[0].ntStatus -ne '0x00000000' -or $partial.Count -ne 0 -or -not $filterCensus.unavailable){throw 'Diagnostic failure changed attribution'}
@{scenario='diagnostic-failure-keeps-parser-result';passed=$true;diagnosticOnly=$true} | ConvertTo-Json -Compress
