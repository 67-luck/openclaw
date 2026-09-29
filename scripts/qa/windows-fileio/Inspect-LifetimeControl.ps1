# Genuine API controls only; the existing managed command owns the entire process
# tree and its deadline. This runs before the FileIO capture, never inside it.
param(
  [Parameter(Mandatory)][string]$DllPath,
  [Parameter(Mandatory)][string]$ExpectedDllSha256,
  [Parameter(Mandatory)][string]$ExpectedSourceSha256,
  [Parameter(Mandatory)][string]$NodeExe,
  [Parameter(Mandatory)][string]$ExpectedNodeSha256,
  [Parameter(Mandatory)][string]$ExpectedFixtureSha256,
  [Parameter(Mandatory)][string]$ExpectedFixtureInputSha256
)
$ErrorActionPreference='Stop'
$stage='binding'
function Get-ProcessLiveObservation {
  $fields=@{childHasExited='ChildHasExited';callCompleted='ObservationCallCompleted';querySucceeded='QuerySucceeded';
    creationMatches='CreationMatches';eventNotBeforeCreation='EventNotBeforeCreation';exitTimePresent='ExitTimePresent';
    eventNotAfterExit='EventNotAfterExit';containsTime='ContainsTime'}
  $type='FileTraceLifetimeControl' -as [type]
  $facts=@{}
  foreach($key in $fields.Keys) {
    $facts[$key]=if($type){$type.GetField($fields[$key]).GetValue($null)}else{$null}
  }
  return $facts
}
function Get-TerminalInputFailure {
  $type='FileTraceLifetimeControl' -as [type]
  if($type){return $type.GetField('TerminalInputFailure').GetValue($null)}
  return $null
}
function Assert-LifetimeBindings($Bindings) {
  foreach($pair in $Bindings) {
    $file=Get-Item -LiteralPath $pair[0]
    if($pair[1] -cnotmatch '^[0-9a-f]{64}$' -or $file -isnot [IO.FileInfo] -or
      ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'Native control binding mismatch'}
  }
}
try {
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop' -or
    $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1){throw 'Exact native runtime required'}
  $fixturePath=Join-Path $PSScriptRoot 'lifetime-fixture.cjs'
  $fixtureInputPath=Join-Path $PSScriptRoot 'fixture-input.cjs'
  $bindings=@(@($DllPath,$ExpectedDllSha256),@((Join-Path $PSScriptRoot 'OwnedFileTrace.cs'),$ExpectedSourceSha256),
    @($NodeExe,$ExpectedNodeSha256),@($fixturePath,$ExpectedFixtureSha256),@($fixtureInputPath,$ExpectedFixtureInputSha256))
  Assert-LifetimeBindings $bindings
  Add-Type -LiteralPath $DllPath
  $stage='compile-control'
  $control=@'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class FileTraceLifetimeControl {
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low,High; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenThread(uint access,bool inherit,uint tid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetThreadTimes(IntPtr handle,out FileTime create,out FileTime exit,out FileTime kernel,out FileTime user);
  static long Stamp(FileTime value) { return unchecked((long)(((ulong)value.High << 32) | value.Low)); }
  public static string Stage="process-start";
  public static string TerminalInputFailure;
  public static bool ChildStartAttempted,ChildJoined;
  public static bool? ChildHasExited,ObservationCallCompleted,QuerySucceeded,CreationMatches,
    EventNotBeforeCreation,ExitTimePresent,EventNotAfterExit,ContainsTime;
  static void Require(bool value) { if(!value) throw new InvalidOperationException("Lifetime control assertion failed"); }
  static Exception Combine(Exception first,Exception next) {
    return first == null ? next : new AggregateException(first,next);
  }
  static void ReleaseChild(Process child,ref bool terminalAttempted,ref bool releaseAttempted) {
    bool sendRelease=!releaseAttempted;releaseAttempted=true;
    Exception failure=null;
    try {
      if(!terminalAttempted) {terminalAttempted=true;child.StandardInput.Write("terminal\n");}
      if(sendRelease)child.StandardInput.Write("release\n");
    } catch(Exception error) {failure=error;}
    try {child.StandardInput.Close();} catch(Exception error) {failure=Combine(failure,error);}
    if(failure != null)throw failure;
  }
  public static void Run(string executable,string fixturePath) {
    using(Process child=new Process()) {
      child.StartInfo=new ProcessStartInfo(executable,"\""+fixturePath+"\"") {
        UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,
        RedirectStandardOutput=true,RedirectStandardError=true
      };
      bool started=false,terminalAttempted=false,releaseAttempted=false;
      IntPtr handle=IntPtr.Zero;
      OwnedFileTrace.ThreadLease lease=null;
      Exception processFailure=null;
      try {
        // Framework captures this encoding in StandardInput during Start.
        System.Text.Encoding previousEncoding=Console.InputEncoding;
        Exception startFailure=null;
        bool encodingAttempted=false;
        try {
          encodingAttempted=true;
          Console.InputEncoding=new System.Text.UTF8Encoding(false);
          ChildStartAttempted=true;started=child.Start();Require(started);
        } catch(Exception error) {startFailure=error;}
        finally {
          if(encodingAttempted) {
            try {Console.InputEncoding=previousEncoding;}
            catch(Exception error) {startFailure=Combine(startFailure,error);}
          }
        }
        if(startFailure != null)throw startFailure;
        Stage="process-ready";
        Require(child.StandardOutput.ReadLine() == "lifetime-ready");
        Stage="process-creation";
        long created=child.StartTime.ToUniversalTime().ToFileTimeUtc();
        Stage="process-hold";
        handle=OwnedFileTrace.HoldProcess((uint)child.Id,created);
        Stage="process-lease";
        lease=new OwnedFileTrace.ThreadLease((uint)child.Id,created,handle);
        Stage="process-terminal-write";
        terminalAttempted=true;child.StandardInput.Write("terminal\n");child.StandardInput.Flush();
        Stage="process-terminal-ack";
        string terminalReply=child.StandardOutput.ReadLine();
        switch(terminalReply) {
          case "lifetime-terminal-failure:bom-prefix": TerminalInputFailure="bom-prefix";break;
          case "lifetime-terminal-failure:eof": TerminalInputFailure="eof";break;
          case "lifetime-terminal-failure:mismatch": TerminalInputFailure="mismatch";break;
          case "lifetime-terminal-failure:other": TerminalInputFailure="other";break;
        }
        Require(terminalReply == "lifetime-terminal");
        long liveTime=DateTime.UtcNow.ToFileTimeUtc();
        Stage="process-live";
        ObservationCallCompleted=false;
        OwnedFileTrace.ProcessTimeObservation live=lease.ObserveProcessTime(liveTime);
        ObservationCallCompleted=true;
        QuerySucceeded=live.QuerySucceeded;CreationMatches=live.CreationMatches;
        EventNotBeforeCreation=live.EventNotBeforeCreation;ExitTimePresent=live.ExitTimePresent;
        EventNotAfterExit=live.EventNotAfterExit;ContainsTime=live.ContainsTime;
        bool childHasExited=child.HasExited;ChildHasExited=childHasExited;
        Require(!childHasExited && live.ContainsTime && live.ExitTimePresent == false);
        ReleaseChild(child,ref terminalAttempted,ref releaseAttempted);
        child.WaitForExit();ChildJoined=true;Require(child.ExitCode == 0);
        Stage="process-exited";
        Require(lease.ObserveProjectionAdmission().State == OwnedFileTrace.ProcessAdmissionState.Exited);
        OwnedFileTrace.ProcessTimeObservation inside=lease.ObserveProcessTime(liveTime);
        // Probe the defined boundary without waiting for wall-clock resolution.
        long afterExit=child.ExitTime.ToUniversalTime().ToFileTimeUtc()+1;
        OwnedFileTrace.ProcessTimeObservation outside=lease.ObserveProcessTime(afterExit);
        Require(inside.ContainsTime && inside.ExitTimePresent == true);
        Require(!outside.ContainsTime && outside.ExitTimePresent == true && outside.EventNotAfterExit == false);
      } catch(Exception error) {processFailure=error;}
      finally {
        if(started) {
          try {if(!child.HasExited)ReleaseChild(child,ref terminalAttempted,ref releaseAttempted);}
          catch(Exception error) {processFailure=Combine(processFailure,error);}
          try {child.WaitForExit();ChildJoined=true;}
          catch(Exception error) {processFailure=Combine(processFailure,error);}
        }
        try {if(lease != null)lease.Dispose();}
        catch(Exception error) {processFailure=Combine(processFailure,error);}
        try {if(handle != IntPtr.Zero)OwnedFileTrace.CloseHandle(handle);}
        catch(Exception error) {processFailure=Combine(processFailure,error);}
      }
      if(processFailure != null)throw processFailure;
    }
    using(ManualResetEvent ready=new ManualResetEvent(false))
    using(ManualResetEvent release=new ManualResetEvent(false))
    using(Process self=Process.GetCurrentProcess()) {
      uint tid=0;
      Thread worker=new Thread(delegate() {tid=GetCurrentThreadId();ready.Set();release.WaitOne();});
      worker.IsBackground=true;
      IntPtr handle=IntPtr.Zero;
      IntPtr threadOracle=IntPtr.Zero;
      OwnedFileTrace.ThreadLease lease=null;
      bool started=false;
      try {
        Stage="thread-start";worker.Start();started=true;ready.WaitOne();Require(tid != 0);
        threadOracle=OpenThread(0x800,false,tid);Require(threadOracle != IntPtr.Zero);
        long created=self.StartTime.ToUniversalTime().ToFileTimeUtc();
        handle=OwnedFileTrace.HoldProcess((uint)self.Id,created);
        lease=new OwnedFileTrace.ThreadLease((uint)self.Id,created,handle);
        long liveTime=DateTime.UtcNow.ToFileTimeUtc();
        Stage="thread-live";Require(worker.IsAlive && lease.BelongsAt(tid,liveTime));
        release.Set();worker.Join();Require(!worker.IsAlive);
        Stage="thread-exited";
        Require(lease.ObserveProcessTime(DateTime.UtcNow.ToFileTimeUtc()).ExitTimePresent == false);
        Require(lease.BelongsAt(tid,liveTime));
        FileTime c,e,k,u;
        // Join made this independent oracle's exit time defined.
        Require(GetThreadTimes(threadOracle,out c,out e,out k,out u));
        Require(!lease.BelongsAt(tid,Stamp(e)+1));
      } finally {
        try {release.Set();if(started)worker.Join();}
        finally {
          if(lease != null)lease.Dispose();
          if(handle != IntPtr.Zero)OwnedFileTrace.CloseHandle(handle);
          if(threadOracle != IntPtr.Zero)OwnedFileTrace.CloseHandle(threadOracle);
        }
      }
    }
    Stage="complete";
  }
}
'@
  Add-Type -TypeDefinition $control -ReferencedAssemblies @($DllPath,'System.dll')
  Assert-LifetimeBindings $bindings
  $runFailure=$null
  try {[FileTraceLifetimeControl]::Run($NodeExe,$fixturePath)} catch {$runFailure=$_.Exception}
  if([FileTraceLifetimeControl]::ChildStartAttempted -and -not [FileTraceLifetimeControl]::ChildJoined) {
    if($runFailure){throw $runFailure}
    throw 'Native child join unavailable'
  }
  try {Assert-LifetimeBindings $bindings} catch {
    if($runFailure){throw [AggregateException]::new([Exception[]]@($runFailure,$_.Exception))}
    throw
  }
  if($runFailure){throw $runFailure}
  @{phase='native-lifetime-control';passed=$true;stage='complete';sourceSha256=$ExpectedSourceSha256;
    dllSha256=$ExpectedDllSha256;nodeSha256=$ExpectedNodeSha256;fixtureSha256=$ExpectedFixtureSha256;
    fixtureInputSha256=$ExpectedFixtureInputSha256;processLive=$true;processInsideExit=$true;processAfterExit=$true;
    threadLive=$true;threadInsideExit=$true;threadAfterExit=$true;naturalRelease=$true;
    processLiveObservation=(Get-ProcessLiveObservation);terminalInputFailure=(Get-TerminalInputFailure)} | ConvertTo-Json -Depth 3 -Compress
} catch {
  $controlType='FileTraceLifetimeControl' -as [type]
  if($controlType){$stage=$controlType.GetField('Stage').GetValue($null)}
  @{phase='native-lifetime-control';passed=$false;stage=$stage;
    processLiveObservation=(Get-ProcessLiveObservation);terminalInputFailure=(Get-TerminalInputFailure)} | ConvertTo-Json -Depth 3 -Compress
  exit 2
}
