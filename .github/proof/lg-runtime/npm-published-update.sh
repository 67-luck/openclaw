#!/usr/bin/env bash
# Task-private published-driver proof. The caller builds the canonical candidate once.
set -euo pipefail
exec env -i PATH="$PATH" \
  LG_CANDIDATE_TGZ="${LG_CANDIDATE_TGZ:?canonical candidate tarball required}" \
  LG_CANDIDATE_SHA256="${LG_CANDIDATE_SHA256:?candidate SHA-256 required}" \
  LG_PROOF_ARTIFACTS="${LG_PROOF_ARTIFACTS:?new external artifact directory required}" \
  LG_RUNTIME_PARENT="${RUNNER_TEMP:-/tmp}" \
  bash --noprofile --norc -s <<'LG_NPM_PROOF'
set -euo pipefail
umask 077
[[ "$(uname -s)" == Linux ]]
lg_head=2f7a5c015cfa00861f6eb097c6265f2b79c3005b
lg_tree=dd7f0bea86a4a7bf91a083f941d0cefc4239b8af
lg_source="$(pwd -P)"
[[ "$(git rev-parse HEAD)" == "$lg_head" ]]
[[ "$(git rev-parse 'HEAD^{tree}')" == "$lg_tree" ]]
[[ -z "$(git status --porcelain --untracked-files=normal)" ]]
[[ "$LG_CANDIDATE_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$LG_PROOF_ARTIFACTS" == /* ]]
[[ "$LG_RUNTIME_PARENT" == /* ]]
lg_candidate="$(realpath "$LG_CANDIDATE_TGZ")"
[[ -f "$lg_candidate" ]]
lg_digest="$(sha256sum "$lg_candidate")"
[[ "${lg_digest%% *}" == "$LG_CANDIDATE_SHA256" ]]
mkdir -p "$(dirname "$LG_PROOF_ARTIFACTS")"
# Exclusive creation prevents mixed receipts from an earlier attempt.
mkdir "$LG_PROOF_ARTIFACTS"
lg_artifacts="$(realpath "$LG_PROOF_ARTIFACTS")"
lg_runtime="$(mktemp -d "$LG_RUNTIME_PARENT/fu-lg-runtime-npm-stubs.XXXXXX")"
case "$lg_artifacts/" in "$lg_source/"*|"$lg_runtime/"*) exit 2 ;; esac
case "$lg_source/" in "$lg_artifacts/"*) exit 2 ;; esac
case "$lg_runtime/" in "$lg_artifacts/"*) exit 2 ;; esac
case "$lg_candidate" in "$lg_artifacts/"*) exit 2 ;; esac
mkdir -p "$lg_runtime/home" "$lg_runtime/tmp" "$lg_runtime/npm-cache"
export HOME="$lg_runtime/home" TMPDIR="$lg_runtime/tmp" CI=1
export npm_config_userconfig="$lg_runtime/empty.npmrc"
export npm_config_cache="$lg_runtime/npm-cache"
export npm_config_audit=false npm_config_fund=false
: > "$npm_config_userconfig"
lg_registry_pid=''
lg_finish() {
  local result=$?
  trap - EXIT
  if [[ -n "$lg_registry_pid" ]]; then
    kill "$lg_registry_pid" 2>/dev/null || true
    wait "$lg_registry_pid" 2>/dev/null || true
  fi
  if [[ -f "$lg_runtime/registry/server.log" ]]; then
    cp "$lg_runtime/registry/server.log" "$lg_artifacts/registry.log"
  fi
  printf '%s\n' "$result" > "$lg_artifacts/exit-code.txt"
  printf 'npm-stub proof exit=%s artifacts=%s runtime=%s\n' "$result" "$lg_artifacts" "$lg_runtime"
  exit "$result"
}
trap lg_finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

lg_phase() {
  local label="$1" started ended result
  shift
  started="$(date +%s)"
  if "$@" > "$lg_out/$label.out" 2> "$lg_out/$label.err"; then result=0; else result=$?; fi
  ended="$(date +%s)"
  printf '%s\t%s\t%s\n' "$label" "$((ended-started))" "$result" >> "$lg_out/timings.tsv"
  printf '%s\n' "$result" > "$lg_out/$label.exit"
  printf 'phase=%s seconds=%s exit=%s\n' "$label" "$((ended-started))" "$result"
  return "$result"
}
lg_out="$lg_artifacts"
tar -xOf "$lg_candidate" package/package.json > "$lg_artifacts/candidate-package.json"
tar -xOf "$lg_candidate" package/dist/build-info.json > "$lg_artifacts/candidate-build-info.json"
printf '%s\n' "$lg_head" > "$lg_artifacts/candidate-head.txt"
printf '%s\n' "$lg_tree" > "$lg_artifacts/candidate-tree.txt"
printf '%s\n' "$LG_CANDIDATE_SHA256" > "$lg_artifacts/candidate.sha256"
node --input-type=module - "$lg_artifacts" "$lg_head" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const [out, head] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
assert.equal(read('candidate-package.json').name, 'openclaw');
assert.equal(read('candidate-build-info.json').commit, head);
assert.equal(read('candidate-build-info.json').version, read('candidate-package.json').version);
NODE
lg_phase published-metadata npm view openclaw@2026.9.7 version dist --registry=https://registry.npmjs.org --json
node --input-type=module - "$lg_artifacts/published-metadata.out" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(value.version, '2026.9.7');
assert.equal(typeof value.dist?.integrity, 'string');
assert.equal(new URL(value.dist.tarball).hostname, 'registry.npmjs.org');
NODE

cat > "$lg_runtime/fixture.mjs" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [mode, source, root, out, suiteOut, phase] = process.argv.slice(2);
const canonicalId = 'lg-npm-canonical';
const stubId = 'lg-npm-retired-stub';
const stubPackage = '@openclaw/lg-npm-retired-stub';
const configPath = path.join(root, 'home/.openclaw/openclaw.json');
const stateDir = path.dirname(configPath);
const canonicalRoot = path.join(root, 'canonical-plugin');
const stubRoot = path.join(root, 'home/retired-stub');
const stubPath = path.join(stubRoot, 'openclaw.extension.json');
const installedRoot = path.join(root, 'npm-prefix/lib/node_modules/openclaw');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  fs.writeFileSync(file, JSON.stringify(value, null, 2)+'\n', {mode:0o600});
};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const {readPluginInstallIndex} = await import(pathToFileURL(path.join(source, 'scripts/e2e/lib/plugin-index-sqlite.mjs')));
const {writeCliPlugin} = await import(pathToFileURL(path.join(source, 'scripts/e2e/lib/fixtures/plugins.mjs')));
const sourceFiles = ['package.json', 'openclaw.plugin.json', 'index.js'];
const canonicalHashes = () => Object.fromEntries(sourceFiles.map(name => [name, digest(path.join(canonicalRoot,name))]));
function observe() {
  const index = readPluginInstallIndex({stateDir, configPath:null});
  const records = index.installRecords;
  assert(records && records[canonicalId], 'Authoritative canonical plugin install record is unavailable');
  const config = read(configPath);
  const installedPackage = read(path.join(installedRoot,'package.json'));
  const installedBuild = read(path.join(installedRoot,'dist/build-info.json'));
  const fixture = read(path.join(out,'fixture.json'));
  const snapshot = {phase, installedPackage, installedBuild, records,
    stubSha256:digest(stubPath), canonicalHashes:canonicalHashes(),
    configuredStub:config.plugins?.entries?.[stubId], allowedPlugins:config.plugins?.allow,
    loadPaths:config.plugins?.load?.paths, configSha256:digest(configPath),
    candidateInstalled:JSON.stringify(installedBuild) === JSON.stringify(read(path.join(suiteOut,'candidate-build-info.json'))),
    fixtureStubSha256:fixture.stubSha256};
  write(path.join(out,`${phase}.json`),snapshot);
  return snapshot;
}
function assertPreserved(snapshot) {
  const fixture = read(path.join(out,'fixture.json'));
  assert.equal(snapshot.stubSha256,fixture.stubSha256,'The declaration stub bytes changed');
  assert.deepEqual(snapshot.canonicalHashes,fixture.canonicalHashes,'Canonical plugin source bytes changed');
  assert(snapshot.loadPaths.includes(stubRoot),'The authored stub load path was silently removed');
  assert(snapshot.loadPaths.includes(canonicalRoot),'Canonical plugin load path disappeared');
  assert.equal(snapshot.records[canonicalId].source,'path');
  assert.equal(snapshot.records[canonicalId].sourcePath,canonicalRoot);
}
function assertConfiguredStub(snapshot) {
  assert.equal(snapshot.configuredStub?.enabled,true,'Configured stub enablement disappeared');
  assert(snapshot.allowedPlugins.includes(stubId),'Configured stub allow entry disappeared');
}
function assertRetiredStubCleanup(snapshot) {
  const before = read(path.join(out,'before-update.json'));
  const backupPath = `${configPath}.pre-update`;
  const backupBytes = fs.readFileSync(backupPath);
  assert.deepEqual(backupBytes,fs.readFileSync(path.join(out,'config-before-update.json')),
    'Pre-update backup does not preserve the exact authored configuration bytes');
  assert.equal(digest(backupPath),before.configSha256,'Pre-update backup identity differs');
  const backup = JSON.parse(backupBytes.toString('utf8'));
  assert.deepEqual(backup.plugins.entries[stubId],before.configuredStub,'Pre-update backup lost the stub entry');
  assert.deepEqual(backup.plugins.allow,before.allowedPlugins,'Pre-update backup lost the allow policy');
  assert.equal(snapshot.configuredStub,undefined,'Doctor retained the retired stub entry');
  assert.equal(snapshot.allowedPlugins.includes(stubId),false,'Doctor retained the retired stub allow entry');
  assert(snapshot.allowedPlugins.includes(canonicalId),'Doctor removed the canonical plugin allow entry');
  const diagnostics = fs.readFileSync(path.join(out,'update.err'),'utf8');
  assert(diagnostics.includes(`plugins.entries: removed 1 stale plugin entry (${stubId})`),
    'Doctor did not announce the retired stub entry removal');
  assert(diagnostics.includes(`plugins.allow: removed 1 stale plugin id (${stubId})`),
    'Doctor did not announce the retired stub allow entry removal');
  assert(diagnostics.includes('pre-update backup:'),'Updater did not report the recovery backup');
  fs.writeFileSync(path.join(out,'config-pre-update-backup.json'),backupBytes,{mode:0o600});
}
function assertCandidate(snapshot) {
  assert.deepEqual(snapshot.installedPackage,read(path.join(suiteOut,'candidate-package.json')),'Candidate package was not installed');
  assert.deepEqual(snapshot.installedBuild,read(path.join(suiteOut,'candidate-build-info.json')),'Candidate build identity differs');
}
function assertRecordOutcome(snapshot) {
  const before = read(path.join(out,'before-update.json'));
  if (path.basename(out) === 'direct') {
    assert.equal(Object.hasOwn(snapshot.records,stubId),false,'Direct update installed the retired stub');
    assertRetiredStubCleanup(snapshot);
  } else {
    assertConfiguredStub(snapshot);
    assert(before.records[stubId],'Bridge has no published manual installation to preserve');
    assert(snapshot.records[stubId],'Update lost the plugin installed by the published CLI');
    for (const key of ['source','spec','version','resolvedName','resolvedVersion','resolvedSpec','integrity']) {
      assert.deepEqual(snapshot.records[stubId][key],before.records[stubId][key],`Bridge install ${key} changed`);
    }
  }
}
if (mode === 'stub-package') {
  write(path.join(root,'package.json'), {name:stubPackage,version:'1.0.0',openclaw:{extensions:['./index.js']}});
  write(path.join(root,'openclaw.plugin.json'), {id:stubId,name:'Synthetic retired-stub package',configSchema:{type:'object',properties:{},additionalProperties:false}});
  fs.writeFileSync(path.join(root,'index.js'),`module.exports = { id: ${JSON.stringify(stubId)}, register() {} };\n`,{mode:0o600});
} else if (mode === 'initial') {
  writeCliPlugin([canonicalRoot,canonicalId,'1.0.0','lg.canonical.ping','Synthetic canonical plugin','lgcanonical','lg-npm-canonical:pong']);
  fs.mkdirSync(path.join(root,'home/workspace'),{recursive:true,mode:0o700});
  write(configPath,{
    gateway:{mode:'local',bind:'loopback',auth:{mode:'token',token:'lg-npm-synthetic-token'},controlUi:{enabled:false}},
    update:{channel:'stable',checkOnStart:false},
    agents:{entries:{main:{default:true,workspace:path.join(root,'home/workspace')}}},
    plugins:{allow:[canonicalId],slots:{memory:'none'},entries:{[canonicalId]:{enabled:true}}}
  });
} else if (mode === 'seed-stub') {
  assert(fs.readFileSync(path.join(out,'baseline-canonical-cli.out'),'utf8').split(/\r?\n/u).some(line=>line.trim()==='lg-npm-canonical:pong'),
    'Published baseline did not execute the canonical plugin CLI');
  const bytes = '{\n  "name": "lg-npm-retired-stub",\n  "type": "npm",\n  "npmSpec": "@openclaw/lg-npm-retired-stub@1.0.0",\n  "operatorNote": "Synthetic bytes must remain unchanged"\n}\n';
  fs.mkdirSync(stubRoot,{recursive:true,mode:0o700});
  fs.writeFileSync(stubPath,bytes,{mode:0o600,flag:'wx'});
  const config = read(configPath);
  config.plugins.load ??= {};
  config.plugins.load.paths = [...new Set([...(config.plugins.load.paths ?? []),stubRoot])];
  config.plugins.allow = [...new Set([...(config.plugins.allow ?? []),stubId])];
  config.plugins.entries[stubId] = {enabled:true};
  write(configPath,config);
  write(path.join(out,'fixture.json'),{stubId,stubPackage,stubPath,stubSha256:digest(stubPath),canonicalRoot,canonicalHashes:canonicalHashes()});
  fs.writeFileSync(path.join(out,'stub-original.json'),bytes,{mode:0o600});
} else if (mode === 'observe') {
  console.log(JSON.stringify(observe()));
} else if (mode === 'assert-before') {
  const snapshot = observe();
  assertPreserved(snapshot);
  assertConfiguredStub(snapshot);
  fs.copyFileSync(configPath,path.join(out,'config-before-update.json'));
  assert.equal(snapshot.installedPackage.version,'2026.9.7','Installed updater is not published 2026.9.7');
  if (path.basename(out) === 'direct') {
    assert.equal(Object.hasOwn(snapshot.records,stubId),false,'Direct input was repaired before update');
  } else {
    const record = snapshot.records[stubId];
    assert(record,'Published CLI did not install the stub package');
    assert.equal(record.source,'npm');
    assert.equal(record.version,'1.0.0');
    assert.equal(read(path.join(record.installPath,'openclaw.plugin.json')).id,stubId);
    write(path.join(out,'bridge-behavior.json'),{kind:'published-manual-install-bridge',record,
      directUpdateProof:false,description:'The published 2026.9.7 plugins install command installed the synthetic package with explicit capability consent; published Doctor then ran before the updater.'});
  }
} else if (mode === 'assert-first-hop' || mode === 'assert-after-doctor') {
  const snapshot = read(path.join(out,`${phase}.json`));
  assertPreserved(snapshot);
  assertCandidate(snapshot);
  assertRecordOutcome(snapshot);
  const update = JSON.parse(fs.readFileSync(path.join(out,'update.out'),'utf8'));
  assert.equal(Number(fs.readFileSync(path.join(out,'update.exit'),'utf8')),0,'Published updater exited unsuccessfully');
  assert.equal(update.status,'ok','Published updater did not report a successful update');
  assert.equal(update.after?.version,snapshot.installedPackage.version);
  if (update.run) {
    assert.equal(update.run.status,'succeeded');
    assert.equal(update.run.phase,'finished');
  }
  if (mode === 'assert-after-doctor') {
    assert.deepEqual(snapshot.records,read(path.join(out,'first-hop.json')).records,'Repeated Doctor changed plugin installation records');
  }
} else if (mode === 'assert-availability') {
  const marker = fs.readFileSync(path.join(out,`${phase}-canonical-cli.out`),'utf8');
  assert(marker.split(/\r?\n/u).some(line=>line.trim()==='lg-npm-canonical:pong'),'Canonical plugin CLI did not execute');
  const inspected = JSON.parse(fs.readFileSync(path.join(out,`${phase}-canonical-inspect.out`),'utf8'));
  assert.equal(inspected.plugin.id,canonicalId);
  assert.equal(inspected.plugin.status,'loaded');
  assert.equal(inspected.plugin.enabled,true);
  if (path.basename(out) === 'direct') {
    assert.equal(Number(fs.readFileSync(path.join(out,`${phase}-stub-inspect.exit`),'utf8')),1);
    const missing = ['out','err'].map(suffix=>fs.readFileSync(path.join(out,`${phase}-stub-inspect.${suffix}`),'utf8')).join('\n');
    assert(missing.includes(stubId) && /plugin not found/iu.test(missing),'Missing-plugin diagnostic absent');
    assert(/openclaw plugins (?:list|search)|remove it from plugins config/iu.test(missing),'Missing-plugin diagnostic lacks actionable guidance');
  } else {
    const stub = JSON.parse(fs.readFileSync(path.join(out,`${phase}-stub-inspect.out`),'utf8'));
    assert.equal(stub.plugin.id,stubId);
    assert.equal(stub.plugin.enabled,true);
    assert.equal(stub.plugin.status,'loaded');
  }
} else if (mode === 'summary') {
  const cells = Object.fromEntries(['direct','bridge'].map(name=>{
    const dir = path.join(suiteOut,name);
    const exit = Number(fs.readFileSync(path.join(suiteOut,`${name}.exit`),'utf8'));
    const first = fs.existsSync(path.join(dir,'first-hop.json')) ? read(path.join(dir,'first-hop.json')) : undefined;
    return [name,{exit,status:exit===0?'passed':'failed',firstHopObserved:Boolean(first),
      candidateInstalled:first?.candidateInstalled ?? false,
      stubInstalled:first ? Boolean(first.records[stubId]) : null,
      publishedManualInstallBridge:name==='bridge',directUpdateProof:name==='direct'&&exit===0}];
  }));
  const summary = {status:Object.values(cells).every(cell=>cell.exit===0)?'passed':'failed',
    baseline:'openclaw@2026.9.7',sourceHead:fs.readFileSync(path.join(suiteOut,'candidate-head.txt'),'utf8').trim(),
    sourceTree:fs.readFileSync(path.join(suiteOut,'candidate-tree.txt'),'utf8').trim(),
    candidateSha256:fs.readFileSync(path.join(suiteOut,'candidate.sha256'),'utf8').trim(),
    versionFixture:false,reseedingDuringUpdate:false,publishedReleaseProof:false,cells};
  write(path.join(suiteOut,'summary.json'),summary);
  console.log(JSON.stringify(summary,null,2));
} else { throw new Error(`Unknown fixture mode ${mode}`); }
NODE

mkdir -p "$lg_runtime/stub-package" "$lg_runtime/packages"
lg_phase stub-package-fixture node "$lg_runtime/fixture.mjs" stub-package "$lg_source" "$lg_runtime/stub-package" "$lg_artifacts" "$lg_artifacts"
lg_phase stub-package-pack npm pack "$lg_runtime/stub-package" --ignore-scripts --pack-destination "$lg_runtime/packages" --json
lg_stub_archive="$lg_runtime/packages/openclaw-lg-npm-retired-stub-1.0.0.tgz"
[[ -f "$lg_stub_archive" ]]
sha256sum "$lg_stub_archive" > "$lg_artifacts/stub-package.sha256"
source "$lg_source/scripts/e2e/lib/prepublish-plugin-registry.sh"
OPENCLAW_NPM_REGISTRY_DIST_TAGS='' OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org \
  openclaw_prepublish_plugin_registry_start '' '' '' '' "$lg_runtime/registry" lg_registry_pid \
    '@openclaw/lg-npm-retired-stub' '1.0.0' "$lg_stub_archive"
lg_registry="$NPM_CONFIG_REGISTRY"

cat > "$lg_runtime/cell.sh" <<'CELL'
#!/usr/bin/env bash
set -euo pipefail
umask 077
lg_cell="$1" lg_source="$2" lg_runtime="$3" lg_artifacts="$4" lg_candidate="$5" lg_registry="$6"
lg_root="$lg_runtime/$lg_cell"
lg_out="$lg_artifacts/$lg_cell"
lg_prefix="$lg_root/npm-prefix"
lg_state="$lg_root/home/.openclaw"
lg_entry="$lg_prefix/lib/node_modules/openclaw/openclaw.mjs"
mkdir -p "$lg_root/home" "$lg_root/tmp" "$lg_prefix" "$lg_state" "$lg_out"
: > "$lg_root/empty.npmrc"
lg_run() (
  cd "$lg_root/home"
  exec env -i HOME="$lg_root/home" PATH="$lg_prefix/bin:$PATH" CI=1 \
    OPENCLAW_HOME="$lg_root/home" OPENCLAW_STATE_DIR="$lg_state" OPENCLAW_CONFIG_PATH="$lg_state/openclaw.json" \
    OPENCLAW_ALLOW_ROOT=1 OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1 \
    OPENCLAW_SKIP_PROVIDERS=1 OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_CRON=1 \
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM=1 OPENCLAW_DISABLE_BONJOUR=1 \
    TMPDIR="$lg_root/tmp" XDG_CACHE_HOME="$lg_root/cache" XDG_CONFIG_HOME="$lg_root/config" \
    npm_config_prefix="$lg_prefix" NPM_CONFIG_PREFIX="$lg_prefix" \
    npm_config_userconfig="$lg_root/empty.npmrc" npm_config_cache="$lg_runtime/npm-cache" \
    npm_config_registry="$lg_registry" NPM_CONFIG_REGISTRY="$lg_registry" \
    npm_config_audit=false npm_config_fund=false "$@"
)
lg_phase() {
  local label="$1" started ended result
  shift
  started="$(date +%s)"
  if "$@" > "$lg_out/$label.out" 2> "$lg_out/$label.err"; then result=0; else result=$?; fi
  ended="$(date +%s)"
  printf '%s\t%s\t%s\n' "$label" "$((ended-started))" "$result" >> "$lg_out/timings.tsv"
  printf '%s\n' "$result" > "$lg_out/$label.exit"
  printf 'cell=%s phase=%s seconds=%s exit=%s\n' "$lg_cell" "$label" "$((ended-started))" "$result"
  return "$result"
}
lg_fixture() {
  lg_run node "$lg_runtime/fixture.mjs" "$1" "$lg_source" "$lg_root" "$lg_out" "$lg_artifacts" "${2:-}"
}
lg_phase baseline-install lg_run npm install --global --prefix "$lg_prefix" openclaw@2026.9.7 --registry=https://registry.npmjs.org --no-fund --no-audit
cp "$lg_prefix/lib/node_modules/openclaw/package.json" "$lg_out/baseline-package.json"
cp "$lg_prefix/lib/node_modules/openclaw/dist/build-info.json" "$lg_out/baseline-build-info.json"
node --input-type=module - "$lg_out/baseline-package.json" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).version,'2026.9.7');
NODE
lg_phase baseline-version lg_run node "$lg_entry" --version
lg_phase initial-fixture lg_fixture initial
lg_phase canonical-install lg_run node "$lg_entry" plugins install --link --force --accept-capabilities "$lg_root/canonical-plugin"
lg_phase baseline-doctor lg_run node "$lg_entry" doctor --fix --yes --non-interactive --no-workspace-suggestions
lg_phase baseline-canonical-cli lg_run node "$lg_entry" lgcanonical ping
lg_phase seed-stub lg_fixture seed-stub
if [[ "$lg_cell" == bridge ]]; then
  lg_phase published-manual-install lg_run node "$lg_entry" plugins install 'npm:@openclaw/lg-npm-retired-stub@1.0.0' --accept-capabilities
  lg_phase published-doctor-bridge lg_run node "$lg_entry" doctor --fix --yes --non-interactive --no-workspace-suggestions
fi
lg_phase before-update lg_fixture assert-before before-update
[[ "$(git -C "$lg_source" rev-parse HEAD)" == 2f7a5c015cfa00861f6eb097c6265f2b79c3005b ]]
[[ "$(git -C "$lg_source" rev-parse 'HEAD^{tree}')" == dd7f0bea86a4a7bf91a083f941d0cefc4239b8af ]]
[[ -z "$(git -C "$lg_source" status --porcelain --untracked-files=normal)" ]]
lg_digest="$(sha256sum "$lg_candidate")"
[[ "${lg_digest%% *}" == "$(cat "$lg_artifacts/candidate.sha256")" ]]
printf 'Published 2026.9.7: node %s update --tag file:%s --yes --json --no-restart --timeout 1200\n' "$lg_entry" "$lg_candidate" > "$lg_out/update-command.txt"
# Always capture first-hop durable state before any manual candidate command.
if lg_phase update lg_run node "$lg_entry" update --tag "file:$lg_candidate" --yes --json --no-restart --timeout 1200; then lg_update_exit=0; else lg_update_exit=$?; fi
lg_phase first-hop-observation lg_fixture observe first-hop
lg_phase first-hop-assertions lg_fixture assert-first-hop first-hop
[[ "$lg_update_exit" == 0 ]]
lg_availability() {
  local phase="$1" stub_exit
  lg_phase "$phase-canonical-cli" lg_run node "$lg_entry" lgcanonical ping || return $?
  lg_phase "$phase-canonical-inspect" lg_run node "$lg_entry" plugins inspect lg-npm-canonical --runtime --json || return $?
  if lg_phase "$phase-stub-inspect" lg_run node "$lg_entry" plugins inspect lg-npm-retired-stub --runtime --json; then stub_exit=0; else stub_exit=$?; fi
  if [[ "$lg_cell" == bridge && "$stub_exit" != 0 ]]; then return "$stub_exit"; fi
  lg_phase "$phase-availability-assertions" lg_fixture assert-availability "$phase"
}
lg_availability after-update
lg_phase candidate-doctor-repeat lg_run node "$lg_entry" doctor --fix --yes --non-interactive --no-workspace-suggestions
lg_phase after-doctor-observation lg_fixture observe after-doctor
lg_phase after-doctor-assertions lg_fixture assert-after-doctor after-doctor
lg_availability after-doctor
lg_phase update-status lg_run node "$lg_entry" update status --json
CELL

lg_failed=0
for lg_cell in direct bridge; do
  if lg_phase "$lg_cell" bash "$lg_runtime/cell.sh" "$lg_cell" "$lg_source" "$lg_runtime" "$lg_artifacts" "$lg_candidate" "$lg_registry"; then
    :
  else
    lg_failed=1
  fi
done
node "$lg_runtime/fixture.mjs" summary "$lg_source" "$lg_runtime" "$lg_artifacts" "$lg_artifacts"
[[ "$(git rev-parse HEAD)" == "$lg_head" ]]
[[ "$(git rev-parse 'HEAD^{tree}')" == "$lg_tree" ]]
[[ -z "$(git status --porcelain --untracked-files=normal)" ]]
exit "$lg_failed"
LG_NPM_PROOF
