#!/usr/bin/env bash
# Build one exact candidate artifact, then exercise the installed published updater.
set -euo pipefail
umask 077
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -s)" = Linux
: "${RUNNER_TEMP:?GitHub runner scratch directory required}"
: "${LG_PROOF_EVIDENCE_ROOT:?External evidence root required}"
lg_head=2f7a5c015cfa00861f6eb097c6265f2b79c3005b
lg_tree=dd7f0bea86a4a7bf91a083f941d0cefc4239b8af
lg_payload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
lg_build="$(mktemp -d "$RUNNER_TEMP/lg-runtime-npm-package.XXXXXX")"
lg_out="$LG_PROOF_EVIDENCE_ROOT/npm-package"
mkdir -p "$lg_out"
lg_assert_source() {
  test "$(git rev-parse HEAD)" = "$lg_head"
  test "$(git rev-parse 'HEAD^{tree}')" = "$lg_tree"
  test -z "$(git status --porcelain --untracked-files=normal)"
}
lg_assert_source
printf 'provider=github-hosted\nrun=%s\nattempt=%s\nhead=%s\ntree=%s\n' \
  "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$lg_head" "$lg_tree" > "$lg_out/identity.txt"
trap 'lg_rc=$?; printf "%s\n" "$lg_rc" > "$lg_out/exit-code.txt"' EXIT
lg_timed() {
  local label="$1" result
  shift
  if /usr/bin/time -f '%e' -o "$lg_out/$label.seconds" "$@" > "$lg_out/$label.out" 2> "$lg_out/$label.err"; then result=0; else result=$?; fi
  printf '%s\t%s\t%s\n' "$label" "$(tail -n 1 "$lg_out/$label.seconds")" "$result" >> "$lg_out/timings.tsv"
  printf 'phase=%s seconds=%s exit=%s\n' "$label" "$(tail -n 1 "$lg_out/$label.seconds")" "$result"
  if [ "$result" -ne 0 ]; then tail -n 80 "$lg_out/$label.out" "$lg_out/$label.err"; fi
  return "$result"
}
lg_timed install pnpm install --frozen-lockfile
lg_assert_source
lg_timed package env -u GIT_COMMIT -u GIT_SHA -u GITHUB_SHA node scripts/package-openclaw-for-docker.mjs \
  --allow-unreleased-changelog --output-dir "$lg_build" --output-name openclaw-npm-candidate.tgz \
  --pack-json "$lg_out/pack.json"
lg_archive="$lg_build/openclaw-npm-candidate.tgz"
test -f "$lg_archive"
lg_digest="$(sha256sum "$lg_archive")"
lg_digest="${lg_digest%% *}"
printf '%s\n' "$lg_digest" > "$lg_out/candidate.sha256"
lg_assert_source
lg_timed published-update env LG_CANDIDATE_TGZ="$lg_archive" LG_CANDIDATE_SHA256="$lg_digest" \
  LG_PROOF_ARTIFACTS="$LG_PROOF_EVIDENCE_ROOT/npm-update" bash "$lg_payload/npm-published-update.sh"
lg_assert_source
