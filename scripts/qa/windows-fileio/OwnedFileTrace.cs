using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class OwnedFileTrace {
  [StructLayout(LayoutKind.Sequential)] public struct Wnode {
    public uint BufferSize, ProviderId;
    public ulong HistoricalContext;
    public long TimeStamp;
    public Guid Guid;
    public uint ClientContext, Flags;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Properties {
    public Wnode Wnode;
    public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize;
    public uint LogFileMode, FlushTimer, EnableFlags;
    public int AgeLimit;
    public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten;
    public uint LogBuffersLost, RealTimeBuffersLost;
    public IntPtr LoggerThreadId;
    public uint LogFileNameOffset, LoggerNameOffset;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint StartTraceW(out ulong handle, string name, IntPtr properties);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint ControlTraceW(ulong handle, string name, IntPtr properties, uint code);
  [DllImport("advapi32.dll")] static extern uint EnableTraceEx2(ulong handle, ref Guid provider, uint code, byte level, ulong any, ulong all, uint timeout, IntPtr parameters);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FileTime create, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessIdOfThread(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetThreadTimes(IntPtr handle, out FileTime create, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint millis);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint QueryDosDeviceW(string device, StringBuilder target, int length);
  static long Stamp(FileTime value) { return unchecked((long)(((ulong)value.High << 32) | value.Low)); }
  static IntPtr Allocate(Guid guid, string name, string file, bool create) {
    int size = Marshal.SizeOf(typeof(Properties));
    int bytes = size + 4096 + 4096;
    IntPtr memory = Marshal.AllocHGlobal(bytes);
    Marshal.Copy(new byte[bytes], 0, memory, bytes);
    Properties p = new Properties();
    p.Wnode.BufferSize = (uint)bytes;
    p.Wnode.Guid = guid;
    p.Wnode.Flags = 0x20000;
    p.Wnode.ClientContext = 2; // System time, matching EventLogRecord.TimeCreated.
    p.LoggerNameOffset = (uint)size;
    p.LogFileNameOffset = (uint)(size + 4096);
    if (create) {
      p.BufferSize = 64;
      p.MinimumBuffers = 4;
      p.MaximumBuffers = 16;
      p.MaximumFileSize = 8;
      p.LogFileMode = 1 | 0x10000000; // Sequential file + no per-CPU buffering.
      p.FlushTimer = 1;
    }
    Marshal.StructureToPtr(p, memory, false);
    byte[] n = Encoding.Unicode.GetBytes(name + "\0");
    byte[] f = Encoding.Unicode.GetBytes(file + "\0");
    if (n.Length > 4096 || f.Length > 4096) { Marshal.FreeHGlobal(memory); throw new ArgumentException("Trace path too long"); }
    Marshal.Copy(n, 0, IntPtr.Add(memory, size), n.Length);
    Marshal.Copy(f, 0, IntPtr.Add(memory, size + 4096), f.Length);
    return memory;
  }
  public static ulong Start(string name, Guid guid, string file) {
    IntPtr memory = Allocate(guid, name, file, true);
    try { ulong handle; uint result = StartTraceW(out handle, name, memory); if(result != 0) throw new Win32Exception((int)result); return handle; }
    finally { Marshal.FreeHGlobal(memory); }
  }
  public static Properties Query(string name, Guid expected) {
    if(expected == Guid.Empty) throw new ArgumentException("Expected session GUID required");
    // Query must populate identity; never let an untouched input validate itself.
    IntPtr memory = Allocate(Guid.Empty, name, "", false);
    try {
      uint result = ControlTraceW(0, name, memory, 0);
      if(result != 0) throw new Win32Exception((int)result);
      Properties p = (Properties)Marshal.PtrToStructure(memory, typeof(Properties));
      if(p.Wnode.Guid != expected || p.Wnode.HistoricalContext == 0)
        throw new InvalidOperationException("Trace ownership missing or mismatched");
      return p;
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public struct StopResult {
    public uint Status;
    public bool StatisticsKnown;
    public Properties Statistics;
  }
  public static StopResult Stop(string name, Guid expected) {
    // Query live GUID and use the returned exact handle, never a name-only stop.
    Properties live = Query(name, expected);
    if(live.Wnode.HistoricalContext == 0) throw new InvalidOperationException("Missing live trace handle");
    IntPtr memory = Allocate(expected, name, "", false);
    try {
      uint result = ControlTraceW(live.Wnode.HistoricalContext, null, memory, 1);
      if(result != 0 && result != 234) throw new Win32Exception((int)result);
      return new StopResult {
        Status = result,
        StatisticsKnown = result == 0,
        Statistics = result == 0 ? (Properties)Marshal.PtrToStructure(memory, typeof(Properties)) : new Properties()
      };
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public static void Enable(string name, Guid expected, Guid provider) {
    Properties live = Query(name, expected);
    if(live.Wnode.HistoricalContext == 0) throw new InvalidOperationException("Missing live trace handle");
    // No generic PID scope filter: it excludes kernel-mode providers.
    uint result = EnableTraceEx2(live.Wnode.HistoricalContext, ref provider, 1, 5, ulong.MaxValue, 0, 500, IntPtr.Zero);
    if(result != 0) throw new Win32Exception((int)result);
  }
  public static IntPtr HoldProcess(uint pid, long expectedCreate) {
    IntPtr handle = OpenProcess(0x1000 | 0x100000, false, pid);
    if(handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    FileTime c,e,k,u;
    if(!GetProcessTimes(handle,out c,out e,out k,out u)) {
      int error=Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(error);
    }
    if(Stamp(c) != expectedCreate) { CloseHandle(handle); throw new InvalidOperationException("Target creation identity mismatch"); }
    if(WaitForSingleObject(handle,0) != 258) { CloseHandle(handle); throw new InvalidOperationException("Target identity unavailable"); }
    return handle;
  }
  public struct ProcessTimeObservation {
    public bool QuerySucceeded;
    public int? NativeError;
    public bool? CreationMatches, EventNotBeforeCreation, ExitTimePresent, EventNotAfterExit;
    public bool ContainsTime {
      get { return QuerySucceeded && CreationMatches == true && EventNotBeforeCreation == true
        && (ExitTimePresent == false || EventNotAfterExit == true); }
    }
  }
  public sealed class ThreadLease : IDisposable {
    readonly Dictionary<uint,IntPtr> handles = new Dictionary<uint,IntPtr>();
    readonly uint pid;
    readonly long processCreate;
    readonly IntPtr originalProcess;
    // Caller retains the original process handle until this lease is disposed.
    public ThreadLease(uint target, long created, IntPtr processHandle) {
      pid=target; processCreate=created; originalProcess=processHandle;
      try { Refresh(); } catch { Dispose(); throw; }
    }
    public ProcessTimeObservation ObserveProcessTime(long eventTime) {
      FileTime c,e,k,u;
      if(!GetProcessTimes(originalProcess,out c,out e,out k,out u)) {
        return new ProcessTimeObservation { QuerySucceeded=false, NativeError=Marshal.GetLastWin32Error() };
      }
      long created=Stamp(c), exited=Stamp(e);
      return new ProcessTimeObservation {
        QuerySucceeded=true, NativeError=null, CreationMatches=created == processCreate,
        EventNotBeforeCreation=eventTime >= created, ExitTimePresent=exited != 0,
        EventNotAfterExit=exited == 0 ? (bool?)null : eventTime <= exited
      };
    }
    public bool ProcessContainsTime(long eventTime) { return ObserveProcessTime(eventTime).ContainsTime; }
    public void Refresh() {
      IntPtr checkedProcess = HoldProcess(pid,processCreate);
      try {
        using(Process process = Process.GetProcessById((int)pid)) {
          foreach(ProcessThread thread in process.Threads) {
            using(thread) {
              uint tid = (uint)thread.Id;
              if(handles.ContainsKey(tid)) continue;
              if(handles.Count >= 256) throw new InvalidOperationException("Thread limit");
              IntPtr handle = OpenThread(0x800, false, tid);
              if(handle == IntPtr.Zero) continue;
              bool admitted = false;
              try {
                // Revalidate after opening the thread; a replacement PID must
                // not contribute handles even if enumeration raced target exit.
                IntPtr current = HoldProcess(pid,processCreate);
                CloseHandle(current);
                FileTime c,e,k,u;
                if(GetProcessIdOfThread(handle) != pid || !GetThreadTimes(handle,out c,out e,out k,out u)
                  || !ProcessContainsTime(Stamp(c))) continue;
                handles.Add(tid,handle);
                admitted = true;
              } finally { if(!admitted) CloseHandle(handle); }
            }
          }
        }
      } finally { CloseHandle(checkedProcess); }
    }
    public bool BelongsAt(uint tid,long eventTime) {
      IntPtr handle;
      if(!handles.TryGetValue(tid,out handle)) return false;
      FileTime c,e,k,u;
      return ProcessContainsTime(eventTime) && GetProcessIdOfThread(handle) == pid && GetThreadTimes(handle,out c,out e,out k,out u)
        && Stamp(c) >= processCreate && Stamp(c) <= eventTime && (Stamp(e) == 0 || Stamp(e) >= eventTime);
    }
    public void Dispose() { foreach(IntPtr handle in handles.Values) CloseHandle(handle); handles.Clear(); }
  }
  public static string Device(string drive) {
    StringBuilder value = new StringBuilder(4096);
    if(QueryDosDeviceW(drive,value,value.Capacity) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    return value.ToString();
  }
}
