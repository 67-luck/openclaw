#!/bin/bash
set -euo pipefail

output_dir="${1:?Expected a task-owned capture directory}"
mkdir -p "$output_dir"
simulator_id="$(
  xcrun simctl list devices available --json | node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const device = Object.values(JSON.parse(Buffer.concat(chunks)).devices).flat()
      .find((entry) => entry.isAvailable && entry.name.startsWith("Apple Watch"));
    if (!device) throw new Error("No available Watch simulator");
    process.stdout.write(device.udid);
  '
)"
bundle_id="$(
  xcodebuild -project apps/ios/OpenClaw.xcodeproj -scheme OpenClawWatchApp \
    -configuration Debug -destination "platform=watchOS Simulator,id=${simulator_id}" \
    CODE_SIGNING_ALLOWED=NO -showBuildSettings -json |
    node --input-type=module -e '
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const targets = JSON.parse(Buffer.concat(chunks)).filter((entry) => entry.target === "OpenClawWatchApp");
      if (targets.length !== 1) throw new Error("Expected one Watch app target");
      const id = targets[0].buildSettings.PRODUCT_BUNDLE_IDENTIFIER;
      if (!id) throw new Error("Missing Watch bundle identifier");
      process.stdout.write(id);
    '
)"
console_pid=""
cleanup() {
  if [ -n "$console_pid" ]; then
    xcrun simctl terminate "$simulator_id" "$bundle_id" >/dev/null 2>&1 || true
    kill "$console_pid" 2>/dev/null || true
    wait "$console_pid" || true
    console_pid=""
  fi
}
trap cleanup EXIT
for scenario in payment payment-terms standing-grant standing-grant-terms unsupported-context \
  creation-failed creation-unknown creation-succeeded no-conversation; do
  console_log="$output_dir/$scenario.log"
  xcrun simctl launch --terminate-running-process --console "$simulator_id" "$bundle_id" \
    "--openclaw-watch-direct-proof=$scenario" >"$console_log" 2>&1 &
  console_pid="$!"
  deadline="$((SECONDS + 20))"
  until grep -q "watch-direct-proof-ready:$scenario" "$console_log"; do
    if [ "$SECONDS" -ge "$deadline" ] || ! kill -0 "$console_pid" 2>/dev/null; then
      echo "error: Watch direct capture did not reach its rendered scenario: $scenario" >&2
      exit 1
    fi
    sleep 0.1
  done
  # Readiness comes from the rendered view; require stable pixels before retaining the capture.
  previous=""
  until [ "$SECONDS" -ge "$deadline" ]; do
    xcrun simctl io "$simulator_id" screenshot "$output_dir/$scenario.png"
    digest="$(shasum -a 256 "$output_dir/$scenario.png" | awk '{print $1}')"
    if [ "$digest" = "$previous" ]; then break; fi
    previous="$digest"
    sleep 0.2
  done
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "error: Watch direct capture did not settle: $scenario" >&2
    exit 1
  fi
  cleanup
done
