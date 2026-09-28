# Genuine API controls only; the existing managed command owns the entire process
# tree and its deadline. This runs before the FileIO capture, never inside it.
param(
  [Parameter(Mandatory)][string]$DllPath,
  [Parameter(Mandatory)][string]$ExpectedDllSha256,
  [Parameter(Mandatory)][string]$ExpectedSourceSha256
)
$ErrorActionPreference='Stop'
$stage='binding'
try {
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    -not [Environment]::Is64BitProcess -or $PSVersionTable.PSEdition -cne 'Desktop' -or
    $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1){throw 'Exact native runtime required'}
  foreach($pair in @(@($DllPath,$ExpectedDllSha256),@((Join-Path $PSScriptRoot 'OwnedFileTrace.cs'),$ExpectedSourceSha256))) {
    if($pair[1] -cnotmatch '^[0-9a-f]{64}$' -or
      ((Get-Item -LiteralPath $pair[0]).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'Native control binding mismatch'}
  }
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
  static void Require(bool value) { if(!value) throw new InvalidOperationException("Lifetime control assertion failed"); }
  public static void Run(string executable) {
    using(Process child=new Process()) {
      child.StartInfo=new ProcessStartInfo(executable,
        "-NoProfile -NonInteractive -Command \"[Console]::Out.WriteLine('lifetime-ready');if([Console]::In.ReadLine() -cne 'release'){exit 2}\"") {
        UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,
        RedirectStandardOutput=true,RedirectStandardError=true
      };
      bool started=false,released=false;
      IntPtr handle=IntPtr.Zero;
      OwnedFileTrace.ThreadLease lease=null;
      try {
        started=child.Start();Require(started);
        Stage="process-ready";
        Require(child.StandardOutput.ReadLine() == "lifetime-ready");
        long created=child.StartTime.ToUniversalTime().ToFileTimeUtc();
        handle=OwnedFileTrace.HoldProcess((uint)child.Id,created);
        lease=new OwnedFileTrace.ThreadLease((uint)child.Id,created,handle);
        long liveTime=DateTime.UtcNow.ToFileTimeUtc();
        Stage="process-live";
        OwnedFileTrace.ProcessTimeObservation live=lease.ObserveProcessTime(liveTime);
        Require(!child.HasExited && live.ContainsTime && live.ExitTimePresent == false);
        child.StandardInput.WriteLine("release");child.StandardInput.Close();released=true;
        child.WaitForExit();Require(child.ExitCode == 0);
        Stage="process-exited";
        Require(lease.ObserveProjectionAdmission().State == OwnedFileTrace.ProcessAdmissionState.Exited);
        OwnedFileTrace.ProcessTimeObservation inside=lease.ObserveProcessTime(liveTime);
        // Probe the defined boundary without waiting for wall-clock resolution.
        long afterExit=child.ExitTime.ToUniversalTime().ToFileTimeUtc()+1;
        OwnedFileTrace.ProcessTimeObservation outside=lease.ObserveProcessTime(afterExit);
        Require(inside.ContainsTime && inside.ExitTimePresent == true);
        Require(!outside.ContainsTime && outside.ExitTimePresent == true && outside.EventNotAfterExit == false);
      } finally {
        try {
          if(started) {
            if(!released && !child.HasExited) {child.StandardInput.WriteLine("release");child.StandardInput.Close();}
            child.WaitForExit();
          }
        } finally {
          if(lease != null)lease.Dispose();
          if(handle != IntPtr.Zero)OwnedFileTrace.CloseHandle(handle);
        }
      }
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
  $current=[Diagnostics.Process]::GetCurrentProcess()
  try {[FileTraceLifetimeControl]::Run($current.MainModule.FileName)} finally {$current.Dispose()}
  @{phase='native-lifetime-control';passed=$true;stage='complete';sourceSha256=$ExpectedSourceSha256;
    dllSha256=$ExpectedDllSha256;processLive=$true;processInsideExit=$true;processAfterExit=$true;
    threadLive=$true;threadInsideExit=$true;threadAfterExit=$true;naturalRelease=$true} | ConvertTo-Json -Compress
} catch {
  $controlType='FileTraceLifetimeControl' -as [type]
  if($controlType){$stage=$controlType.GetField('Stage').GetValue($null)}
  @{phase='native-lifetime-control';passed=$false;stage=$stage} | ConvertTo-Json -Compress
  exit 2
}
