# Actual publisher and preparation-entry prefix; no native/compiler/provider calls.
param([string]$CliPath=(Join-Path $PSScriptRoot 'Invoke-OwnedFileTrace.ps1'))
$ErrorActionPreference='Stop'
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
$source=[IO.File]::ReadAllText($CliPath)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
Require ($errors.Count -eq 0) 'CLI parse failure'
$assignment=$ast.Find({param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left.Extent.Text -ceq '$arguments.PublishFact'
},$true)
Require ($null -ne $assignment) 'Publisher assignment missing'
$publisherAst=$assignment.Find({param($node)
  $node -is [Management.Automation.Language.ScriptBlockExpressionAst]
},$true)
Require ($null -ne $publisherAst) 'Publisher body missing'
$publisher=$publisherAst.ScriptBlock.GetScriptBlock()
$operations=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'OwnedFileTraceOperations.ps1'))
$opAst=[Management.Automation.Language.Parser]::ParseInput($operations,[ref]$tokens,[ref]$errors)
Require ($errors.Count -eq 0) 'Operations parse failure'
$entry=$opAst.Find({param($node)
  $node -is [Management.Automation.Language.IfStatementAst] -and
  $node.Extent.Text -ceq "if(`$Mode -eq 'prepare'){Emit @{phase='prepare-stage';diagnosticOnly=`$true;stage='entered'}}"
},$true)
Require ($null -ne $entry) 'Actual entered callsite missing'
# Stop the trusted prefix after its real Emit, before any platform or resource effect.
. ([scriptblock]::Create($operations.Substring(0,$entry.Extent.EndOffset)+"`n} finally {}`n}`n"))
$script:calls=0;$script:lastValue=$null;$script:depth=0;$script:compressed=$false
function ConvertTo-Json {
  param([Parameter(ValueFromPipeline)]$InputObject,[int]$Depth,[switch]$Compress)
  process {
    $script:calls++;$script:lastValue=$InputObject;$script:depth=$Depth;$script:compressed=$Compress.IsPresent
    if($script:serializerFailure){throw $script:serializerFailure}
    Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $InputObject -Depth $Depth -Compress:$Compress
  }
}
$fixed='{"phase":"prepare-stage","diagnosticOnly":true,"stage":"entered"}'
$cases=@(
  @{name='actual-entry-serializer-unavailable';entry=$true;literal=$true;unavailable=$true}
  @{name='actual-entry-serializer-fails';entry=$true;literal=$true;fail=$true}
  @{name='exact-entered';literal=$true;value=@{phase='prepare-stage';diagnosticOnly=$true;stage='entered'}}
  @{name='additional-field';value=@{phase='prepare-stage';diagnosticOnly=$true;stage='entered';extra='PRIVATE_FIELD_CANARY'}}
  @{name='structural-member-shadow';value=@{phase='prepare-stage';diagnosticOnly=$true;stage='entered';Count=3;Keys=@('phase','diagnosticOnly','stage')}}
  @{name='different-key-case';value=@{PHASE='prepare-stage';diagnosticOnly=$true;stage='entered'}}
  @{name='string-boolean';value=@{phase='prepare-stage';diagnosticOnly='true';stage='entered'}}
  @{name='false-boolean';value=@{phase='prepare-stage';diagnosticOnly=$false;stage='entered'}}
  @{name='other-stage';value=@{phase='prepare-stage';diagnosticOnly=$true;stage='custody-written'}}
  @{name='unknown-phase';value=@{phase='PRIVATE_UNKNOWN_PHASE';diagnosticOnly=$true;stage='entered'}}
  @{name='other-object-shape';value=[pscustomobject]@{phase='prepare-stage';diagnosticOnly=$true;stage='entered'}}
  @{name='ordinary-record';value=@{phase='prepared';providerEnabled=$false;cleanupVerified=$false}}
  @{name='ordinary-serializer-failure';fail=$true;value=@{phase='prepared';extra='PRIVATE_VALUE'}}
)
$failed=0
foreach($case in $cases){
  $script:calls=0;$script:lastValue=$null;$script:depth=0;$script:compressed=$false
  $script:serializerFailure=if($case.unavailable){[Management.Automation.CommandNotFoundException]::new('PRIVATE_UNAVAILABLE')}elseif($case.fail){[InvalidOperationException]::new('PRIVATE_SERIALIZER_FAILURE')}else{$null}
  $expected=if($case.literal){$fixed+[Environment]::NewLine}else{
    (Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $case.value -Depth 12 -Compress)+[Environment]::NewLine
  }
  $writer=[IO.StringWriter]::new([Globalization.CultureInfo]::InvariantCulture)
  $originalOut=[Console]::Out;$failure=$null
  try {
    [Console]::SetOut($writer)
    try {
      if($case.entry){
        Invoke-OwnedFileTraceOperation -Mode prepare -ReceiptPath ([IO.Path]::Combine([IO.Path]::GetTempPath(),'entry-only-trace.json')) -ExpectedGuid ([guid]::NewGuid()) -PublishFact $publisher
      } else {$null=& $publisher $case.value}
    } catch {$failure=$_.Exception}
  } finally {[Console]::SetOut($originalOut)}
  $actual=$writer.ToString();$writer.Dispose()
  $issues=[Collections.Generic.List[string]]::new()
  $ascii=$true;foreach($character in $actual.ToCharArray()){if([int]$character -gt 127){$ascii=$false}}
  if($case.literal){
    if($script:calls -ne 0){$issues.Add('serializer-invoked')}
    if($failure -or $actual -cne $expected -or -not $ascii){$issues.Add('literal-protocol')}
  } else {
    if($script:calls -ne 1 -or -not [Object]::ReferenceEquals($script:lastValue,$case.value) -or $script:depth -ne 12 -or -not $script:compressed){$issues.Add('ordinary-delegation')}
    if($case.fail){
      if(-not [Object]::ReferenceEquals($failure,$script:serializerFailure) -or $actual.Length -ne 0){$issues.Add('original-failure-not-preserved')}
    } elseif($failure -or $actual -cne $expected){$issues.Add('ordinary-fields-or-protocol')}
  }
  if($issues.Count){$failed++}
  @{case=$case.name;passed=($issues.Count -eq 0);serializerCalls=$script:calls;issues=@($issues.ToArray());nativeProof=$false} | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
}
if($failed){throw "Entered publication cases failed: $failed"}
