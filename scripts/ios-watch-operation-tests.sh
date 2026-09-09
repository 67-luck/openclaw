#!/bin/bash
set -euo pipefail

result_bundle="${1:-apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult}"
simulator_id="$(
  xcrun simctl list devices available --json | node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const runtimes = JSON.parse(Buffer.concat(chunks).toString("utf8")).devices;
    const simulator = Object.values(runtimes)
      .flat()
      .find((device) => device.isAvailable && device.name.startsWith("Apple Watch"));
    if (!simulator) {
      console.error("No available Apple Watch simulator for operation lifecycle tests");
      process.exit(1);
    }
    process.stdout.write(simulator.udid);
  '
)"
# Reuse existing products and resolve the selected target from Xcode, not DerivedData naming.
xcodebuild_args=(
  -project apps/ios/OpenClaw.xcodeproj
  -scheme OpenClawWatchApp
  -configuration Debug
  -destination "platform=watchOS Simulator,id=${simulator_id}"
  CODE_SIGNING_ALLOWED=NO
)
test_args=(
  -parallel-testing-enabled NO
  -only-testing:OpenClawWatchTests/WatchInboxStoreOperationTests
  -only-testing:OpenClawWatchTests/WatchSpeechPlaybackTests
  -only-testing:OpenClawWatchTests/WatchRealtimeMediaTests
  -only-testing:OpenClawWatchTests/WatchGatewayConfigurationTests
  -only-testing:OpenClawWatchTests/WatchDirectConversationTests
  -only-testing:OpenClawWatchTests/WatchGatewayControllerTests
)
xcodebuild "${xcodebuild_args[@]}" "${test_args[@]}" build-for-testing
app_path="$(
  xcodebuild "${xcodebuild_args[@]}" -showBuildSettings -json |
    node --input-type=module -e '
      import path from "node:path";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const targets = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        .filter((target) => target.target === "OpenClawWatchApp");
      if (targets.length !== 1) throw new Error("Expected one Watch app target from Xcode");
      const { TARGET_BUILD_DIR, FULL_PRODUCT_NAME } = targets[0].buildSettings;
      if (!path.isAbsolute(TARGET_BUILD_DIR) || !FULL_PRODUCT_NAME) {
        throw new Error("Expected an absolute Watch app product from Xcode");
      }
      process.stdout.write(path.join(TARGET_BUILD_DIR, FULL_PRODUCT_NAME));
    '
)"
xcrun simctl boot "$simulator_id" 2>/dev/null || true
xcrun simctl bootstatus "$simulator_id" -b
xcrun simctl install "$simulator_id" "$app_path"
xcodebuild "${xcodebuild_args[@]}" "${test_args[@]}" \
  -resultBundlePath "$result_bundle" \
  test-without-building
