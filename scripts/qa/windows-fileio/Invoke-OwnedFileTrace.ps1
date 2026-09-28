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
. (Join-Path $PSScriptRoot 'OwnedFileTraceOperations.ps1')
$arguments=@{} + $PSBoundParameters
$arguments.PublishFact={param($value) [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 12 -Compress))}
$arguments.ObserveWork={Start-Sleep -Milliseconds $CaptureMilliseconds}
$outcome=Invoke-OwnedFileTraceOperation @arguments
exit $outcome.exitCode
