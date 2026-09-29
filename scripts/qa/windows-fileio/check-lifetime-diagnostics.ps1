# Executes the control's compiled process block and actual PowerShell emitter with
# deterministic child/native boundaries. This is diagnostic, not Windows API proof.
param([string]$SourcePath=(Join-Path $PSScriptRoot 'Inspect-LifetimeControl.ps1'),
  [string]$RealNodeExe,[string]$RealFixturePath,[string]$BindingProbePath)
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
$realControl=[regex]::Replace($control,'(?m)^using [^\r\n]+;\r?\n','')
$realControl=[regex]::Replace($realControl,'\bProcess\b','System.Diagnostics.Process')
$realControl=[regex]::Replace($realControl,'\bConsole\b','System.Console')
$realControl=$realControl.Replace('FileTraceLifetimeControl','FileTraceLifetimeControlReal')
# Test-copy observation after the owner's real wait, without changing its decision.
$realControl=$realControl.Replace('child.WaitForExit();','child.WaitForExit();LifetimeDiagnosticFixture.State.JoinedExitZero=child.ExitCode==0;')
$control=$control.Replace('using System.Diagnostics;',"using System.Diagnostics;`nusing Process=LifetimeDiagnosticFixture.Child;`nusing Console=LifetimeDiagnosticFixture.ConsoleState;")
$native=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'OwnedFileTrace.cs'))
$structStart=$native.IndexOf('  public struct ProcessTimeObservation {')
$structEnd=$native.IndexOf('  public sealed class ThreadLease', $structStart)
if($structStart -lt 0 -or $structEnd -lt 0){throw 'Native observation contract missing'}
$fixtures=@'
namespace LifetimeDiagnosticFixture {
  public static class State {
    public static string Scenario;
    public static bool Exited,JoinedExitZero;
    public static int Starts,Releases,Joins,Disposals,LeaseDisposals,Closes,Observations;
    public static System.Action AfterWait;
    public static System.Text.Encoding PriorEncoding,CurrentEncoding,WriterEncoding;
    public static int EncodingGets,EncodingSets;
    public static bool ReadyReadRestored;

