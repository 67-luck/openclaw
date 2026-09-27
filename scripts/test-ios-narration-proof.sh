#!/bin/bash
# Verification-branch driver: real iOS app, synthetic loopback Gateway, exact source revisions.
set -euo pipefail
source_repo="$(cd "$1" && pwd)"
proof_repo="$(cd "$2" && pwd)"
output="$3"
candidate="$4"
device_family="${5:-iPhone}"
stage=after
[[ "$device_family" == iPhone || "$device_family" == iPad ]]
[[ "$candidate" =~ ^[0-9a-f]{40}$ ]]
mkdir -p "$output"
output="$(cd "$output" && pwd)"
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-narration.XXXXXX")"
simulator=""
fixture_pid=""
recorder_pid=""
checkout=""
cleanup() {
  local status=$?
  if [[ -n "$recorder_pid" ]]; then kill -INT "$recorder_pid" 2>/dev/null || true; wait "$recorder_pid" || true; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" || true; fi
  if [[ -n "$simulator" ]]; then
    xcrun simctl shutdown "$simulator" 2>/dev/null || true
    xcrun simctl delete "$simulator" || true
  fi
  if [[ -n "$checkout" ]]; then git -C "$source_repo" worktree remove --force "$checkout" || true; fi
  rm -rf "$scratch"
  if [[ "$status" -ne 0 ]]; then printf '[ios-narration-proof] FAILED (exit %s)\n' "$status" >&2; fi
}
trap cleanup EXIT

test "$(git -C "$source_repo" rev-parse HEAD)" = "$candidate"
# Check physical devices before choosing a task-owned simulator on the hosted Mac.
xcrun devicectl list devices > "$output/physical-devices.txt"
xcrun simctl list devices available --json > "$scratch/devices.json"
xcrun simctl help io > "$output/simctl-io-contract.txt"
node -e '
const fs=require("node:fs");
const runtimes=Object.entries(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).devices);
const family=process.argv[2];
for(const [runtime,devices] of runtimes){
 const device=devices.find(d=>d.isAvailable&&d.name.startsWith(family));
 if(device){console.log(device.name);console.log(runtime);process.exit(0);}
}
throw new Error(`No available ${family} simulator`);
' "$scratch/devices.json" "$device_family" > "$scratch/device.txt"
device="$(sed -n '1p' "$scratch/device.txt")"
runtime="$(sed -n '2p' "$scratch/device.txt")"
printf 'Candidate: %s\nDevice: %s\nRuntime: %s\n' \
  "$candidate" "$device" "$runtime" > "$output/provenance.txt"
xcodebuild -version >> "$output/provenance.txt"
swift --version >> "$output/provenance.txt"

export TEST_RUNNER_OPENCLAW_IOS_LIVE_GATEWAY=1
export TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE='{"url":"ws://127.0.0.1:19876","token":"synthetic-navigation-token"}'
export TEST_RUNNER_OPENCLAW_IOS_NARRATION_FIXTURE_URL=http://127.0.0.1:19876

