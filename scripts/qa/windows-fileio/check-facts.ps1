$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'FileTraceFacts.ps1')
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
$schema=@{id=17;version=1;task='SetInformation';opcode='Info';template='<template><data name="Irp"/><data name="FileObject"/><data name="FileKey"/><data name="InfoClass"/></template>'}
$fields=@{Irp='0000CAFEBABE12345';FileObject='0000CAFEBABE23456';FileKey='0000CAFEBABE34567';FileName='C:\outside\PRIVATE_PATH_CANARY';InfoClass='64'}
$beforeFields=$fields | ConvertTo-Json -Compress
$beforeSchema=$schema | ConvertTo-Json -Compress
$facts=New-FileTraceFacts
$output=@(Update-FileTraceFacts $facts 10 '' $fields.FileKey $false $true)
Require ($output.Count -eq 0) 'Mutator emitted private state'
Add-OwnFileTraceFact $facts $schema $fields $fields.Irp $fields.FileObject $fields.FileKey 'unknown' 'unknown' $false $false $false $false
Update-FileTraceFacts $facts 10 '' $fields.FileKey $false $true
Update-FileTraceFacts $facts 24 $fields.Irp '' $true $false
Update-FileTraceFacts $facts 10 '' $fields.FileKey $false $true
$public=Get-FileTraceFacts $facts
Require ($public.events.Count -eq 1) 'Missing owned fact'
Require $public.events[0].namePresent 'Name value presence missing'
Require ($public.events[0].matchingOwnedNameBeforeBegin -eq 1) 'Before-name fact missing'
Require ($public.events[0].matchingOwnedNameAfterBegin -eq 1) 'Name after completion counted'
Require $public.events[0].completionSeen 'Missing completion presence'
Require ($public.events[0].resolvedScope -eq 'unknown') 'Diagnostic granted target authority'
$encoded=$public | ConvertTo-Json -Depth 8 -Compress
Require (($fields|ConvertTo-Json -Compress) -eq $beforeFields -and ($schema|ConvertTo-Json -Compress) -eq $beforeSchema) 'Facts mutated parser inputs'
foreach($canary in @('PRIVATE_PATH_CANARY','CAFEBABE12345','CAFEBABE23456','CAFEBABE34567')){
  Require (-not $encoded.Contains($canary)) 'Private path or pointer escaped projection'
}
@{case='owned-name-order-and-privacy';passed=$true} | ConvertTo-Json -Compress

$retired=New-FileTraceFacts
Add-OwnFileTraceFact $retired $schema $fields $fields.Irp $fields.FileObject $fields.FileKey 'unknown' 'unknown' $false $false $false $false
Update-FileTraceFacts $retired 11 '' $fields.FileKey $false $false
Update-FileTraceFacts $retired 10 '' $fields.FileKey $false $true
Update-FileTraceFacts $retired 17 $fields.Irp $fields.FileKey $false $false
Update-FileTraceFacts $retired 24 $fields.Irp '' $true $false
$entry=(Get-FileTraceFacts $retired).events[0]
Require ($entry.nameKeyRetired -and $entry.irpReusedBeforeEnd) 'Lifetime ambiguity was hidden'
Require ($entry.matchingOwnedNameAfterBegin -eq 0 -and -not $entry.completionSeen) 'Retired identity claimed a match'
@{case='retired-key-and-reused-irp';passed=$true} | ConvertTo-Json -Compress

$bounded=New-FileTraceFacts
for($n=1;$n -le 100;$n++){
  Update-FileTraceFacts $bounded 10 '' ([string]$n) $false $true
  Add-OwnFileTraceFact $bounded $schema $fields ([string]$n) ([string]$n) ([string]$n) 'unknown' 'unknown' $false $false $false $false
}
$projection=Get-FileTraceFacts $bounded
Require ($bounded.names.Count -le 16 -and $projection.events.Count -le 16 -and $projection.truncated) 'Fact cardinality bound failed'
Require ([Text.Encoding]::UTF8.GetByteCount(($projection|ConvertTo-Json -Depth 8 -Compress)) -le 32768) 'Fact byte bound failed'
$schemas=1..100 | ForEach-Object {@{id=10;version=$_;task='NameCreate';opcode='Info';template=('<template>'+('<data name="'+('X'*64)+'"/>' )*100+'</template>')}}
$metadata=Get-FileTracePublicSchema $schemas
Require ($metadata.truncated -and $metadata.events.Count -le 32) 'Schema cardinality bound failed'
Require ([Text.Encoding]::UTF8.GetByteCount(($metadata|ConvertTo-Json -Depth 8 -Compress)) -le 16384) 'Schema byte bound failed'
@{case='metadata-and-fact-bounds';passed=$true} | ConvertTo-Json -Compress

# The public native fact derives the same guard without exposing native times.
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedFileTrace.cs')
foreach($case in @(
  @{name='query-failure';query=$false;error=6;creation=$null;before=$null;exit=$null;after=$null;expected=$false}
  @{name='wrong-creation';query=$true;error=$null;creation=$false;before=$true;exit=$false;after=$null;expected=$false}
  @{name='before-creation';query=$true;error=$null;creation=$true;before=$false;exit=$false;after=$null;expected=$false}
  @{name='after-exit';query=$true;error=$null;creation=$true;before=$true;exit=$true;after=$false;expected=$false}
  @{name='live-process';query=$true;error=$null;creation=$true;before=$true;exit=$false;after=$null;expected=$true}
  @{name='within-exited-lifetime';query=$true;error=$null;creation=$true;before=$true;exit=$true;after=$true;expected=$true}
)) {
  $fact=[OwnedFileTrace+ProcessTimeObservation]::new()
  $fact.QuerySucceeded=$case.query;$fact.NativeError=$case.error;$fact.CreationMatches=$case.creation
  $fact.EventNotBeforeCreation=$case.before;$fact.ExitTimePresent=$case.exit;$fact.EventNotAfterExit=$case.after
  Require ($fact.ContainsTime -eq $case.expected) "Lifetime guard changed: $($case.name)"
}
@{case='native-lifetime-fact-decision';passed=$true} | ConvertTo-Json -Compress
