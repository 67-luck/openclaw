param(
  [Parameter(Mandatory)][ValidateSet('identity','foreign-guid','absent')][string]$Mode,
  [uint32]$TargetProcessId,
  [string]$NativeStartFileTime,
  [string]$ReceiptPath,
  [guid]$ExpectedGuid
)
$ErrorActionPreference='Stop'
try {
  if ($Mode -eq 'identity') {
    $process=[Diagnostics.Process]::GetProcessById($TargetProcessId)
    try {
      @{pid=$TargetProcessId;nativeStartFileTime=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress
    } finally {$process.Dispose()}
  } elseif($Mode -eq 'absent') {
    $process=$null
    try {$process=[Diagnostics.Process]::GetProcessById($TargetProcessId)} catch [ArgumentException] {}
    if($null -eq $process) {@{originalAbsent=$true;replacementPresent=$false} | ConvertTo-Json -Compress}
    else {
      try {
        $same=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq $NativeStartFileTime
        @{originalAbsent=(-not $same);replacementPresent=(-not $same)} | ConvertTo-Json -Compress
        if($same){exit 2}
      } finally {$process.Dispose()}
    }
  } else {
    $receipt=Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($receipt.guid -ne $ExpectedGuid.ToString() -or $receipt.name -ne ('OpenClaw-Owned-FileIO-'+$ExpectedGuid.ToString('N'))){throw 'Receipt mismatch'}
    $dll=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReceiptPath))) 'OwnedFileTrace.dll'
    if($receipt.dll -ne $dll){throw 'DLL mismatch'}
    Add-Type -Path $dll
    $before=[OwnedFileTrace]::Query($receipt.name,$ExpectedGuid)
    $wrong=[guid]::NewGuid()
    $refused=$false
    try {$null=[OwnedFileTrace]::Query($receipt.name,$wrong)}
    catch {
      $cause=$_.Exception
      while($cause.InnerException){$cause=$cause.InnerException}
      if($cause -is [InvalidOperationException]){$refused=$true}else{throw}
    }
    $after=[OwnedFileTrace]::Query($receipt.name,$ExpectedGuid)
    if(-not $refused -or $before.Wnode.HistoricalContext -ne $after.Wnode.HistoricalContext){throw 'Foreign query control failed'}
    @{wrongGuidRefused=$true;ownerUnchanged=$true;name=$receipt.name;guid=$ExpectedGuid.ToString();handle=$after.Wnode.HistoricalContext.ToString()} | ConvertTo-Json -Compress
  }
} catch {
  @{control=$Mode;result='failed';reason='native-control-unverified'} | ConvertTo-Json -Compress
  exit 2
}
