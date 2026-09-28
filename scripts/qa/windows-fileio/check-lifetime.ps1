# Exercise the actual C# lifetime entry points with only Win32 API declarations
# replaced by deterministic API-contract responses. No Windows proof is claimed.
param([string]$SourcePath=(Join-Path $PSScriptRoot 'OwnedFileTrace.cs'))
$ErrorActionPreference='Stop'
$native=[IO.File]::ReadAllText((Resolve-Path $SourcePath))
$sourceHash=(Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$fixtures=@'
  public static uint FixturePid=(uint)Process.GetCurrentProcess().Id;
  public static uint FixtureProcessWait=258, FixtureThreadWait=258, FixtureThreadAccess;
  public static long FixtureProcessCreate=100, FixtureThreadCreate=200;
  public static long FixtureProcessExit=0, FixtureThreadExit=0;
  public static bool FixtureProcessQuery=true, FixtureThreadQuery=true, FixtureForeignThread=false;
  public static readonly List<string> FixtureCalls=new List<string>();
  public static readonly List<uint> FixtureOpenedThreads=new List<uint>();
  public static void FixtureReset() {
    FixtureProcessWait=258; FixtureThreadWait=258; FixtureProcessCreate=100; FixtureThreadCreate=200;
    FixtureProcessExit=0; FixtureThreadExit=0; FixtureProcessQuery=true; FixtureThreadQuery=true;
    FixtureForeignThread=false; FixtureCalls.Clear();
  }
  static FileTime FixtureTime(long value) {
    return new FileTime { Low=(uint)value, High=(uint)((ulong)value >> 32) };
  }
'@
$native=$native.Replace('public static class OwnedFileTrace {',"public static class OwnedFileTrace {`n"+$fixtures)
$replacements=@{
  OpenProcess='static IntPtr OpenProcess(uint access,bool inherit,uint pid) { return new IntPtr(1); }'
  GetProcessTimes=@'
static bool GetProcessTimes(IntPtr handle,out FileTime c,out FileTime e,out FileTime k,out FileTime u) {
  FixtureCalls.Add("process-times"); c=FixtureTime(FixtureProcessCreate); e=FixtureTime(FixtureProcessExit);
  k=FixtureTime(0);u=FixtureTime(0);return FixtureProcessQuery;
}
'@
  OpenThread='static IntPtr OpenThread(uint access,bool inherit,uint tid) { FixtureThreadAccess=access;FixtureOpenedThreads.Add(tid);return new IntPtr((long)tid+2); }'
  GetProcessIdOfThread='static uint GetProcessIdOfThread(IntPtr handle) { return FixtureForeignThread ? FixturePid+1 : FixturePid; }'
  GetThreadTimes=@'
static bool GetThreadTimes(IntPtr handle,out FileTime c,out FileTime e,out FileTime k,out FileTime u) {
  FixtureCalls.Add("thread-times");c=FixtureTime(FixtureThreadCreate);e=FixtureTime(FixtureThreadExit);
  k=FixtureTime(0);u=FixtureTime(0);return FixtureThreadQuery;
}
'@
  WaitForSingleObject='static uint WaitForSingleObject(IntPtr handle,uint millis) { FixtureCalls.Add(handle.ToInt64()==1 ? "process-wait" : "thread-wait"); return handle.ToInt64()==1 ? FixtureProcessWait : FixtureThreadWait; }'
  CloseHandle='public static bool CloseHandle(IntPtr handle) { return true; }'
}
foreach($name in $replacements.Keys) {
  $pattern='(?m)^\s*\[DllImport\([^\r\n]+\)\] (?:public )?static extern [^\r\n]*\b'+$name+'\([^\r\n]+;'
  $matches=[regex]::Matches($native,$pattern)
  if($matches.Count -ne 1){throw "Native declaration boundary changed: $name"}
  $native=$native.Replace($matches[0].Value,"`n  "+$replacements[$name])
}
Add-Type -TypeDefinition $native
$lease=[OwnedFileTrace+ThreadLease]::new([OwnedFileTrace]::FixturePid,100,[IntPtr]::new(1))
if([OwnedFileTrace]::FixtureOpenedThreads.Count -eq 0){throw 'Current-process thread fixture unavailable'}
$tid=[OwnedFileTrace]::FixtureOpenedThreads[0]
$missingTid=[uint32]::MaxValue
while([OwnedFileTrace]::FixtureOpenedThreads.Contains($missingTid)){$missingTid--}
$failed=0
try {
  foreach($case in @(
    @{name='process-live-undefined-exit';scope='process';exit=50;expected=$true;present=$false}
    @{name='process-live-future-undefined-exit';scope='process';exit=900;expected=$true;present=$false}
    @{name='process-exited-inside';scope='process';wait=0;exit=400;expected=$true;present=$true}
    @{name='process-exited-outside';scope='process';wait=0;exit=250;expected=$false;present=$true}
    @{name='process-signaled-zero-exit';scope='process';wait=0;expected=$false;present=$true}
    @{name='process-wait-failed';scope='process';wait=[uint32]::MaxValue;expected=$false;present=$null}
    @{name='process-wait-unexpected';scope='process';wait=128;expected=$false;present=$null}
    @{name='process-query-failed';scope='process';query=$false;expected=$false;present=$null}
    @{name='process-creation-mismatch';scope='process';create=101;expected=$false;present=$false}
    @{name='process-before-creation';scope='process';event=99;expected=$false;present=$false}
    @{name='thread-live-undefined-exit';scope='thread';exit=150;expected=$true}
    @{name='thread-exited-inside';scope='thread';wait=0;exit=400;expected=$true}
    @{name='thread-exited-outside';scope='thread';wait=0;exit=250;expected=$false}
    @{name='thread-signaled-zero-exit';scope='thread';wait=0;expected=$false}
    @{name='thread-wait-failed';scope='thread';wait=[uint32]::MaxValue;expected=$false}
    @{name='thread-wait-unexpected';scope='thread';wait=128;expected=$false}
    @{name='thread-query-failed';scope='thread';query=$false;expected=$false}
    @{name='thread-created-before-original';scope='thread';create=99;expected=$false}
    @{name='thread-created-after-event';scope='thread';create=400;expected=$false}
    @{name='thread-foreign-owner';scope='thread';foreign=$true;expected=$false}
    @{name='thread-after-process-exit';scope='thread';processExit=250;expected=$false}
    @{name='thread-missing-handle';scope='thread';missing=$true;expected=$false}
  )) {
    [OwnedFileTrace]::FixtureReset()
    $time=if($case.ContainsKey('event')){[long]$case.event}else{300L}
    $wait=if($case.ContainsKey('wait')){[uint32]$case.wait}else{[uint32]258}
    $exit=if($case.ContainsKey('exit')){[long]$case.exit}else{0L}
    $query=if($case.ContainsKey('query')){[bool]$case.query}else{$true}
    if($case.scope -eq 'process') {
      [OwnedFileTrace]::FixtureProcessWait=$wait;[OwnedFileTrace]::FixtureProcessExit=$exit
      [OwnedFileTrace]::FixtureProcessQuery=$query
      if($case.ContainsKey('create')){[OwnedFileTrace]::FixtureProcessCreate=$case.create}
      $fact=$lease.ObserveProcessTime($time)
      $actual=$fact.ContainsTime
      $factsCorrect=$fact.ExitTimePresent -eq $case.present -and $fact.QuerySucceeded -eq $query
      $calls=@([OwnedFileTrace]::FixtureCalls.ToArray())
      $ordered=$calls.Count -ge 2 -and $calls[0] -eq 'process-wait' -and $calls[1] -eq 'process-times'
    } else {
      [OwnedFileTrace]::FixtureThreadWait=$wait;[OwnedFileTrace]::FixtureThreadExit=$exit
      [OwnedFileTrace]::FixtureThreadQuery=$query;[OwnedFileTrace]::FixtureForeignThread=[bool]$case.foreign
      if($case.ContainsKey('create')){[OwnedFileTrace]::FixtureThreadCreate=$case.create}
      if($case.ContainsKey('processExit')){[OwnedFileTrace]::FixtureProcessWait=0;[OwnedFileTrace]::FixtureProcessExit=$case.processExit}
      $actual=$lease.BelongsAt($(if($case.missing){$missingTid}else{$tid}),$time)
      $calls=@([OwnedFileTrace]::FixtureCalls.ToArray())
      $threadQuery=[Array]::IndexOf($calls,'thread-times');$threadWait=[Array]::IndexOf($calls,'thread-wait')
      $ordered=$threadQuery -lt 0 -or ($threadWait -ge 0 -and $threadWait -lt $threadQuery)
      $factsCorrect=([OwnedFileTrace]::FixtureThreadAccess -band 0x100000) -ne 0
    }
    $passed=$actual -eq $case.expected -and $factsCorrect -and $ordered
    if(-not $passed){$failed++}
    @{scenario=$case.name;passed=$passed;containsTime=$actual;expected=$case.expected;
      factsCorrect=$factsCorrect;waitBeforeTimes=$ordered;nativeProof=$false;sourceSha256=$sourceHash} | ConvertTo-Json -Compress
  }
} finally {$lease.Dispose()}
if($failed){throw "Lifetime API contract failures: $failed"}
