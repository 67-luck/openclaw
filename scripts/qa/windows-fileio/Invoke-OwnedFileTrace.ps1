[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('prepare','observe','cleanup')][string]$Mode,
  [Parameter(Mandatory)][string]$ReceiptPath,
  [Parameter(Mandatory)][guid]$ExpectedGuid,
  [uint32]$TargetProcessId,
  [string]$NativeStartFileTime,
  [string]$OwnedPrefix,
  [ValidateRange(100,1500)][int]$CaptureMilliseconds=1000
)
$ErrorActionPreference='Stop'
. ([IO.Path]::Combine($PSScriptRoot,'OwnedFileTraceOperations.ps1'))
$arguments=@{} + $PSBoundParameters
$arguments.PublishFact={param($value)
  # Keep the fixed entry acknowledgement independent of diagnostic serialization.
  $entered=$value -is [Collections.IDictionary] -and $value.PSBase.Count -eq 3
  if($entered){
    foreach($key in $value.PSBase.Keys){
      if($key -isnot [string] -or @('phase','diagnosticOnly','stage') -cnotcontains $key){$entered=$false;break}
    }
  }
  if($entered -and $value['phase'] -is [string] -and $value['phase'] -ceq 'prepare-stage' -and
    $value['stage'] -is [string] -and $value['stage'] -ceq 'entered' -and
    $value['diagnosticOnly'] -is [bool] -and $value['diagnosticOnly'] -eq $true){
    [Console]::Out.WriteLine('{"phase":"prepare-stage","diagnosticOnly":true,"stage":"entered"}')
    return
  }
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 12 -Compress))
}
$arguments.ObserveWork={Start-Sleep -Milliseconds $CaptureMilliseconds}
$outcome=Invoke-OwnedFileTraceOperation @arguments
exit $outcome.exitCode
