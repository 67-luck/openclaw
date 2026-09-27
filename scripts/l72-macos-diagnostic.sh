#!/bin/bash

# Temporary diagnostic branch only; sourced by the existing macOS CI jobs.

run_l72_mac_node_diagnostics() {
  [[ "$TASK" == "test-2" && "$(git rev-parse HEAD)" == "$OPENCLAW_MACOS_NODE_EXPECTED_SHA" ]]
  source .ci-harness/scripts/lib/swift-toolchain.sh
  node_diagnostic_logs="$RUNNER_TEMP/openclaw-macos-node2-diagnostic-logs"
  mkdir -p "$node_diagnostic_logs"
  run_apple_command_logged "$node_diagnostic_logs/darwin-zombie.log" node --import ./scripts/tsx.mjs scripts/l72-darwin-zombie-repro.mts "$PWD" "$node_diagnostic_logs/darwin-zombie-receipt.json"
  exit $?
}

run_l72_presence_diagnostics() {
  mkdir -p "$native_test_log_dir"
  [[ "$(git rev-parse HEAD)" == "$OPENCLAW_PRESENCE_EXPECTED_SHA" ]]
  presence_receipts="$native_test_log_dir/presence-diagnostic-$native_test_log_id.log"
  printf 'diagnostic_only=true\nhead=%s\nexpected_runs=5\n' "$OPENCLAW_PRESENCE_EXPECTED_SHA" > "$presence_receipts"
  printf 'iteration\texit\tstartedUTC\tendedUTC\tlog\n' >> "$presence_receipts"
  presence_failed=0
  presence_completed=0
  for ((presence_iteration=1; presence_iteration<=5; presence_iteration++)); do
    presence_log="$native_test_log_dir/default-presence-$presence_iteration-$native_test_log_id.log"
    presence_started="$(date -u +%FT%TZ)"
    presence_code=0
    run_apple_command_logged "$presence_log" node scripts/test-macos-native.mts default "${swift_test_args[@]}" --skip "AppStateIsolationTests|ProfileChatPreferencesTests|QuickChatCatalogPresentationTests" || presence_code=$?
    presence_completed=$((presence_completed + 1))
    printf '%s\t%s\t%s\t%s\t%s\n' "$presence_iteration" "$presence_code" "$presence_started" "$(date -u +%FT%TZ)" "$presence_log" >> "$presence_receipts"
    if [[ "$presence_code" != 0 ]]; then presence_failed=1; fi
    if [[ "$presence_code" -ge 128 ]] || {
      [[ "$presence_code" != 0 ]] && grep -Eq '\[macos-native\] retained resources after incomplete launch/cleanup:|Managed command cleanup could not verify child, process group, and output closure' "$presence_log"
    }; then
      echo "Native lifetime is interrupted or uncertain; remaining diagnostic runs are unexecuted." >&2
      exit 1
    fi
  done
  printf 'completed_runs=%s\nany_failure=%s\n' "$presence_completed" "$presence_failed" >> "$presence_receipts"
  cat "$presence_receipts"
  [[ "$presence_completed" == 5 ]]
}
