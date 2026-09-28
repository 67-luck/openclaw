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
  return @{entries=[Collections.Generic.List[object]]::new();names=@{};truncated=$false;unavailable=$false}
}
function Update-FileTraceFacts($State,[int]$EventId,[string]$Irp,[string]$Key,[bool]$HasStatus,[bool]$NameOwned) {
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
      elseif(-not $HasStatus){$entry.public.irpReusedBeforeEnd=$true;$entry.active=$false}
    }}
  }
}
function Add-OwnFileTraceFact($State,$Schema,$Fields,[string]$Irp,[string]$Object,[string]$Key,
  [string]$NameScope,[string]$ResolvedScope,[bool]$ObjectMapped,[bool]$KeyMapped,[bool]$DispatchCreate,[bool]$DispatchClose) {
  if($State.entries.Count -ge 16){$State.truncated=$true;return}
  $shape=@{}
  foreach($name in @('Irp','IrpPtr','FileObject','FileKey','IssuingThreadId','TTID','ThreadId','Status','FileName','OpenPath','FilePath','CreateOptions','InfoClass')){
    $shape[$name]=$Fields.ContainsKey($name)
  }
  $before=0
  if($Key -and $State.names.ContainsKey($Key)){$before=$State.names[$Key]}
  $public=@{ordinal=$State.entries.Count+1;schema=(Get-FileTraceSchemaFact $Schema);
    fieldPresence=$shape;irpPresent=[bool]$Irp;objectPresent=[bool]$Object;keyPresent=[bool]$Key;
    namePresent=[bool]($Fields.FileName -or $Fields.OpenPath -or $Fields.FilePath);
    nameScope=$NameScope;resolvedScope=$ResolvedScope;objectMappingPresent=$ObjectMapped;keyMappingPresent=$KeyMapped;
    classifiedCreate=$DispatchCreate;classifiedClose=$DispatchClose;matchingOwnedNameBeforeBegin=$before;
    matchingOwnedNameAfterBegin=0;nameKeyRetired=$false;completionSeen=$false;irpReusedBeforeEnd=$false}
  $State.entries.Add(@{public=$public;irp=$Irp;key=$Key;active=$true;nameActive=$true})
}
function Get-FileTraceFacts($State) {
  $result=@{phase='owned-begin-facts';diagnosticOnly=$true;truncated=$State.truncated;unavailable=$State.unavailable;
    nameMatchMeaning='same private key, owned-path name, before completion; never attribution authority';
    events=@($State.entries | ForEach-Object {$_.public})}
  if([Text.Encoding]::UTF8.GetByteCount(($result | ConvertTo-Json -Depth 8 -Compress)) -gt 32768){
    $result.events=@();$result.truncated=$true
  }
  return $result
}