    public static long LiveTime;
    public static System.DateTime ExitTime;
    public static void Reset(string scenario) {
      PriorEncoding=new System.Text.UTF8Encoding(true);CurrentEncoding=PriorEncoding;WriterEncoding=null;
      EncodingGets=EncodingSets=0;ReadyReadRestored=true;
      Scenario=scenario;Exited=false;JoinedExitZero=false;AfterWait=null;Starts=Releases=Joins=Disposals=LeaseDisposals=Closes=Observations=0;
    }
  }
  public static class ConsoleState {
    public static System.Text.Encoding InputEncoding {
      get {
        State.EncodingGets++;
        if(State.Scenario=="encoding-get-failed")throw new System.IO.IOException("PRIVATE_ENCODING_GET");
        return State.CurrentEncoding;
      }
      set {
        State.EncodingSets++;
        if(State.EncodingSets==1) {
          State.CurrentEncoding=(System.Text.Encoding)value.Clone();
          if(State.Scenario=="encoding-set-failed" || State.Scenario=="encoding-set-and-restore-failed")
            throw new System.IO.IOException("PRIVATE_ENCODING_SET");
        } else {
          if(State.Scenario=="encoding-restore-failed" || State.Scenario=="start-and-restore-failed" || State.Scenario=="encoding-set-and-restore-failed")
            throw new System.IO.IOException("PRIVATE_ENCODING_RESTORE");
          State.CurrentEncoding=(System.Text.Encoding)value.Clone();
        }
      }
    }
  }
  public sealed class Input : System.IO.StringWriter {
    public override void Write(string value) {
      if(value == "terminal\n") {if(State.Scenario=="terminal-write-failed")throw new System.IO.IOException("PRIVATE_TERMINAL_WRITE");return;}
      if(value != "release\n")throw new System.Exception("PRIVATE_BAD_INPUT");
      State.Releases++;State.Exited=true;State.ExitTime=System.DateTime.UtcNow;
      if(State.Scenario=="query-release-failed")throw new System.IO.IOException("PRIVATE_RELEASE_FAILURE");
    }
  }
  public sealed class Output : System.IO.StringReader {
    int reads;
    public Output():base(""){}
    public override string ReadLine() {
      if(++reads==1) {
        State.ReadyReadRestored=State.CurrentEncoding.Equals(State.PriorEncoding);
        return State.Scenario=="ready-read-failed" ? "PRIVATE_WRONG_READY" : "lifetime-ready";
      }
      if(State.Scenario.StartsWith("marker-"))return "lifetime-terminal-failure:"+State.Scenario.Substring(7);
      if(State.Scenario=="terminal-null")return null;
      return State.Scenario=="terminal-ack-failed" ? "PRIVATE_WRONG_ACK" : "lifetime-terminal";
    }
  }
  public sealed class Child : System.IDisposable {
    public System.Diagnostics.ProcessStartInfo StartInfo {get;set;}
    public bool Start(){State.Starts++;State.WriterEncoding=State.CurrentEncoding;
      if(State.Scenario=="start-throws" || State.Scenario=="start-and-restore-failed")throw new System.Exception("PRIVATE_START_FAILURE");return true;}
    public Output StandardOutput=new Output();
    public Input StandardInput=new Input();
    public System.DateTime StartTime {get{if(State.Scenario=="creation-failed")throw new System.Exception("PRIVATE_CREATION_FAILURE");return System.DateTime.FromFileTimeUtc(100);}}
    public System.DateTime ExitTime {get{return State.ExitTime;}}
    public int Id {get{return 1234;}}
    public int ExitCode {get{return 0;}}
    public bool HasExited {get{return State.Exited;}}
    public void WaitForExit(){if(State.Scenario=="query-join-failed")throw new System.IO.IOException("PRIVATE_JOIN_FAILURE");if(!State.Exited)throw new System.Exception("PRIVATE_NOT_RELEASED");State.Joins++;var after=State.AfterWait;State.AfterWait=null;if(after!=null)after();}
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
    public ThreadLease(uint pid,long created,System.IntPtr handle){if(LifetimeDiagnosticFixture.State.Scenario=="lease-failed")throw new System.Exception("PRIVATE_LEASE_FAILURE");}
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
        if(scenario=="query-failed" || scenario=="query-release-failed" || scenario=="query-join-failed")return new ProcessTimeObservation {QuerySucceeded=false};
        return new ProcessTimeObservation {QuerySucceeded=true,CreationMatches=scenario!="creation-mismatch",
          EventNotBeforeCreation=true,ExitTimePresent=false,EventNotAfterExit=null};
      }
      return new ProcessTimeObservation {QuerySucceeded=true,CreationMatches=true,EventNotBeforeCreation=true,
        ExitTimePresent=true,EventNotAfterExit=time==LifetimeDiagnosticFixture.State.LiveTime};
    }
    public void Dispose(){LifetimeDiagnosticFixture.State.LeaseDisposals++;}
  }
