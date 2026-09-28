# Synthetic parser-boundary checks only; no native API or Windows proof.
param([string]$SourcePath = (Join-Path $PSScriptRoot 'Invoke-OwnedFileTrace.ps1'))
$ErrorActionPreference = 'Stop'
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
$threadLease | Add-Member ScriptMethod ProcessContainsTime {param($time) return $time -le $script:lifetimeEnd}
function Event([int]$Id,[hashtable]$Fields,[int]$Tick) {
  $data=($Fields.GetEnumerator() | ForEach-Object {
    '<Data Name="'+[Security.SecurityElement]::Escape($_.Key)+'">'+[Security.SecurityElement]::Escape([string]$_.Value)+'</Data>'
  }) -join ''
  $event=[pscustomobject]@{Id=$Id;Version=0;ProviderId=[guid]$receipt.provider;
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
  [pscustomobject]@{scenario=$scenario;passed=$true;setInfoRecords=$setInfo.Count} | ConvertTo-Json -Compress
}
