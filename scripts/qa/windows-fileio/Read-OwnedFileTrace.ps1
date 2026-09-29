[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ReceiptPath,
  [Parameter(Mandatory)][guid]$ExpectedGuid,
  [Parameter(Mandatory)][ValidateRange(1,4294967295)][uint32]$TargetProcessId
)
$ErrorActionPreference='Stop'
function Get-RegularReaderPath([string]$Path) {
  if(-not [IO.Path]::IsPathRooted($Path)){throw 'Reader path must be absolute'}
  $full=[IO.Path]::GetFullPath($Path)
  $attributes=[IO.File]::GetAttributes($full)
  if(($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0){throw 'Reader file shape refused'}
  $parent=[IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($full))
  while($null -ne $parent){
    if(($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reader parent shape refused'}
    $parent=$parent.Parent
  }
  return $full
}
try {
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
      $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'Reader runtime refused'}
  if($ExpectedGuid -eq [guid]::Empty){throw 'Reader identity refused'}
  $receiptFile=Get-RegularReaderPath $ReceiptPath
  $receiptStream=[IO.File]::Open($receiptFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    $null=Get-RegularReaderPath $receiptFile
    if($receiptStream.Length -gt 16384){throw 'Reader receipt byte bound'}
    $textReader=[IO.StreamReader]::new($receiptStream,[Text.UTF8Encoding]::new($false,$true),$false,1024,$true)
    try {$receipt=$textReader.ReadToEnd() | ConvertFrom-Json -NoEnumerate} finally {$textReader.Dispose()}
  } finally {$receiptStream.Dispose()}
  if($receipt -isnot [System.Management.Automation.PSCustomObject]){throw 'Reader receipt shape refused'}
  foreach($field in @('contract','name','guid','provider')){
    if($receipt.$field -isnot [string]){throw 'Reader receipt field refused'}
  }
  $provider=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289'
  $name='OpenClaw-Owned-FileIO-'+$ExpectedGuid.ToString('N')
  $rawPath=[IO.Path]::Combine([IO.Path]::GetDirectoryName($receiptFile),'private-host-events.etl')
  if($receipt.contract -cne 'owned-fileio-v1' -or $receipt.name -cne $name -or
      $receipt.guid -cne $ExpectedGuid.ToString() -or $receipt.provider -cne $provider.ToString() -or
      $receipt.raw -isnot [string] -or -not [string]::Equals($receipt.raw,$rawPath,[StringComparison]::OrdinalIgnoreCase)){
    throw 'Reader custody refused'
  }
  $null=Get-RegularReaderPath $rawPath
  $relevant=@{};$matched=@{}
  foreach($id in @(10,11,12,13,14,15,17,18,24,26)){$relevant[[string]$id]=0;$matched[[string]$id]=0}
  $enumerated=0
  $readerStream=[IO.File]::Open($rawPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    $null=Get-RegularReaderPath $rawPath
    if($readerStream.Length -ge 8MB){throw 'Reader ETL byte bound'}
    # The same cmdlet owns decoding/message formatting; only fixed header counts leave this reader.
    # Empty-log or formatting errors remain failures under the existing Stop preference.
    Get-WinEvent -Path $rawPath -Oldest -MaxEvents 20001 | ForEach-Object {
      $event=$_
      try {
        $enumerated++
        if($enumerated -gt 20000){throw 'Reader event bound'}
        if($event.ProviderId -ne $provider){return}
        $key=[string]$event.Id
        if(-not $relevant.ContainsKey($key)){return}
        $relevant[$key]++
        if($event.ProcessId -eq $TargetProcessId){$matched[$key]++}
      } finally {$event.Dispose()}
    }
  } finally {$readerStream.Dispose()}
  $record=[ordered]@{
    phase='same-etl-reader';diagnosticOnly=$true
    runtime=@{psVersion=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;
      clrVersion=[Environment]::Version.ToString();is64BitProcess=[Environment]::Is64BitProcess}
    relevantEventCounts=$relevant;headerPidMatchCounts=$matched
  }
  $json=$record | ConvertTo-Json -Depth 4 -Compress
  if([Text.Encoding]::UTF8.GetByteCount($json) -gt 4096){throw 'Reader output byte bound'}
  [Console]::Out.WriteLine($json)
} catch {
  exit 2
}
