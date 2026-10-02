#!/usr/bin/env bash
# Hosted proof only. Arguments are the independently reviewed Usage source pins.
set -euo pipefail
umask 077
test "${GITHUB_ACTIONS:-}" = true
usage_head="${1:?Usage full commit SHA required}"
usage_tree="${2:?Usage reviewed tree SHA required}"
[[ "$usage_head" =~ ^[0-9a-f]{40}$ && "$usage_tree" =~ ^[0-9a-f]{40}$ ]]
: "${LG_PROOF_ARTIFACTS:?External evidence directory required}"
: "${RUNNER_TEMP:?GitHub runner scratch directory required}"
test "$(uname -s)" = Linux
usage_candidate="$(pwd -P)"
usage_payload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
usage_base=6ec9fc1f02627b90da5c9fa2681b2f537173c8cc
usage_prefence_tree=f2724a16e38aa43866f9c62a7887f161ad5dda13
usage_root="$(mktemp -d "$RUNNER_TEMP/lg-runtime-usage.XXXXXX")"
usage_evidence="$LG_PROOF_ARTIFACTS"
usage_original="$usage_root/original"
usage_prefence="$usage_root/pre-fence"
mkdir -p "$usage_evidence"
printf 'provider=github-hosted\nrun=%s\nattempt=%s\nhead=%s\ntree=%s\nbase=%s\nprefenceTree=%s\n' \
  "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "$usage_head" "$usage_tree" "$usage_base" "$usage_prefence_tree" \
  > "$usage_evidence/identity.txt"
trap 'usage_rc=$?; printf "%s\n" "$usage_rc" > "$usage_evidence/exit-code.txt"; printf "Usage proof=%s exit=%s\n" "$usage_evidence" "$usage_rc"' EXIT
usage_timed() {
  local label="$1" result
  shift
  printf 'phase=%s start\n' "$label"
  if /usr/bin/time -f '%e' -o "$usage_evidence/$label.seconds" \
    "$@" > "$usage_evidence/$label.out" 2> "$usage_evidence/$label.err"; then result=0; else result=$?; fi
  printf '%s\t%s\t%s\n' "$label" "$(tail -n 1 "$usage_evidence/$label.seconds")" "$result" >> "$usage_evidence/timings.tsv"
  printf 'phase=%s seconds=%s exit=%s\n' "$label" "$(tail -n 1 "$usage_evidence/$label.seconds")" "$result"
  if [ "$result" -ne 0 ]; then tail -n 80 "$usage_evidence/$label.out" "$usage_evidence/$label.err"; fi
  return "$result"
}
usage_assert_candidate() {
  test "$(git -C "$usage_candidate" rev-parse HEAD)" = "$usage_head"
  test "$(git -C "$usage_candidate" rev-parse 'HEAD^{tree}')" = "$usage_tree"
  test -z "$(git -C "$usage_candidate" status --porcelain --untracked-files=normal)"
}
usage_assert_candidate
git -c gc.auto=0 fetch --no-tags --no-write-fetch-head --depth=1 https://github.com/openclaw/openclaw.git "$usage_base"
git cat-file -e "$usage_base^{commit}"
base64 --decode "$usage_payload/usage-pre-fence.patch.b64" > "$usage_root/pre-fence.patch"
usage_patch_digest="$(sha256sum "$usage_root/pre-fence.patch")"
test "${usage_patch_digest%% *}" = 6787609e06257b1f9b115dbbf1a783106f66476d68dc3909554a3a3edbe556ab
cat > "$usage_root/assert-negative.mjs" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const [file, title, marker] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = report.testResults.flatMap(result => result.assertionResults).filter(result => result.status === 'failed');
assert.equal(report.numFailedTests, 1, 'Negative control failed outside its one asserted contract');
assert.equal(failures.length, 1);
assert(failures[0].fullName.includes(title));
assert(failures[0].failureMessages.some(message => message.includes(marker)),
  'Negative control failed before the intended assertion');
