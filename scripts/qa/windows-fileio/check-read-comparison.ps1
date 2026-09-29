# Actual reader entry with only the platform prerequisite and exit intercepted.
# Get-WinEvent is a managed fixture stream; this does not qualify Windows ETL APIs.
param([string]$SourcePath=(Join-Path $PSScriptRoot 'Read-OwnedFileTrace.ps1'),
  [Parameter(Mandatory)][string]$TestRoot)
$ErrorActionPreference='Stop'
if(-not [IO.Directory]::Exists($TestRoot) -or [IO.Directory]::GetFileSystemEntries($TestRoot).Length){throw 'Fresh caller-owned TestRoot required'}
$source=[IO.File]::ReadAllText((Resolve-Path $SourcePath))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Reader source parse failed'}
$guard=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and
  $node.Clauses[0].Item1.Extent.Text.Contains('[Environment]::OSVersion.Platform')},$true))
$exits=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.ExitStatementAst]},$true))
if($guard.Count -ne 1 -or $exits.Count -ne 1 -or $exits[0].Pipeline.Extent.Text -cne '2'){throw 'Reader control boundaries changed'}
$edits=@(@{start=$guard[0].Extent.StartOffset;length=$guard[0].Extent.EndOffset-$guard[0].Extent.StartOffset;text=''},
  @{start=$exits[0].Extent.StartOffset;length=$exits[0].Extent.EndOffset-$exits[0].Extent.StartOffset;text='$script:readerExitCode=2'})
foreach($edit in $edits | Sort-Object start -Descending){$source=$source.Remove($edit.start,$edit.length).Insert($edit.start,$edit.text)}
$entry=[scriptblock]::Create($source)
Add-Type -TypeDefinition @'
using System;
public sealed class SameEtlReaderEvent : IDisposable {
  public Guid ProviderId;
  public int Id;
  public int ProcessId;
  public string PrivatePayload="PRIVATE_EVENT_CANARY";
  public static int Created,Disposed,XmlReads;
  public static bool ThrowOnDispose;
  public SameEtlReaderEvent(Guid provider,int id,int pid){ProviderId=provider;Id=id;ProcessId=pid;Created++;}
  public string ToXml(){XmlReads++;throw new Exception("PRIVATE_XML_CANARY");}
  public void Dispose(){Disposed++;if(ThrowOnDispose)throw new Exception("PRIVATE_DISPOSE_CANARY");}
}
'@
function Get-WinEvent {
  param([string]$Path,[switch]$Oldest,[int]$MaxEvents)
  $script:queries++
  if($Path -cne $script:expectedRaw -or -not $Oldest -or $MaxEvents -ne 20001){throw 'Reader enumeration arguments changed'}
  # Dynamic scope observes the actual held FileStream, without replacing IO.
  $script:heldReadOnly=$readerStream.CanRead -and -not $readerStream.CanWrite
  $script:retainedHandle=$readerStream.SafeFileHandle
  if($script:retainedHandle.IsClosed){throw 'Reader did not hold its input'}
  if($script:scenario -in @('empty','formatting-failure')){
    $errorId=if($script:scenario -eq 'empty'){'NoMatchingEventsFound'}else{'MessageFormattingError'}
    Write-Error -ErrorRecord ([Management.Automation.ErrorRecord]::new(
      [InvalidOperationException]::new('PRIVATE_CMDLET_CANARY'),$errorId,[Management.Automation.ErrorCategory]::NotSpecified,$null))
    return
  }
  if($script:scenario -in @('cap-exact','cap-over')){
    $limit=if($script:scenario -eq 'cap-exact'){20000}else{20002}
    for($index=0;$index -lt $limit;$index++){
      [SameEtlReaderEvent]::new($script:provider,999,77)
    }
    return
  }
  [SameEtlReaderEvent]::new($script:provider,26,77)
  if($script:scenario -eq 'enumeration-failure'){throw [IO.IOException]::new('PRIVATE_ENUMERATION_CANARY')}
  [SameEtlReaderEvent]::new($script:provider,26,88)
  [SameEtlReaderEvent]::new($script:provider,10,77)
  [SameEtlReaderEvent]::new($script:provider,999,77)
  [SameEtlReaderEvent]::new([guid]'00000000-0000-0000-0000-000000000001',12,77)
}
$script:provider=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289'
$cases=@('counts','empty','formatting-failure','cap-exact','cap-over','enumeration-failure','dispose-failure',
  'receipt-json','receipt-size','receipt-array','receipt-field-shape','contract','name','guid','provider','raw-path','receipt-directory',
  'raw-directory','receipt-reparse','raw-reparse','ancestor-reparse','raw-size')
