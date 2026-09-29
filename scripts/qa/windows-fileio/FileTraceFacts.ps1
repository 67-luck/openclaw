# Observation only: these facts never feed the attribution maps or verdict.
function Get-FileTraceSchemaFact($Schema) {
  $fields=[Collections.Generic.List[string]]::new()
  $incomplete=$false
  try {
    if(([string]$Schema.template).Length -gt 16384){throw 'Metadata bound'}
    [xml]$template=[string]$Schema.template
    foreach($data in $template.SelectNodes('//*[local-name()="data"]')) {
      if($fields.Count -ge 32){$incomplete=$true;break}
      $name=[string]$data.GetAttribute('name')
      if($name -cmatch '^[A-Za-z_][A-Za-z0-9_]{0,63}$'){$fields.Add($name)}else{$incomplete=$true}
    }
  } catch {$incomplete=$true}
  $task=[string]$Schema.task; $opcode=[string]$Schema.opcode
  if($task -cnotmatch '^[A-Za-z0-9_.:/ -]{0,96}$'){$task=$null;$incomplete=$true}
  if($opcode -cnotmatch '^[A-Za-z0-9_.:/ -]{0,96}$'){$opcode=$null;$incomplete=$true}
  return @{eventId=[int]$Schema.id;eventVersion=[int]$Schema.version;task=$task;opcode=$opcode;
    fieldNames=@($fields.ToArray());incomplete=$incomplete}
}
function Get-FileTracePublicSchema($Schemas) {
  $selected=@($Schemas | Where-Object {$_.id -in @(10,11,12,17,18,24,26)} | Sort-Object id,version)
  $result=@{phase='provider-metadata';diagnosticOnly=$true;truncated=($selected.Count -gt 32);
    events=@($selected | Select-Object -First 32 | ForEach-Object {Get-FileTraceSchemaFact $_})}
  if([Text.Encoding]::UTF8.GetByteCount(($result | ConvertTo-Json -Depth 8 -Compress)) -gt 16384){
    $result.events=@();$result.truncated=$true
  }
  return $result
}
function New-FileTraceFacts {
  return @{entries=[Collections.Generic.List[object]]::new();names=@{};sequence=0;ownSequence=0;
    priorityKept=0;otherKept=0;priorityTruncated=$false;nonPriorityTruncated=$false;truncated=$false;unavailable=$false}
}
function Use-FileTraceDetailSlot($State,[bool]$Priority,[int]$LimitPerKind) {
  $count=if($Priority){'priorityKept'}else{'otherKept'}
  if($State[$count] -ge $LimitPerKind){
    $State.truncated=$true
    if($Priority){$State.priorityTruncated=$true}else{$State.nonPriorityTruncated=$true}
    return $false
  }
  $State[$count]++
  return $true
}
function Get-FileTracePrivateNumber($Value) {
  $text=[string]$Value
  if(-not $text -or $text.Length -gt 20){return $null}
  try {
    if($text -match '^0[xX]') {return [Convert]::ToUInt64($text.Substring(2),16)}
    return [uint64]::Parse($text)
  } catch {return $null}
}
function Get-FileTracePrivateIdentity($Fields,[string]$Object,[string]$Key) {
  $thread=$null
  foreach($name in @('IssuingThreadId','TTID','ThreadId')){
    if($Fields.ContainsKey($name)){$thread=Get-FileTracePrivateNumber $Fields[$name];break}
  }
  return @{object=$(if($Object){$Object}else{$null});key=$(if($Key){$Key}else{$null});
    thread=$thread;infoClass=(Get-FileTracePrivateNumber $Fields.InfoClass)}
}
function Compare-FileTracePrivateValue($First,$Second) {
  if($null -eq $First -or $null -eq $Second){return $null}
  return $First -ceq $Second
}
function Mark-FileTracePendingConflict($State,[string]$Irp) {
  foreach($entry in $State.entries){
    if($entry.irp -eq $Irp -and $entry.nextSequence -eq $State.sequence -and $entry.public.nextSameIrpBegin){
      $entry.public.nextSameIrpBegin.parserPendingConflict=$true
    }
  }
}
function Update-FileTraceFacts($State,[int]$EventId,[string]$Irp,[string]$Key,[bool]$HasStatus,[bool]$NameOwned,$Fields,[string]$Object,[int]$Version) {
  $State.sequence++
  # Keys/IRPs stay private. A name match is a diagnostic equality fact only.
  if($EventId -eq 11 -and $Key){
    $State.names.Remove($Key)
    foreach($entry in $State.entries){if($entry.key -eq $Key -and $entry.active){
      $entry.public.nameKeyRetired=$true;$entry.nameActive=$false
    }}
  }
  if($EventId -eq 10 -and $Key -and $NameOwned){
    if($State.names.ContainsKey($Key)){$State.names[$Key]++}
    elseif($State.names.Count -lt 16){$State.names[$Key]=1}else{$State.truncated=$true}
    foreach($entry in $State.entries){if($entry.active -and $entry.nameActive -and $entry.key -eq $Key){
      $entry.public.matchingOwnedNameAfterBegin++
    }}
  }
  if($Irp){
    foreach($entry in $State.entries){if($entry.active -and $entry.irp -eq $Irp){
      if($EventId -eq 24 -and $HasStatus){$entry.public.completionSeen=$true;$entry.active=$false}
      elseif(-not $HasStatus){
        $entry.public.irpReusedBeforeEnd=$true;$entry.active=$false
        if($entry.priority){
          $next=Get-FileTracePrivateIdentity $Fields $Object $Key
          $entry.nextSequence=$State.sequence
          $entry.public.nextSameIrpBegin=@{eventId=$EventId;eventVersion=$Version;
            sameObject=(Compare-FileTracePrivateValue $entry.identity.object $next.object);
            sameKey=(Compare-FileTracePrivateValue $entry.identity.key $next.key);
            sameIssuingThread=(Compare-FileTracePrivateValue $entry.identity.thread $next.thread);
            sameInfoClass=(Compare-FileTracePrivateValue $entry.identity.infoClass $next.infoClass);
            parserPendingConflict=$false;nextBeginOwnAdmission=$false}
        }
      }
    }}
  }
}
function Add-OwnFileTraceFact($State,$Schema,$Fields,[string]$Irp,[string]$Object,[string]$Key,
  [string]$NameScope,[string]$ResolvedScope,[bool]$ObjectMapped,[bool]$KeyMapped,[bool]$DispatchCreate,[bool]$DispatchClose,$RequestEvent=$null) {
  $State.ownSequence++
  foreach($entry in $State.entries){
    if($entry.irp -eq $Irp -and $entry.nextSequence -eq $State.sequence -and $entry.public.nextSameIrpBegin){
      $entry.public.nextSameIrpBegin.nextBeginOwnAdmission=$true
    }
  }
  $priority=[int]$Schema.id -in @(17,18,26)
  if(-not (Use-FileTraceDetailSlot $State $priority 8)){return}
  $shape=@{}
  foreach($name in @('Irp','IrpPtr','FileObject','FileKey','IssuingThreadId','TTID','ThreadId','Status','FileName','OpenPath','FilePath','CreateOptions','InfoClass')){
    $shape[$name]=$Fields.ContainsKey($name)
  }
  $before=0
  if($Key -and $State.names.ContainsKey($Key)){$before=$State.names[$Key]}
  $public=@{ordinal=$State.ownSequence;priorityEventFamily=$priority;nextSameIrpBegin=$null;schema=(Get-FileTraceSchemaFact $Schema);
    fieldPresence=$shape;irpPresent=[bool]$Irp;objectPresent=[bool]$Object;keyPresent=[bool]$Key;
    namePresent=[bool]($Fields.FileName -or $Fields.OpenPath -or $Fields.FilePath);
    nameScope=$NameScope;resolvedScope=$ResolvedScope;objectMappingPresent=$ObjectMapped;keyMappingPresent=$KeyMapped;
    classifiedCreate=$DispatchCreate;classifiedClose=$DispatchClose;matchingOwnedNameBeforeBegin=$before;
    matchingOwnedNameAfterBegin=0;nameKeyRetired=$false;completionSeen=$false;irpReusedBeforeEnd=$false}
  if($null -ne $RequestEvent){$public.requestEvent=$RequestEvent}
  $State.entries.Add(@{public=$public;irp=$Irp;key=$Key;active=$true;nameActive=$true;priority=$priority;
    nextSequence=-1;identity=$(if($priority){Get-FileTracePrivateIdentity $Fields $Object $Key}else{$null})})
}
function Get-FileTraceFacts($State) {
  $result=@{phase='owned-begin-facts';diagnosticOnly=$true;truncated=$State.truncated;unavailable=$State.unavailable;
    nameMatchMeaning='same private key, owned-path name, before completion; never attribution authority';
    relationMeaning='first subsequent same-IRP begin; equality and parser branch facts only, never a companion or reuse verdict';
    requestEventMeaning='one admitted provider event, not a distinct operation, active-at-instant claim, completion or NTSTATUS';
    priorityRowLimit=8;nonPriorityRowLimit=8;priorityTruncated=$State.priorityTruncated;nonPriorityTruncated=$State.nonPriorityTruncated;
    events=@($State.entries | ForEach-Object {$_.public})}
  if([Text.Encoding]::UTF8.GetByteCount(($result | ConvertTo-Json -Depth 8 -Compress)) -gt 32768){
    $result.events=@();$result.truncated=$true
  }
  return $result
}