console.log(JSON.stringify({expectedFailure:true,title:failures[0].fullName,marker}));
NODE
(
  cd "$usage_candidate"
  usage_timed candidate-install pnpm install --frozen-lockfile
)
usage_assert_candidate
# Final candidate source is never patched for the negative controls.
git worktree add --detach "$usage_original" "$usage_base"
git -C "$usage_original" sparse-checkout disable
(
  cd "$usage_original"
  usage_timed original-install pnpm install --frozen-lockfile
  test -z "$(git status --porcelain --untracked-files=normal)"
  cat > src/infra/session-cost-usage.original-negative.test.ts <<'TEST'
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveExistingUsageSessionFile } from "./session-cost-usage.js";
const roots = useAutoCleanupTempDirTracker(afterEach);
it("retired usage locator cannot override explicit artifact", async () => {
  const root = roots.make("usage-original-");
  const artifact = path.join(root, "session.jsonl");
  fs.writeFileSync(artifact, "Synthetic explicit usage artifact\n");
  const input = {
    agentId: "main", sessionId: "session", sessionFile: artifact,
    sessionEntry: { sessionId: "session", updatedAt: 1,
      sessionFile: `sqlite:main:session:${path.join(root, "retired-store.sqlite")}` },
  };
  expect(await resolveExistingUsageSessionFile(input),
    "RETIRED_USAGE_LOCATOR_OVERRIDES_EXPLICIT_ARTIFACT").toBe(artifact);
});
TEST
  if usage_timed original-negative env OPENCLAW_TEST_PROJECTS_PARALLEL=1 \
    pnpm test src/infra/session-cost-usage.original-negative.test.ts --maxWorkers=1 \
    --reporter=json --outputFile="$usage_evidence/original-negative.json"; then
    printf 'Original defect did not reproduce\n' >&2
    exit 1
  else
    usage_negative_rc=$?
  fi
  test "$usage_negative_rc" -eq 1
  node "$usage_root/assert-negative.mjs" "$usage_evidence/original-negative.json" \
    'retired usage locator cannot override explicit artifact' \
    RETIRED_USAGE_LOCATOR_OVERRIDES_EXPLICIT_ARTIFACT > "$usage_evidence/original-negative-assertion.json"
)
git worktree add --detach "$usage_prefence" "$usage_base"
git -C "$usage_prefence" sparse-checkout disable
(
  cd "$usage_prefence"
  usage_timed prefence-install pnpm install --frozen-lockfile
  test -z "$(git status --porcelain --untracked-files=normal)"
  git apply --index "$usage_root/pre-fence.patch"
  test "$(git write-tree)" = "$usage_prefence_tree"
  cp "$usage_candidate/src/gateway/server-methods/usage.sessions-usage-context-lifecycle.integration.test.ts" \
    src/gateway/server-methods/usage.sessions-usage-context-lifecycle.integration.test.ts
  node --input-type=module - src/gateway/server-methods/usage.sessions-usage-context-lifecycle.integration.test.ts <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const old = 'expect(summaryLoader).not.toHaveBeenCalled();';
assert.equal(source.split(old).length, 2, 'The expected denial assertion changed');
fs.writeFileSync(file, source.replace(old,
  'expect(summaryLoader, "USAGE_REVOCATION_REACHED_SUMMARY_LOADER").not.toHaveBeenCalled();'));
NODE
  if usage_timed prefence-negative env OPENCLAW_TEST_PROJECTS_PARALLEL=1 \
    pnpm test src/gateway/server-methods/usage.sessions-usage-context-lifecycle.integration.test.ts \
    --maxWorkers=1 -t 'revocation during target read' \
    --reporter=json --outputFile="$usage_evidence/prefence-negative.json"; then
    printf 'Pre-fence sharing defect did not reproduce\n' >&2
    exit 1
  else
    usage_negative_rc=$?
  fi
  test "$usage_negative_rc" -eq 1
  node "$usage_root/assert-negative.mjs" "$usage_evidence/prefence-negative.json" \
    'revocation during target read' USAGE_REVOCATION_REACHED_SUMMARY_LOADER \
    > "$usage_evidence/prefence-negative-assertion.json"
)
(
  cd "$usage_candidate"
  usage_assert_candidate
  usage_test_index=0
  for usage_test_file in \
    src/infra/session-cost-usage.test.ts \
    src/infra/session-cost-usage.archive-identity.test.ts \
    src/gateway/server-methods/usage.sessions-usage.test.ts \
    src/gateway/server-methods/usage.sessions-usage-context-lifecycle.integration.test.ts \
    src/gateway/server-methods/usage.sessions-usage-owner-attribution.integration.test.ts \
    src/status/status-text.test.ts; do
    usage_test_index=$((usage_test_index + 1))
    usage_test_label="$(printf 'candidate-test-%02d' "$usage_test_index")"
    printf '%s\t%s\n' "$usage_test_label" "$usage_test_file" >> "$usage_evidence/tests.tsv"
    usage_timed "$usage_test_label" env OPENCLAW_TEST_PROJECTS_PARALLEL=1 \
      pnpm test "$usage_test_file" --maxWorkers=1 \
      --reporter=json --outputFile="$usage_evidence/$usage_test_label.json"
  done
  usage_assert_candidate
)
node --input-type=module - "$usage_evidence" "$usage_head" "$usage_tree" "$usage_base" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const [out,head,tree,base]=process.argv.slice(2);
const tests=fs.readFileSync(path.join(out,'tests.tsv'),'utf8').trim().split('\n').map(line=>line.split('\t'));
assert.equal(tests.length,6);
const positives=tests.map(([label,file])=>{
  const report=JSON.parse(fs.readFileSync(path.join(out,`${label}.json`),'utf8'));
  assert.equal(report.numFailedTests,0);
  assert.equal(report.numFailedTestSuites,0);
  assert(report.numPassedTests>0);
  return {file,passed:report.numPassedTests,wallSeconds:Number(fs.readFileSync(path.join(out,`${label}.seconds`),'utf8').trim())};
});
const negatives=['original-negative-assertion.json','prefence-negative-assertion.json'].map(file=>{
  const receipt=JSON.parse(fs.readFileSync(path.join(out,file),'utf8'));
  assert.equal(receipt.expectedFailure,true);
  return receipt;
});
const receipt={status:'passed',provider:'github-hosted',head,tree,base,positives,negatives,
  nativeGates:'not rerun; separately owned by exact-head normal CI'};
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
NODE