$failed=0
foreach($case in $cases){
  $script:scenario=$case;$script:queries=0;$script:heldReadOnly=$false;$script:retainedHandle=$null
  $script:readerExitCode=0
  [SameEtlReaderEvent]::Created=0;[SameEtlReaderEvent]::Disposed=0;[SameEtlReaderEvent]::XmlReads=0
  [SameEtlReaderEvent]::ThrowOnDispose=$case -eq 'dispose-failure'
  $directory=Join-Path $TestRoot $case
  [void][IO.Directory]::CreateDirectory($directory)
  if($case -eq 'ancestor-reparse'){
    $targetDirectory=Join-Path $directory 'real'
    [void][IO.Directory]::CreateDirectory($targetDirectory)
    $directory=Join-Path $directory 'alias'
    [void][IO.Directory]::CreateSymbolicLink($directory,$targetDirectory)
  }
  $receiptPath=Join-Path $directory 'trace.json'
  $rawPath=Join-Path $directory 'private-host-events.etl'
  $script:expectedRaw=$rawPath
  $expectedGuid=[guid]::NewGuid()
  $receipt=@{contract='owned-fileio-v1';name=('OpenClaw-Owned-FileIO-'+$expectedGuid.ToString('N'));
    guid=$expectedGuid.ToString();provider=$script:provider.ToString();raw=$rawPath;extra='PRIVATE_RECEIPT_CANARY'}
  if($case -in @('contract','name','guid','provider')){$receipt[$case]='PRIVATE_RECEIPT_CANARY'}
  if($case -eq 'raw-path'){$receipt.raw=Join-Path $directory 'PRIVATE_FOREIGN_ETL'}
  if($case -eq 'raw-directory'){[void][IO.Directory]::CreateDirectory($rawPath)}
  elseif($case -eq 'raw-reparse'){
    $target=Join-Path $directory 'raw-target'
    [IO.File]::WriteAllText($target,'PRIVATE_RAW_CANARY')
    [void][IO.File]::CreateSymbolicLink($rawPath,$target)
  } else {
    [IO.File]::WriteAllText($rawPath,'PRIVATE_RAW_CANARY')
    if($case -eq 'raw-size'){
      $sizeStream=[IO.File]::Open($rawPath,[IO.FileMode]::Open,[IO.FileAccess]::Write)
      try {$sizeStream.SetLength(8MB)} finally {$sizeStream.Dispose()}
    }
  }
  $receiptText=$receipt | ConvertTo-Json -Compress
  if($case -eq 'receipt-json'){$receiptText='PRIVATE_INVALID_JSON'}
  if($case -eq 'receipt-size'){$receiptText='X'*16385}
  if($case -eq 'receipt-array'){$receiptText='['+$receiptText+']'}
  if($case -eq 'receipt-field-shape'){$receipt.provider=@($receipt.provider);$receiptText=$receipt | ConvertTo-Json -Compress}
  if($case -eq 'receipt-directory'){[void][IO.Directory]::CreateDirectory($receiptPath)}
  elseif($case -eq 'receipt-reparse'){
    $target=Join-Path $directory 'receipt-target'
    [IO.File]::WriteAllText($target,$receiptText,[Text.UTF8Encoding]::new($false))
    [void][IO.File]::CreateSymbolicLink($receiptPath,$target)
  } else {[IO.File]::WriteAllText($receiptPath,$receiptText,[Text.UTF8Encoding]::new($false))}
  $rawBefore=if([IO.File]::Exists($rawPath)){(Get-FileHash -LiteralPath $rawPath).Hash}else{$null}
  $capture=[IO.StringWriter]::new()
  $prior=[Console]::Out
  try {
    [Console]::SetOut($capture)
    $other=@(& $entry -ReceiptPath $receiptPath -ExpectedGuid $expectedGuid -TargetProcessId 77 2>&1)
  } finally {[Console]::SetOut($prior)}
  $output=$capture.ToString();$capture.Dispose()
  $success=$case -in @('counts','cap-exact')
  $expectedQueries=if($case -in @('counts','empty','formatting-failure','cap-exact','cap-over','enumeration-failure','dispose-failure')){1}else{0}
  $expectedEvents=switch($case){'counts'{5};'empty'{0};'cap-exact'{20000};'cap-over'{20001};'enumeration-failure'{1};'dispose-failure'{1};default{0}}
  $cleanup=[SameEtlReaderEvent]::Disposed -eq $expectedEvents -and [SameEtlReaderEvent]::Created -eq $expectedEvents -and
    ($null -eq $script:retainedHandle -or $script:retainedHandle.IsClosed)
  $rawAfter=if([IO.File]::Exists($rawPath)){(Get-FileHash -LiteralPath $rawPath).Hash}else{$null}
  $passed=$script:readerExitCode -eq $(if($success){0}else{2}) -and $script:queries -eq $expectedQueries -and
    $cleanup -and $other.Count -eq 0 -and [SameEtlReaderEvent]::XmlReads -eq 0 -and $rawBefore -ceq $rawAfter -and
    ($expectedQueries -eq 0 -or $script:heldReadOnly) -and -not $output.Contains('PRIVATE_')
  if($success){
    $lines=@($output.Trim() -split '\r?\n')
    $record=$output | ConvertFrom-Json
    $expectedKeys=@('phase','diagnosticOnly','runtime','relevantEventCounts','headerPidMatchCounts')
    $passed=$passed -and $lines.Count -eq 1 -and [Text.Encoding]::UTF8.GetByteCount($output) -le 4096 -and
      $record.phase -ceq 'same-etl-reader' -and $record.diagnosticOnly -eq $true -and
      @($record.PSObject.Properties.Name | Where-Object {$_ -notin $expectedKeys}).Count -eq 0 -and
      @($record.PSObject.Properties).Count -eq 5
    $runtimeKeys=@('psVersion','edition','clrVersion','is64BitProcess')
    $passed=$passed -and @($record.runtime.PSObject.Properties.Name | Where-Object {$_ -notin $runtimeKeys}).Count -eq 0 -and
      $record.runtime.psVersion -ceq $PSVersionTable.PSVersion.ToString() -and $record.runtime.edition -ceq $PSVersionTable.PSEdition -and
      $record.runtime.clrVersion -ceq [Environment]::Version.ToString() -and $record.runtime.is64BitProcess -eq [Environment]::Is64BitProcess
    foreach($mapName in @('relevantEventCounts','headerPidMatchCounts')){
      $map=$record.$mapName
      $passed=$passed -and @($map.PSObject.Properties).Count -eq 10
      foreach($id in @(10,11,12,13,14,15,17,18,24,26)){
        $expected=0
        if($case -eq 'counts' -and $id -eq 26){$expected=if($mapName -eq 'relevantEventCounts'){2}else{1}}
        if($case -eq 'counts' -and $id -eq 10){$expected=1}
        $passed=$passed -and $map.PSObject.Properties[[string]$id].Value -eq $expected
      }
    }
  } else {$passed=$passed -and [string]::IsNullOrEmpty($output)}
  if(-not $passed){$failed++}
  @{case=$case;passed=[bool]$passed;eventsDisposed=[SameEtlReaderEvent]::Disposed;queryCount=$script:queries;
    heldReadOnly=$script:heldReadOnly;cleanupCorrect=[bool]$cleanup;rawUnchanged=($rawBefore -ceq $rawAfter);
    nativeProof=$false;platform=[Environment]::OSVersion.Platform.ToString();substitutions=@('runtime-prerequisite','exit-to-captured-code')} | ConvertTo-Json -Compress
}
if($failed){throw "Same ETL reader contract failures: $failed"}
