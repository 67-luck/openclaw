# Executes the control's compiled process block and actual PowerShell emitter with
# deterministic child/native boundaries. This is diagnostic, not Windows API proof.
param([string]$SourcePath=(Join-Path $PSScriptRoot 'Inspect-LifetimeControl.ps1'))
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $SourcePath),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Control source parse failed'}
$outer=$ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]} | Select-Object -First 1
$literal=$outer.Find({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('using System;')},$true)
if(-not $literal){throw 'Compiled control boundary missing'}
$control=$literal.Value
$threadBoundary=$control.IndexOf('    using(ManualResetEvent ready=')
if($threadBoundary -lt 0){throw 'Thread-control boundary missing'}
$control=$control.Substring(0,$threadBoundary)+"    Stage=`"complete`";`n  }`n}"
$control=$control.Replace('using System.Diagnostics;',"using System.Diagnostics;`nusing Process=LifetimeDiagnosticFixture.Child;")
$native=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'OwnedFileTrace.cs'))
$structStart=$native.IndexOf('  public struct ProcessTimeObservation {')
$structEnd=$native.IndexOf('  public sealed class ThreadLease', $structStart)
if($structStart -lt 0 -or $structEnd -lt 0){throw 'Native observation contract missing'}
$fixtures=@'
namespace LifetimeDiagnosticFixture {
  public static class State {
    public static string Scenario;
    public static bool Exited;
    public static int Releases,Joins,Disposals,LeaseDisposals,Closes,Observations;
    public static long LiveTime;
    public static System.DateTime ExitTime;
    public static void Reset(string scenario) {
      Scenario=scenario;Exited=false;Releases=Joins=Disposals=LeaseDisposals=Closes=Observations=0;
    }
  }
  public sealed class Input : System.IO.StringWriter {
    public override void WriteLine(string value) {
      if(value != "release")throw new System.Exception("PRIVATE_BAD_INPUT");
      State.Releases++;State.Exited=true;State.ExitTime=System.DateTime.UtcNow;
    }
  }
  public sealed class Child : System.IDisposable {
    public System.Diagnostics.ProcessStartInfo StartInfo {get;set;}
    public bool Start(){return true;}
    public System.IO.StringReader StandardOutput=new System.IO.StringReader("lifetime-ready\n");
    public Input StandardInput=new Input();
    public System.DateTime StartTime {get{return System.DateTime.FromFileTimeUtc(100);}}
    public System.DateTime ExitTime {get{return State.ExitTime;}}
    public int Id {get{return 1234;}}
    public int ExitCode {get{return 0;}}
    public bool HasExited {get{return State.Exited;}}
    public void WaitForExit(){if(!State.Exited)throw new System.Exception("PRIVATE_NOT_RELEASED");State.Joins++;}
    public void Dispose(){State.Disposals++;}
  }
}
public static class OwnedFileTrace {
  public enum ProcessAdmissionState {Exited}
  public struct Admission {public ProcessAdmissionState State;}
  public static System.IntPtr HoldProcess(uint pid,long created) {
    if(LifetimeDiagnosticFixture.State.Scenario=="before-observation")throw new System.Exception("PRIVATE_NATIVE_EXCEPTION");
    return new System.IntPtr(1);
  }
  public static bool CloseHandle(System.IntPtr handle){LifetimeDiagnosticFixture.State.Closes++;return true;}
  public sealed class ThreadLease : System.IDisposable {
    public ThreadLease(uint pid,long created,System.IntPtr handle){}
    public Admission ObserveProjectionAdmission(){return new Admission {State=ProcessAdmissionState.Exited};}
    public ProcessTimeObservation ObserveProcessTime(long time) {
      string scenario=LifetimeDiagnosticFixture.State.Scenario;
      if(++LifetimeDiagnosticFixture.State.Observations==1) {
        LifetimeDiagnosticFixture.State.LiveTime=time;
        if(scenario=="query-threw")throw new System.Exception("PRIVATE_NATIVE_EXCEPTION");
        if(scenario=="early-exit") {
          LifetimeDiagnosticFixture.State.Exited=true;
          LifetimeDiagnosticFixture.State.ExitTime=System.DateTime.UtcNow;
        }
        if(scenario=="query-failed")return new ProcessTimeObservation {QuerySucceeded=false};
        return new ProcessTimeObservation {QuerySucceeded=true,CreationMatches=scenario!="creation-mismatch",
          EventNotBeforeCreation=true,ExitTimePresent=false,EventNotAfterExit=null};
      }
      return new ProcessTimeObservation {QuerySucceeded=true,CreationMatches=true,EventNotBeforeCreation=true,
        ExitTimePresent=true,EventNotAfterExit=time==LifetimeDiagnosticFixture.State.LiveTime};
    }
    public void Dispose(){LifetimeDiagnosticFixture.State.LeaseDisposals++;}
  }
'@ + $native.Substring($structStart,$structEnd-$structStart) + "`n}"
Add-Type -TypeDefinition ($control+"`n"+$fixtures)
foreach($function in $ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}) {
  Invoke-Expression $function.Extent.Text
}
$currentStatement=$outer.Body.Statements | Where-Object {
  $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$current'
} | Select-Object -First 1
if(-not $currentStatement){throw 'Control invocation boundary missing'}
$source=[IO.File]::ReadAllText((Resolve-Path $SourcePath))
$tail=$source.Substring($currentStatement.Extent.StartOffset,$outer.Body.Extent.EndOffset-1-$currentStatement.Extent.StartOffset)
$catch=$outer.CatchClauses.Extent.Text -join "`n"
if([regex]::Matches($catch,'(?m)^  exit 2$').Count -ne 1){throw 'Failure exit boundary changed'}
$catch=$catch.Replace('  exit 2','  $script:capturedExit=2')
$entry=[scriptblock]::Create("try {`n"+$tail+"`n}`n"+$catch)
$failed=0
foreach($scenario in @('before-observation','query-threw','query-failed','creation-mismatch','early-exit','live')) {
  [LifetimeDiagnosticFixture.State]::Reset($scenario)
  foreach($field in [FileTraceLifetimeControl].GetFields() | Where-Object {$_.FieldType -eq [Nullable[bool]]}){$field.SetValue($null,$null)}
  [FileTraceLifetimeControl]::Stage='process-start'
  $stage='compile-control';$script:capturedExit=0;$ExpectedSourceSha256='source';$ExpectedDllSha256='dll'
  $output=(& $entry | Out-String).Trim()
  $record=$output | ConvertFrom-Json
  $expected=@{childHasExited=$null;callCompleted=$null;querySucceeded=$null;creationMatches=$null;
    eventNotBeforeCreation=$null;exitTimePresent=$null;eventNotAfterExit=$null;containsTime=$null}
  if($scenario -ne 'before-observation'){$expected.callCompleted=$scenario -ne 'query-threw'}
  if($scenario -notin @('before-observation','query-threw')) {
    $expected.childHasExited=$scenario -eq 'early-exit';$expected.querySucceeded=$scenario -ne 'query-failed'
    $expected.containsTime=$scenario -notin @('query-failed','creation-mismatch')
    if($scenario -ne 'query-failed') {
      $expected.creationMatches=$scenario -ne 'creation-mismatch';$expected.eventNotBeforeCreation=$true;$expected.exitTimePresent=$false
    }
  }
  $factsCorrect=$null -ne $record.processLiveObservation
  foreach($key in $expected.Keys) {
    $property=if($null -ne $record.processLiveObservation){$record.processLiveObservation.PSObject.Properties[$key]}else{$null}
    if(-not $property -or $property.Value -cne $expected[$key]){$factsCorrect=$false}
  }
  $released=[LifetimeDiagnosticFixture.State]::Releases -eq $(if($scenario -eq 'early-exit'){0}else{1})
  $cleanup=[LifetimeDiagnosticFixture.State]::Joins -eq $(if($scenario -eq 'live'){2}else{1}) -and [LifetimeDiagnosticFixture.State]::Disposals -eq 1 -and
    [LifetimeDiagnosticFixture.State]::Closes -eq $(if($scenario -eq 'before-observation'){0}else{1}) -and
    [LifetimeDiagnosticFixture.State]::LeaseDisposals -eq $(if($scenario -eq 'before-observation'){0}else{1})
  $passed=$factsCorrect -and $released -and $cleanup -and $record.passed -eq ($scenario -eq 'live') -and
    $script:capturedExit -eq $(if($scenario -eq 'live'){0}else{2}) -and -not $output.Contains('PRIVATE_')
  if(-not $passed){$failed++}
  @{scenario=$scenario;passed=$passed;factsCorrect=$factsCorrect;naturalReleaseCorrect=$released;
    cleanupCorrect=$cleanup;nativeProof=$false;controlSha256=(Get-FileHash $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress
}
if($failed){throw "Lifetime diagnostic contract failures: $failed"}