'@ + $native.Substring($structStart,$structEnd-$structStart) + "`n}"
Add-Type -TypeDefinition ($control+"`n"+$realControl+"`n"+$fixtures)
foreach($function in $ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}) {
  $definition=$function.Extent.Text
  if($function.Name -eq 'Assert-LifetimeBindings'){$definition=$definition.Replace('Assert-LifetimeBindings','Assert-ActualLifetimeBindings')}
  Invoke-Expression $definition
}
function Assert-LifetimeBindings($Bindings) {
  $script:bindingChecks++
  Assert-ActualLifetimeBindings $Bindings
}
$entryStatement=$outer.Body.Statements | Where-Object {
  $_.Extent.Text -ceq 'Assert-LifetimeBindings $bindings'
} | Select-Object -Last 1
if(-not $entryStatement){throw 'Control invocation boundary missing'}
$source=[IO.File]::ReadAllText((Resolve-Path $SourcePath))
$tail=$source.Substring($entryStatement.Extent.StartOffset,$outer.Body.Extent.EndOffset-1-$entryStatement.Extent.StartOffset)
$catch=$outer.CatchClauses.Extent.Text -join "`n"
if([regex]::Matches($catch,'(?m)^  exit 2$').Count -ne 1){throw 'Failure exit boundary changed'}
$catch=$catch.Replace('  exit 2','  $script:capturedExit=2').Replace('catch {',"catch {`n  `$script:capturedFailure=`$_.Exception")
$entry=[scriptblock]::Create("try {`n"+$tail+"`n}`n"+$catch)
$failed=0
$beforeLiveStages=@{
  'encoding-get-failed'='process-start';'encoding-set-failed'='process-start';'encoding-restore-failed'='process-start'
  'encoding-set-and-restore-failed'='process-start';'start-and-restore-failed'='process-start'
  'start-throws'='process-start';'ready-read-failed'='process-ready';'creation-failed'='process-creation'
  'before-observation'='process-hold';'lease-failed'='process-lease'
  'terminal-write-failed'='process-terminal-write';'terminal-ack-failed'='process-terminal-ack'
  'marker-bom-prefix'='process-terminal-ack';'marker-eof'='process-terminal-ack';'marker-mismatch'='process-terminal-ack'
  'marker-other'='process-terminal-ack';'marker-PRIVATE_UNKNOWN'='process-terminal-ack';'terminal-null'='process-terminal-ack'
}
foreach($scenario in @('encoding-get-failed','encoding-set-failed','encoding-restore-failed',
  'encoding-set-and-restore-failed','start-and-restore-failed','start-throws','ready-read-failed','creation-failed','before-observation','lease-failed',
  'terminal-write-failed','terminal-ack-failed','marker-bom-prefix','marker-eof','marker-mismatch','marker-other',
  'marker-PRIVATE_UNKNOWN','terminal-null','query-threw','query-failed','query-release-failed','query-join-failed','creation-mismatch','early-exit','live')) {
  [LifetimeDiagnosticFixture.State]::Reset($scenario)
  foreach($field in [FileTraceLifetimeControl].GetFields() | Where-Object {$_.FieldType -eq [Nullable[bool]]}){$field.SetValue($null,$null)}
  [FileTraceLifetimeControl]::ChildStartAttempted=$false;[FileTraceLifetimeControl]::ChildJoined=$false
  $categoryField=[FileTraceLifetimeControl].GetField('TerminalInputFailure')
  if($categoryField){$categoryField.SetValue($null,$null)}
  [FileTraceLifetimeControl]::Stage='process-start'
  $stage='compile-control';$script:capturedExit=0;$script:capturedFailure=$null;$script:bindingChecks=0;$ExpectedSourceSha256='source';$ExpectedDllSha256='dll'
  $NodeExe=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $fixturePath=Join-Path $PSScriptRoot 'lifetime-fixture.cjs'
  $fixtureInputPath=Join-Path $PSScriptRoot 'fixture-input.cjs'
  $ExpectedNodeSha256=(Get-FileHash $NodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $ExpectedFixtureSha256=(Get-FileHash $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $ExpectedFixtureInputSha256=(Get-FileHash $fixtureInputPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $bindings=@(@($NodeExe,$ExpectedNodeSha256),@($fixturePath,$ExpectedFixtureSha256),@($fixtureInputPath,$ExpectedFixtureInputSha256))
  $output=(& $entry | Out-String).Trim()
  $record=$output | ConvertFrom-Json
  $expected=@{childHasExited=$null;callCompleted=$null;querySucceeded=$null;creationMatches=$null;
    eventNotBeforeCreation=$null;exitTimePresent=$null;eventNotAfterExit=$null;containsTime=$null}
  if(-not $beforeLiveStages.ContainsKey($scenario)){$expected.callCompleted=$scenario -ne 'query-threw'}
  if(-not $beforeLiveStages.ContainsKey($scenario) -and $scenario -ne 'query-threw') {
    $expected.childHasExited=$scenario -eq 'early-exit';$expected.querySucceeded=$scenario -notin @('query-failed','query-release-failed','query-join-failed')
    $expected.containsTime=$scenario -notin @('query-failed','query-release-failed','query-join-failed','creation-mismatch')
    if($scenario -notin @('query-failed','query-release-failed','query-join-failed')) {
      $expected.creationMatches=$scenario -ne 'creation-mismatch';$expected.eventNotBeforeCreation=$true;$expected.exitTimePresent=$false
    }
  }
  $factsCorrect=$null -ne $record.processLiveObservation
  foreach($key in $expected.Keys) {
    $property=if($null -ne $record.processLiveObservation){$record.processLiveObservation.PSObject.Properties[$key]}else{$null}
    if(-not $property -or $property.Value -cne $expected[$key]){$factsCorrect=$false}
  }
  $noStart=$scenario -in @('encoding-get-failed','encoding-set-failed','encoding-set-and-restore-failed')
  $unreturnedStart=$scenario -in @('start-throws','start-and-restore-failed')
  $beforeHandle=$noStart -or $unreturnedStart -or $scenario -in @('encoding-restore-failed','before-observation','ready-read-failed','creation-failed')
  $restoreFailed=$scenario -in @('encoding-restore-failed','encoding-set-and-restore-failed','start-and-restore-failed')
  $restored=[LifetimeDiagnosticFixture.State]::CurrentEncoding.Equals([LifetimeDiagnosticFixture.State]::PriorEncoding)
  $writer=[LifetimeDiagnosticFixture.State]::WriterEncoding
  $writerCorrect=if($noStart){$null -eq $writer}else{$null -ne $writer -and $writer.CodePage -eq 65001 -and $writer.GetPreamble().Length -eq 0}
  $encodingScopeCorrect=$writerCorrect -and $restored -eq (-not $restoreFailed) -and
    [LifetimeDiagnosticFixture.State]::ReadyReadRestored -and [LifetimeDiagnosticFixture.State]::EncodingGets -eq 1 -and
    [LifetimeDiagnosticFixture.State]::EncodingSets -eq $(if($scenario -eq 'encoding-get-failed'){0}else{2}) -and
    [LifetimeDiagnosticFixture.State]::Starts -eq $(if($noStart){0}else{1})
  $released=[LifetimeDiagnosticFixture.State]::Releases -eq $(if($noStart -or $unreturnedStart -or $scenario -eq 'early-exit'){0}else{1})
  $cleanup=[LifetimeDiagnosticFixture.State]::Joins -eq $(if($noStart -or $unreturnedStart -or $scenario -eq 'query-join-failed'){0}elseif($scenario -eq 'live'){2}else{1}) -and [LifetimeDiagnosticFixture.State]::Disposals -eq 1 -and
    [LifetimeDiagnosticFixture.State]::Closes -eq $(if($beforeHandle){0}else{1}) -and
    [LifetimeDiagnosticFixture.State]::LeaseDisposals -eq $(if($beforeHandle -or $scenario -eq 'lease-failed'){0}else{1})
  $failurePreserved=$true
  if($unreturnedStart){$failurePreserved=$script:capturedFailure.ToString().Contains('PRIVATE_START_FAILURE')}
  if($scenario -in @('query-release-failed','query-join-failed')) {
    $failureText=$script:capturedFailure.ToString()
    $failurePreserved=$failureText.Contains('Lifetime control assertion failed') -and
      $failureText.Contains($(if($scenario -eq 'query-release-failed'){'PRIVATE_RELEASE_FAILURE'}else{'PRIVATE_JOIN_FAILURE'}))
  }
  if($scenario.StartsWith('encoding-') -or $scenario -eq 'start-and-restore-failed') {
    $text=if($script:capturedFailure){$script:capturedFailure.ToString()}else{''}
    if($scenario -eq 'encoding-get-failed'){$failurePreserved=$text.Contains('PRIVATE_ENCODING_GET')}
    if($scenario -in @('encoding-set-failed','encoding-set-and-restore-failed')){$failurePreserved=$text.Contains('PRIVATE_ENCODING_SET')}
    if($restoreFailed){$failurePreserved=$failurePreserved -and $text.Contains('PRIVATE_ENCODING_RESTORE')}
  }
  $joinAdmission=$script:bindingChecks -eq $(if($unreturnedStart -or $scenario -eq 'query-join-failed'){1}else{2})
  $expectedStage=if($beforeLiveStages.ContainsKey($scenario)){$beforeLiveStages[$scenario]}elseif($scenario -eq 'live'){'complete'}else{'process-live'}
  $stageCorrect=$record.stage -ceq $expectedStage
  $expectedCategory=if($scenario -in @('marker-bom-prefix','marker-eof','marker-mismatch','marker-other')){$scenario.Substring(7)}else{$null}
  $categoryCorrect=$record.terminalInputFailure -ceq $expectedCategory
  $passed=$encodingScopeCorrect -and $categoryCorrect -and $stageCorrect -and $failurePreserved -and $joinAdmission -and $factsCorrect -and $released -and $cleanup -and $record.passed -eq ($scenario -eq 'live') -and
    $script:capturedExit -eq $(if($scenario -eq 'live'){0}else{2}) -and -not $output.Contains('PRIVATE_')
  if(-not $passed){$failed++}
  @{scenario=$scenario;passed=$passed;encodingScopeCorrect=$encodingScopeCorrect;encodingRestored=$restored;categoryCorrect=$categoryCorrect;stageCorrect=$stageCorrect;stage=$record.stage;factsCorrect=$factsCorrect;naturalReleaseCorrect=$released;
    cleanupCorrect=$cleanup;failurePreserved=$failurePreserved;postBindingJoinAdmission=$joinAdmission;
    nativeProof=$false;controlSha256=(Get-FileHash $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Compress
}
if($failed){throw "Lifetime diagnostic contract failures: $failed"}

if($BindingProbePath) {
  foreach($moment in @('before','after','after-failed-control')) {
    [IO.File]::WriteAllText($BindingProbePath,'original')
    $probeHash=(Get-FileHash $BindingProbePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $probeBindings=@($bindings)+,@($BindingProbePath,$probeHash)
    [LifetimeDiagnosticFixture.State]::Reset($(if($moment -eq 'after-failed-control'){'query-release-failed'}else{'live'}))
    [FileTraceLifetimeControl]::ChildStartAttempted=$false;[FileTraceLifetimeControl]::ChildJoined=$false
    $categoryField=[FileTraceLifetimeControl].GetField('TerminalInputFailure')
  if($categoryField){$categoryField.SetValue($null,$null)}
  [FileTraceLifetimeControl]::Stage='process-start';$stage='compile-control';$script:capturedExit=0
    if($moment -eq 'before'){[IO.File]::WriteAllText($BindingProbePath,'changed')}
    else {[LifetimeDiagnosticFixture.State]::AfterWait=[Action]{[IO.File]::WriteAllText($BindingProbePath,'changed')}}
    $savedBindings=$bindings;$bindings=$probeBindings
    try {$record=(& $entry | Out-String).Trim() | ConvertFrom-Json} finally {$bindings=$savedBindings}
    $passed=$record.passed -eq $false -and $script:capturedExit -eq 2 -and
      [LifetimeDiagnosticFixture.State]::Starts -eq $(if($moment -eq 'before'){0}else{1}) -and
      [FileTraceLifetimeControl]::ChildJoined -eq ($moment -ne 'before')
    if($moment -eq 'after-failed-control') {
      $text=$script:capturedFailure.ToString()
      $passed=$passed -and $text.Contains('Lifetime control assertion failed') -and $text.Contains('PRIVATE_RELEASE_FAILURE') -and $text.Contains('Native control binding mismatch')
    }
    @{scenario=('binding-drift-'+$moment);passed=$passed;nativeProof=$false} | ConvertTo-Json -Compress
    if(-not $passed){throw 'Binding drift admitted or cleanup not joined'}
  }
}
if($RealNodeExe -or $RealFixturePath) {
  if(-not $RealNodeExe -or -not $RealFixturePath){throw 'Both real transport inputs are required'}
  $functions=$ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in @('Get-ProcessLiveObservation','Get-TerminalInputFailure')
  }
  foreach($function in $functions) {
    Invoke-Expression ($function.Extent.Text.Replace('Get-ProcessLiveObservation','Get-RealProcessLiveObservation').Replace('Get-TerminalInputFailure','Get-RealTerminalInputFailure').Replace('FileTraceLifetimeControl','FileTraceLifetimeControlReal'))
  }
  $realEntry=[scriptblock]::Create($entry.ToString().Replace('Get-ProcessLiveObservation','Get-RealProcessLiveObservation').Replace('Get-TerminalInputFailure','Get-RealTerminalInputFailure').Replace('FileTraceLifetimeControl','FileTraceLifetimeControlReal'))
  $NodeExe=$RealNodeExe;$fixturePath=$RealFixturePath
  $fixtureInputPath=Join-Path ([IO.Path]::GetDirectoryName($fixturePath)) 'fixture-input.cjs'
  $ExpectedNodeSha256=(Get-FileHash $NodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $ExpectedFixtureSha256=(Get-FileHash $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $ExpectedFixtureInputSha256=(Get-FileHash $fixtureInputPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $bindings=@(@($NodeExe,$ExpectedNodeSha256),@($fixturePath,$ExpectedFixtureSha256),@($fixtureInputPath,$ExpectedFixtureInputSha256))
  foreach($scenario in @('live','before-observation')) {
    [LifetimeDiagnosticFixture.State]::Reset($scenario)
    foreach($field in [FileTraceLifetimeControlReal].GetFields() | Where-Object {$_.FieldType -eq [Nullable[bool]]}){$field.SetValue($null,$null)}
    [FileTraceLifetimeControlReal]::ChildStartAttempted=$false;[FileTraceLifetimeControlReal]::ChildJoined=$false
    [FileTraceLifetimeControlReal]::Stage='process-start';$stage='compile-control';$script:capturedExit=0
    $record=(& $realEntry | Out-String).Trim() | ConvertFrom-Json
    $passed=[LifetimeDiagnosticFixture.State]::JoinedExitZero -and $record.passed -eq ($scenario -eq 'live') -and
      $script:capturedExit -eq $(if($scenario -eq 'live'){0}else{2})
    @{scenario=('real-process-'+$scenario);passed=$passed;naturalJoinedExitZero=[LifetimeDiagnosticFixture.State]::JoinedExitZero;
      nativeProof=$false;apiResponses='substituted';processTransport='actual-CSharp-Process'} | ConvertTo-Json -Compress
    if(-not $passed){throw 'Real process transport contract failed'}
  }
}