revision="$candidate"
git -C "$source_repo" cat-file -e "$revision^{commit}"
checkout="$scratch/$stage"
git -C "$source_repo" worktree add --detach "$checkout" "$revision"
# The index freezes the reviewed product bytes, including newly added files.
# Build helpers may change generated files, never the pinned native sources.
expected_tree="$(git -C "$checkout" write-tree)"
printf '%s source tree: %s\n' "$stage" "$expected_tree" >> "$output/provenance.txt"
# Reuse the inspected baseline UI scenario without changing product sources.
cp "$proof_repo/apps/ios/UITests/OpenClawSnapshotUITests.swift" "$checkout/apps/ios/UITests/"
cp "$proof_repo/scripts/test-ios-shell-gateway.mjs" "$checkout/scripts/"
(
  cd "$checkout"
  pnpm install --frozen-lockfile
  ./scripts/ios-configure-signing.sh
  ./scripts/ios-write-version-xcconfig.sh
  node scripts/ios-write-swift-filelist.mjs
  xcodegen generate --spec apps/ios/project.yml --project apps/ios
) > "$output/$stage-setup.log" 2>&1
git -C "$checkout" diff --exit-code -- apps/ios/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests
simulator="$(xcrun simctl create "OpenClaw narration $device_family $stage $$" "$device" "$runtime")"
xcrun simctl boot "$simulator"
xcrun simctl bootstatus "$simulator" -b
xcrun simctl status_bar "$simulator" override --time 09:41 --batteryState charged --batteryLevel 100
xcrun simctl ui "$simulator" appearance dark
args=(
  -project "$checkout/apps/ios/OpenClaw.xcodeproj" -scheme OpenClawUITests
  -configuration Debug -destination "platform=iOS Simulator,id=$simulator"
  -derivedDataPath "$scratch/derived-$stage"
  -clonedSourcePackagesDirPath "$scratch/packages"
  -testLanguage en -testRegion US -parallel-testing-enabled NO
  -only-testing:OpenClawUITests/OpenClawSnapshotUITests/testLiveGatewayInlineNarrationAndRecovery
)
if ! xcodebuild "${args[@]}" build-for-testing > "$output/$stage-build.log" 2>&1; then
  tail -n 100 "$output/$stage-build.log"
  exit 1
fi
fixture_args=(--narration --narration-pending-tool)
node "$checkout/scripts/test-ios-shell-gateway.mjs" "${fixture_args[@]}" > "$output/$stage-gateway.log" 2>&1 &
fixture_pid=$!
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:19876/narration > "$output/$stage-initial.json"; then break; fi
  kill -0 "$fixture_pid"
  sleep 1
done
curl --fail --silent http://127.0.0.1:19876/narration > "$output/$stage-initial.json"
export TEST_RUNNER_OPENCLAW_IOS_NARRATION_STAGE="$stage"
export TEST_RUNNER_OPENCLAW_IOS_GROUPING_COMPARISON=1
unset TEST_RUNNER_OPENCLAW_IOS_NARRATION_BASELINE
node -e 'console.log(Date.now())' > "$output/$stage-recording-start.txt"
xcrun simctl io "$simulator" recordVideo --codec=h264 --force "$output/$stage.mov" > "$output/$stage-recorder.log" 2>&1 &
recorder_pid=$!
status=0
xcodebuild "${args[@]}" -collect-test-diagnostics never \
  -resultBundlePath "$output/$stage.xcresult" test-without-building > "$output/$stage-test.log" 2>&1 || status=$?
kill -INT "$recorder_pid"
wait "$recorder_pid"
recorder_pid=""
curl --fail --silent http://127.0.0.1:19876/narration > "$output/$stage-events.json"
xcrun xcresulttool get test-results summary --path "$output/$stage.xcresult" --compact > "$output/$stage-summary.json"
xcrun xcresulttool export attachments --path "$output/$stage.xcresult" --output-path "$output/$stage-images"
tail -n 80 "$output/$stage-test.log"
[[ "$status" -eq 0 ]]
node -e 'const r=require(process.argv[1]);if(r.result!=="Passed"||r.failedTests!==0||r.passedTests!==1)process.exit(1)' "$output/$stage-summary.json"
git -C "$checkout" diff --exit-code -- apps/ios/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests
test "$(git -C "$checkout" write-tree)" = "$expected_tree"
test -z "$(git -C "$checkout" ls-files --others --exclude-standard -- apps/ios/Sources apps/shared/OpenClawKit/Sources apps/shared/OpenClawKit/Tests)"
kill "$fixture_pid"
wait "$fixture_pid"
fixture_pid=""
xcrun simctl shutdown "$simulator"
xcrun simctl delete "$simulator"
simulator=""
git -C "$source_repo" worktree remove --force "$checkout"
checkout=""
