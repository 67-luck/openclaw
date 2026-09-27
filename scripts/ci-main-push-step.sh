#!/usr/bin/env bash

if [[ "${OPENCLAW_CI_MAIN_PUSH_GATE:-}" != true ]]; then
  exec bash --noprofile --norc -e -o pipefail "$1"
fi

log_file=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/openclaw-ci-main-push.XXXXXX") || exit 1
trap 'rm -f -- "$log_file"' EXIT

# Keep errexit in the child shell; the wrapper must survive long enough to report it.
set +e
bash --noprofile --norc -e -o pipefail "$1" 2>&1 | tee "$log_file"
pipeline_exits=("${PIPESTATUS[@]}")
step_exit=${pipeline_exits[0]}
if [[ "$step_exit" -eq 0 ]]; then
  step_exit=${pipeline_exits[1]}
fi
if [[ "$step_exit" -eq 0 ]]; then
  exit 0
fi

escape_html() {
  LC_ALL=C sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

job=${GITHUB_JOB:-unknown}
step=${GITHUB_ACTION:-unknown}
base=${OPENCLAW_CI_PUSH_BASE:-unknown}
head=${OPENCLAW_CI_PUSH_HEAD:-unknown}
annotation="Main push gate failed: job=$job step=$step exit=$step_exit range=$base..$head. See the job summary and step log."
annotation=${annotation//%/%25}
annotation=${annotation//$'\r'/%0D}
annotation=${annotation//$'\n'/%0A}
printf '::error title=Main push gate failed::%s\n' "$annotation"

write_summary() {
  printf '## Main push gate failed\n\n<pre>'
  printf 'Job: %s\nStep: %s\nExit code: %s\nPushed range: %s..%s\n' \
    "$job" "$step" "$step_exit" "$base" "$head" | escape_html
  printf '</pre>\n\n### Commits in the pushed range\n\n<pre>'
  if [[ "$base" =~ ^[0-9a-f]{40}$ && "$head" =~ ^[0-9a-f]{40}$ ]] && \
    commits=$(GIT_NO_LAZY_FETCH=1 git --no-pager log --no-show-signature --format='%h %s' -100 "$base..$head" -- 2>/dev/null); then
    printf '%s\n' "$commits" | head -c 16384 | escape_html
    printf '\n(Up to 100 commits; commit text capped at 16 KiB.)\n'
  else
    printf 'Commit history is unavailable in this checkout.\n'
  fi
  printf '</pre>\n\n### Diagnostic output\n\n<pre>'
  log_bytes=$(wc -c < "$log_file")
  if [[ "$log_bytes" -le 32768 ]]; then
    escape_html < "$log_file"
  else
    head -c 16384 "$log_file" | escape_html
    printf '\n\n[Middle of output omitted; complete output is in the step log.]\n\n'
    tail -c 16384 "$log_file" | escape_html
  fi
  printf '\n</pre>\n'
}

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  if ! write_summary >> "$GITHUB_STEP_SUMMARY"; then
    printf '::warning::Could not append the main push failure summary; see the step log.\n'
  fi
fi
exit "$step_exit"