function New-FileTraceCensus {
  $seen=@{}; $header=@{}; $reasons=@{}
  foreach($id in @(10,11,12,13,14,15,17,18,24,26)){$seen[[string]$id]=0;$header[[string]$id]=0}
  foreach($reason in @('outside-capture-window','outside-original-lifetime','unknown-schema','name-event',
    'completion-event','missing-or-zero-irp','missing-issuing-thread','unverified-issuing-thread',
    'outside-owned-path','unresolved-target','request-retained','processing-interrupted')){$reasons[$reason]=0}
  return @{seen=$seen;header=$header;reasons=$reasons;rows=[Collections.Generic.List[object]]::new();
    priorityKept=0;otherKept=0;priorityTruncated=$false;nonPriorityTruncated=$false;truncated=$false;unavailable=$false}
}
function New-FileTraceCensusRow($State,$Event,[string]$SelectionReason) {
  $priority=[int]$Event.Id -in @(17,18,26)
  if(-not (Use-FileTraceDetailSlot $State $priority 16)){return $null}
  $row=@{eventId=[int]$Event.Id;eventVersion=[int]$Event.Version;
    headerPidMatched=($SelectionReason -eq 'header-pid');selectionReason=$SelectionReason;priorityEventFamily=$priority;
    timeWindowMatched=$null;processLifetimeMatched=$null;processTime=$null;issuingThreadVerified=$null;
    fieldPresence=@{};irpValueNonzero=$null;fieldShapeUnavailable=$false;filterReason='processing-interrupted'}
  $State.rows.Add($row)
  return $row
}
function Set-FileTraceCensusFields($Row,$Fields) {
  foreach($name in @('Irp','IrpPtr','FileObject','FileKey','IssuingThreadId','TTID','ThreadId',
    'Status','FileName','OpenPath','FilePath','CreateOptions','InfoClass')){$Row.fieldPresence[$name]=$Fields.ContainsKey($name)}
  $irp=if($Fields.ContainsKey('Irp')){$Fields.Irp}else{$Fields.IrpPtr}
  if(-not $irp){$Row.irpValueNonzero=$false}
  elseif($irp -cmatch '^(?:0[xX])?0+$'){$Row.irpValueNonzero=$false}
  elseif($irp -cmatch '^(?:0[xX][0-9A-Fa-f]{1,16}|[0-9]{1,20})$'){$Row.irpValueNonzero=$true}
}
function Set-FileTraceCensusProcessTime($Row,$ProcessTime) {
  $Row.processTime=@{querySucceeded=$ProcessTime.QuerySucceeded;nativeError=$ProcessTime.NativeError;
    creationMatches=$ProcessTime.CreationMatches;eventNotBeforeCreation=$ProcessTime.EventNotBeforeCreation;
    exitTimePresent=$ProcessTime.ExitTimePresent;eventNotAfterExit=$ProcessTime.EventNotAfterExit}
}
function Start-FileTraceCensusEvent($State,$Event,[uint32]$TargetPid) {
  $id=[string][int]$Event.Id
  if(-not $State.seen.ContainsKey($id)){return $null}
  $State.seen[$id]++
  if($null -eq $Event.ProcessId -or [long]$Event.ProcessId -ne [long]$TargetPid){return $null}
  $State.header[$id]++
  $row=New-FileTraceCensusRow $State $Event 'header-pid'
  if($null -eq $row){return $null}
  try {
    $text=$Event.ToXml()
    if($text.Length -gt 16384){throw 'Diagnostic XML bound'}
    [xml]$xml=$text
    $fields=@{}
    foreach($data in $xml.Event.EventData.Data){
      $name=[string]$data.Name
      if($name -in @('Irp','IrpPtr','FileObject','FileKey','IssuingThreadId','TTID','ThreadId',
        'Status','FileName','OpenPath','FilePath','CreateOptions','InfoClass')){$fields[$name]=[string]$data.'#text'}
    }
    Set-FileTraceCensusFields $row $fields
  } catch {$row.fieldShapeUnavailable=$true;$State.unavailable=$true}
  return $row
}
function Add-OwnedPathFileTraceCensusEvent($State,$Event,[uint32]$TargetPid,$Fields,$ProcessTime) {
  # Called only after the original interval/schema parsing and explicit path match.
  # Header-selected events already consumed (or exhausted) this same row quota.
  if(-not $State.seen.ContainsKey([string][int]$Event.Id) -or
    ($null -ne $Event.ProcessId -and [long]$Event.ProcessId -eq [long]$TargetPid)){return $null}
  $row=New-FileTraceCensusRow $State $Event 'owned-path'
  if($null -eq $row){return $null}
  $row.timeWindowMatched=$true;$row.processLifetimeMatched=$true
  Set-FileTraceCensusProcessTime $row $ProcessTime
  Set-FileTraceCensusFields $row $Fields
  return $row
}
function Complete-FileTraceCensusEvent($State,[int]$EventId,$Row,[string]$Reason) {
  if(-not $State.seen.ContainsKey([string]$EventId)){return}
  if(-not $State.reasons.ContainsKey($Reason)){$State.unavailable=$true;return}
  $State.reasons[$Reason]++
  if($null -ne $Row){$Row.filterReason=$Reason}
}
function Get-FileTraceCensus($State) {
  $result=@{phase='filter-census';diagnosticOnly=$true;
    meaning='provider event counts; header PID or explicit owned-path selection grants no process, thread, or operation authority';
    relevantEventCounts=$State.seen;headerPidMatchCounts=$State.header;filterReasonCounts=$State.reasons;
    events=@($State.rows.ToArray());truncated=$State.truncated;unavailable=$State.unavailable;
    rowLimit=32;byteLimit=32768;countKeyLimit=32;priorityRowLimit=16;nonPriorityRowLimit=16;
    priorityTruncated=$State.priorityTruncated;nonPriorityTruncated=$State.nonPriorityTruncated}
  if([Text.Encoding]::UTF8.GetByteCount(($result | ConvertTo-Json -Depth 8 -Compress)) -gt 32768){
    $result.events=@();$result.truncated=$true
  }
  return $result
}
