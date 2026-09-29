# Actual preparation entry with synthetic native/compiler/provider primitives.
# The trusted copy removes only the Windows prerequisite. All receipt writes,
# replacement arguments, and hashes are the actual operations source.
param([string]$SourcePath=(Join-Path $PSScriptRoot 'OwnedFileTraceOperations.ps1'))
$ErrorActionPreference='Stop'
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
$source=[IO.File]::ReadAllText((Resolve-Path $SourcePath))
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors)
Require ($parseErrors.Count -eq 0) 'Operations source did not parse'
$guard=$ast.Find({param($node)
  $node -is [Management.Automation.Language.IfStatementAst] -and
  $node.Clauses[0].Item1.Extent.Text.Contains('[Environment]::OSVersion.Platform')
},$true)
Require ($null -ne $guard) 'Windows prerequisite was not found'
$copy=$source.Remove($guard.Extent.StartOffset,$guard.Extent.EndOffset-$guard.Extent.StartOffset)
$substitutions=@('windows-platform-prerequisite-removed')
$root=Join-Path ([IO.Path]::GetTempPath()) ('owned-prepare-diagnostics-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$failed=0
try {
$sourceDirectory=Join-Path $root 'source'
[void][IO.Directory]::CreateDirectory($sourceDirectory)
foreach($name in @('OwnedFileTrace.cs','FileTraceFacts.ps1','Invoke-OwnedFileTrace.ps1')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $sourceDirectory
}
$copyPath=Join-Path $sourceDirectory 'OwnedFileTraceOperations.ps1'
[IO.File]::WriteAllText($copyPath,$copy)
. $copyPath
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
public static class OwnedFileTrace {
    public static bool Occupied;
    public static Exception StartFailure;
    public static int Queries;
    public static int Starts;
    public static object Query(string name, Guid id) {
        Queries++;
        if (Occupied) return new object();
        throw new Win32Exception(4201, "PRIVATE_NATIVE_MESSAGE");
    }
    public static ulong Start(string name, Guid id, string raw) {
        Starts++;
        if (StartFailure != null) throw StartFailure;
        File.WriteAllText(raw, "synthetic trace");
        return 123;
    }
}
'@
function Add-Type {
  param([string]$Path,[string]$OutputAssembly)
  if($OutputAssembly){
    if($script:scenario -eq 'compile-failure'){throw [UnauthorizedAccessException]::new('PRIVATE_COMPILER_PATH')}
    [IO.File]::WriteAllText($OutputAssembly,'synthetic DLL')
    $script:compiled++
  } else {
    if($script:scenario -eq 'load-failure'){throw [InvalidOperationException]::new('PRIVATE_DLL_PATH')}
    Require ([IO.File]::Exists($Path)) 'Compiler did not create its output'
    $script:loaded++
  }
}
function Get-WinEvent {
  param([string]$ListProvider)
  $script:providerCalls++
  if($script:scenario -eq 'nested-win32'){
    throw [Exception]::new('PRIVATE_WRAPPER',[ComponentModel.Win32Exception]::new(5,'PRIVATE_NATIVE_PATH'))
  }
  if($script:scenario -eq 'io-with-native-looking-data'){
    $errorValue=[IO.IOException]::new('PRIVATE_IO_MESSAGE')
    $errorValue.Data['NativeErrorCode']=87
    throw $errorValue
  }
  if($script:scenario -eq 'depth-bound'){
    $errorValue=[ComponentModel.Win32Exception]::new(87,'PRIVATE_DEEP_NATIVE')
    for($index=0;$index -lt 12;$index++){$errorValue=[Exception]::new('PRIVATE_WRAPPER',$errorValue)}
    throw $errorValue
  }
  return [pscustomobject]@{Id=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289';Events=@(
    [pscustomobject]@{Id=26;Version=1;Task=[pscustomobject]@{Name='SetInformation'};
      Opcode=[pscustomobject]@{Name='Info'};Template='<template><data name="InfoClass"/></template>'}
  )}
}
$stageNames=@('entered','custody-written','dll-compiled','dll-loaded','schema-discovered',
  'schema-written','inputs-bound','trace-absent','trace-started','acquisition-written')
$cases=@(
  @{name='success';count=10}
  @{name='custody-write-failure';count=1;category='io'}
  @{name='compile-failure';count=2;category='unauthorized-access'}
  @{name='load-failure';count=3;category='invalid-operation'}
  @{name='nested-win32';count=4;category='win32';native=5}
  @{name='io-with-native-looking-data';count=4;category='io'}
  @{name='depth-bound';count=4;category='other';truncated=$true}
  @{name='schema-write-failure';count=5;category='io'}
  @{name='binding-write-failure';count=6;category='io'}
  @{name='trace-occupied';count=7;category='other'}
  @{name='trace-start-failure';count=8;category='win32';native=50}
  @{name='acquisition-write-failure';count=9;category='io'}
)
  foreach($case in $cases){
    $script:scenario=$case.name
    $script:compiled=0;$script:loaded=0;$script:providerCalls=0
    [OwnedFileTrace]::Occupied=$case.name -eq 'trace-occupied'
    [OwnedFileTrace]::Queries=0;[OwnedFileTrace]::Starts=0;[OwnedFileTrace]::StartFailure=$null
    if($case.name -eq 'trace-start-failure'){
      [OwnedFileTrace]::StartFailure=[Exception]::new('PRIVATE_START_WRAPPER',[ComponentModel.Win32Exception]::new(50,'PRIVATE_START_PATH'))
    }
    $directory=Join-Path $root $case.name
    [void][IO.Directory]::CreateDirectory($directory)
    $fixtureReceipt=Join-Path $directory 'trace.json'
    $collision=switch($case.name){
      'custody-write-failure'{$fixtureReceipt+'.pending'}
      'schema-write-failure'{Join-Path $directory 'provider-schema.json.pending'}
      'binding-write-failure'{$fixtureReceipt+'.ready-pending.pending'}
      'acquisition-write-failure'{Join-Path $directory 'acquired.json.pending'}
    }
    if($collision){[IO.File]::WriteAllText($collision,'PRIVATE_COLLISION')}
    $streamed=[Collections.Generic.List[object]]::new()
    $custody=@{initial=$null;verified=$false}
    $callback={param($fact)
      $streamed.Add($fact)
      if($fact.phase -ne 'prepare-stage'){return}
      Require ($fact.diagnosticOnly -eq $true -and $fact.Keys.Count -eq 3) 'Stage marker added authority or unbounded fields'
      switch($fact.stage){
        'entered'{Require (-not [IO.File]::Exists($fixtureReceipt)) 'Entry was emitted after custody'}
        'custody-written'{
          Require ([IO.File]::Exists($fixtureReceipt)) 'Custody marker preceded its real write'
          $custody.initial=[IO.File]::ReadAllText($fixtureReceipt)|ConvertFrom-Json
        }
        'dll-compiled'{Require ($script:compiled -eq 1 -and [IO.File]::Exists((Join-Path $directory 'OwnedFileTrace.dll'))) 'Compilation marker preceded output'}
        'dll-loaded'{Require ($script:loaded -eq 1) 'Load marker preceded the loader'}
        'schema-discovered'{Require ($script:providerCalls -eq 1) 'Schema marker preceded provider discovery'}
        'schema-written'{Require ([IO.File]::Exists((Join-Path $directory 'provider-schema.json'))) 'Schema marker preceded its real write'}
        'inputs-bound'{
          $bound=[IO.File]::ReadAllText($fixtureReceipt)|ConvertFrom-Json
          Require ($bound.dllSha256 -eq (Get-FileHash (Join-Path $directory 'OwnedFileTrace.dll')).Hash.ToLowerInvariant()) 'Inputs marker preceded bound DLL hash'
          Require ($bound.schemaSha256 -eq (Get-FileHash (Join-Path $directory 'provider-schema.json')).Hash.ToLowerInvariant()) 'Inputs marker preceded bound schema hash'
          foreach($key in @('contract','guid','name','raw','dll','provider','preparedAt','sourceSha256','helperSha256','factsSha256','cliSha256')){
            Require ($bound.$key -ceq $custody.initial.$key) 'Receipt replacement changed custody'
          }
          foreach($key in @('executable','psVersion','edition','clrVersion','is64BitProcess')){
            Require ($bound.runtime.$key -ceq $custody.initial.runtime.$key) 'Receipt replacement changed runtime binding'
          }
          Require (-not [IO.File]::Exists($fixtureReceipt+'.ready-pending')) 'Replacement did not consume staged receipt'
          if($script:scenario -eq 'success'){
            $files=@([IO.Directory]::GetFiles($directory)|ForEach-Object {[IO.Path]::GetFileName($_)}|Sort-Object)
            Require (($files -join ',') -ceq 'OwnedFileTrace.dll,provider-schema.json,trace.json') 'Replacement left a backup or unexpected file'
          }
          $custody.verified=$true
        }
        'trace-absent'{Require ([OwnedFileTrace]::Queries -eq 1 -and [OwnedFileTrace]::Starts -eq 0) 'Absence marker preceded its native query'}
        'trace-started'{Require ([OwnedFileTrace]::Starts -eq 1 -and [IO.File]::Exists((Join-Path $directory 'private-host-events.etl'))) 'Start marker preceded acquisition'}
        'acquisition-written'{Require ([IO.File]::Exists((Join-Path $directory 'acquired.json'))) 'Acquisition marker preceded its real write'}
        default{throw 'Unknown stage was streamed'}
      }
    }
    $Error.Clear()
    $result=Invoke-OwnedFileTraceOperation -Mode prepare -ReceiptPath $fixtureReceipt -ExpectedGuid ([guid]::NewGuid()) -PublishFact $callback
    $replaceArgumentFailure=$false
    foreach($record in @($Error|Select-Object -First 8)){
      $atReplace=([string]$record.InvocationInfo.Line).Contains('::Replace(') -or $record.CategoryInfo.Activity -eq 'Replace'
      $cause=$record.Exception
      for($depth=0;$depth -lt 8 -and $null -ne $cause;$depth++){
        if($atReplace -and $cause -is [ArgumentException]){$replaceArgumentFailure=$true}
        $cause=$cause.InnerException
      }
    }
    $stages=@($streamed | Where-Object {$_.phase -eq 'prepare-stage'} | ForEach-Object {$_.stage})
    $failure=@($streamed | Where-Object {$_.phase -eq 'prepare-failure'})
    $issues=[Collections.Generic.List[string]]::new()
    if(($stages -join ',') -cne ($stageNames[0..($case.count-1)] -join ',')){$issues.Add('stage-order-or-presence')}
    if(($result.records|ConvertTo-Json -Depth 12 -Compress) -cne ($streamed.ToArray()|ConvertTo-Json -Depth 12 -Compress)){$issues.Add('stream-return-divergence')}
    if($case.name -eq 'success'){
      if(-not $custody.verified){$issues.Add('receipt-custody-not-updated')}
      if($result.exitCode -ne 0 -or $failure.Count -ne 0 -or $result.records[-1].phase -ne 'prepared' -or $result.records[-1].cleanupVerified -ne $false -or $result.records[-1].providerEnabled -ne $false){$issues.Add('success-policy-changed')}
    } else {
      if($result.exitCode -ne 2 -or $result.records[-1].phase -ne 'prepare' -or $result.records[-1].reason -ne 'native-probe-failed-or-ownership-refused' -or $result.records[-1].cleanupVerified -ne $false){$issues.Add('failure-policy-changed')}
      if($failure.Count -ne 1){$issues.Add('failure-diagnostic-missing')}
      else {
        $fact=$failure[0]
        if($fact.errorCategory -cne $case.category -or $fact.truncated -ne [bool]$case.truncated -or $fact.diagnosticOnly -ne $true){$issues.Add('failure-category-or-bound')}
        if($case.ContainsKey('native')){
          if($fact.nativeErrorCode -ne $case.native -or $fact.nativeErrorCode -isnot [int]){$issues.Add('native-code-missing')}
        } elseif($fact.ContainsKey('nativeErrorCode')){$issues.Add('fabricated-native-code')}
        $allowed=@('phase','diagnosticOnly','errorCategory','truncated','nativeErrorCode')
        if(@($fact.Keys | Where-Object {$_ -notin $allowed}).Count){$issues.Add('private-failure-field')}
        if(($fact|ConvertTo-Json -Compress).Contains('PRIVATE_')){$issues.Add('private-failure-content')}
      }
    }
    if($issues.Count){$failed++}
    @{case=$case.name;passed=($issues.Count -eq 0);stages=$stages;issues=@($issues.ToArray());
      replacementCustodyVerified=$custody.verified;replaceArgumentFailureObserved=$replaceArgumentFailure;
      platform=[Environment]::OSVersion.Platform.ToString();substitutions=$substitutions;nativeProof=$false} | ConvertTo-Json -Depth 4 -Compress
  }
} finally {
  [IO.Directory]::Delete($root,$true)
}
if($failed){throw "Preparation diagnostic cases failed: $failed"}
