import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parse } from "yaml";
import {
  formatIosSimulatorSelectionSummary,
  resolveIosSimulatorTestSelection,
} from "../../scripts/lib/ci-ios-smoke-plan.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";
import {
  createVoiceFixture,
  runWatchPhase,
} from "../../scripts/ios-watch-operator-https-proof.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../helpers/tls-fixture.js";

type Command = { tool: string; args: string[]; destination?: string; settings?: string };

function isTestCommand(command: Command) {
  return (
    command.tool === "xcodebuild" &&
    command.args.some((arg) => arg === "test" || arg === "test-without-building")
  );
}

type Step = { name?: string; run?: string; if?: string };
const workflow: {
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      steps?: Step[];
      strategy?: { matrix?: { phase?: string } };
    }
  >;
} = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const watchStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const voiceStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Run focused iOS voice cleanup simulator tests",
);
const iosStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Run focused iOS lifecycle simulator tests",
);
const prepareStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Prepare iOS simulator",
);
const buildStep = workflow.jobs["ios-build"]?.steps?.find((step) => step.name === "Build iOS app");
const configureStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Configure iOS build and report simulator selection",
);
const qualification = parse(readFileSync(".github/workflows/ios-periphery.yml", "utf8"));
const qualificationSteps: {
  id?: string;
  name: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}[] = qualification.jobs.scan.steps;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runXcodeSelection(qualificationMode: boolean, present = true, version = "26.6") {
  const root = tempDirs.make("watch-xcode-selection-");
  const envFile = path.join(root, "github-env");
  const commandsFile = path.join(root, "commands");
  const step = qualificationSteps.find((entry) => entry.name === "Verify Xcode");
  assert(step?.run);
  // Execute the actual workflow shell; only filesystem and native commands are fixtures.
  const prelude = String.raw`
function test {
  if [[ "$1" == "-d" ]]; then
    [[ "$2" == "/Applications/Xcode_26.6.app/Contents/Developer" && "$XCODE_PRESENT" == "true" ]]
  else builtin test "$@"; fi
}
function [ {
  if [[ "$1" == "-d" ]]; then test -d "$2"; else builtin [ "$@"; fi
}
function sudo { printf 'sudo:%s\n' "$*" >> "$XCODE_COMMANDS"; }
function xcodebuild {
  local selected="$DEVELOPER_DIR"
  if [[ -z "$selected" ]]; then selected=unset; fi
  printf 'xcodebuild:%s\n' "$selected" >> "$XCODE_COMMANDS"
  printf 'Xcode %s\nBuild version fixture\n' "$XCODE_VERSION"
}
function swift {
  local selected="$DEVELOPER_DIR"
  if [[ -z "$selected" ]]; then selected=unset; fi
  printf 'swift:%s\n' "$selected" >> "$XCODE_COMMANDS"
}
`;
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", prelude + step.run], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      DEVELOPER_DIR: "",
      WATCH_QUALIFICATION: String(qualificationMode),
      XCODE_PRESENT: String(present),
      XCODE_VERSION: version,
      XCODE_COMMANDS: commandsFile,
      GITHUB_ENV: envFile,
    },
  });
  return {
    result,
    commands: existsSync(commandsFile) ? readFileSync(commandsFile, "utf8").trim().split("\n") : [],
    environment: existsSync(envFile) ? readFileSync(envFile, "utf8") : "",
  };
}

function runSimulatorStep(
  mode = "ready",
  steps = [watchStep],
  env: Record<string, string> = {},
  phases?: string[],
) {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const harnessLib = path.join(root, ".ci-harness", "scripts", "lib");
  const temporaryRoot = path.join(root, "temporary");
  const product = path.join(root, "project derived data", "Watch Product.app");
  const testProduct = path.join(product, "PlugIns", "Watch Tests.xctest");
  mkdirSync(bin, { recursive: true });
  mkdirSync(harnessLib, { recursive: true });
  copyFileSync("scripts/lib/swift-toolchain.sh", path.join(harnessLib, "swift-toolchain.sh"));
  copyFileSync("scripts/lib/ci-ios-smoke-plan.mjs", path.join(harnessLib, "ci-ios-smoke-plan.mjs"));
  mkdirSync(temporaryRoot);
  mkdirSync(testProduct, { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts/ios-watch-operation-tests.sh"),
    readFileSync("scripts/ios-watch-operation-tests.sh"),
  );
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
const productPath = path.join(root, "project derived data", "Watch Product.app");
const targetTempDir = path.join(root, "project intermediates", "Watch Product.build");
const generatedPath = path.join(targetTempDir, "Watch Product.app-Simulated.xcent");
const applicationID = (mode === "mixed-case-prefix" ? "SeedFix123" : "SEEDFIX123") + ".org.example.watch";
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({
  tool, args, destination: process.env.IOS_DEST,
  settings: process.env.XCODE_XCCONFIG_FILE ? readFileSync(process.env.XCODE_XCCONFIG_FILE, "utf8") : undefined,
}) + "\n");
if (tool === "installer") {
  if (mode.endsWith("install-failed")) process.exit(23);
  mkdirSync(args[0], { recursive: true });
  copyFileSync(path.join(root, "bin", "simslim"), path.join(args[0], "simslim"));
} else if (tool === "simslim") {
  if (mode.endsWith(args[0] + "-failed")) process.exit(23);
} else if (tool === "uname") {
  console.log("arm64");
} else if (tool === "xcrun") {
  if (args[0] === "segedit") {
    const output = args[5];
    if (output === "-" || !path.isAbsolute(output) ||
        (statSync(path.dirname(output)).mode & 0o777) !== 0o700) {
      throw new Error("Expected a private extraction directory and real output file");
    }
    if (mode === "missing-section") process.exit(26);
    const entitlements = mode === "missing-application-id" ? {} : {
      "application-identifier": mode === "wrong-application-id" ?
        "SEEDFIX123.org.example.other" : mode === "wrong-compiled-seed" ?
        "TEAMFIX123.org.example.watch" : mode === "compiled-seed-case-mismatch" ?
        "seedfix123.org.example.watch" : applicationID
    };
    if (mode === "explicit-private-group") {
      entitlements["keychain-access-groups"] = ["SEEDFIX123.org.example.watch"];
    } else if (mode === "malformed-keychain-groups") {
      entitlements["keychain-access-groups"] = "not-an-array";
    }
    writeFileSync(output, mode === "malformed-section" ? "not a plist" : JSON.stringify(entitlements));
  } else if (args[1] === "list" && args[2] === "pairs") {
    console.log(JSON.stringify({ pairs: mode === "unpaired" ? {} : {
      unrelated: { watch: { udid: "other-watch" }, phone: { udid: "other-phone" } },
      selected: { watch: { udid: "watch-fixture" }, phone: { udid: "companion-fixture" } }
    } }));
  } else if (args[1] === "list") {
    console.log(JSON.stringify({ devices: { watch: [
      { name: mode.startsWith("voice") ? "iPhone fixture" : "Apple Watch fixture", isAvailable: true,
        udid: mode.includes("slim") ? "11111111-2222-3333-4444-555555555555" : "watch-fixture" }
    ] } }));
  } else if (args[1] === "bootstatus" && mode.endsWith("boot-failed")) {
    console.error("Intentional simulator boot failure");
    process.exit(23);
  } else if (args[1] === "install" && !existsSync(args[3])) {
    process.exit(24);
  }
} else if (args.includes("-showBuildSettings")) {
  const signing = {
    DEVELOPMENT_TEAM: mode === "missing-app-team" ? "" : "TEAMFIX123",
    CODE_SIGN_STYLE: "Manual",
    CODE_SIGN_ENTITLEMENTS: "Fixture/Watch.entitlements",
    CODE_SIGNING_ALLOWED: "NO",
    CODE_SIGN_IDENTITY: "Apple Development",
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS: "NO",
    ...Object.fromEntries(args.filter((arg) => arg.startsWith("CODE_SIGN")).map((arg) => arg.split("=")))
  };
  const product = {
    target: "OpenClawWatchApp",
    buildSettings: {
      ...signing,
      TARGET_BUILD_DIR: mode === "relative-product" ? "relative" : path.join(root, "project derived data"),
      TARGET_TEMP_DIR: targetTempDir,
      FULL_PRODUCT_NAME: "Watch Product.app",
      EXECUTABLE_NAME: "OpenClawWatchApp",
      PRODUCT_BUNDLE_IDENTIFIER: mode === "missing-bundle-id" ? "" : "org.example.watch"
    }
  };
  const tests = {
    target: "OpenClawWatchTests",
    buildSettings: {
      ...signing,
      DEVELOPMENT_TEAM: mode === "team-mismatch" ? "OTHERTEAM1" :
        mode === "missing-test-team" ? "" : signing.DEVELOPMENT_TEAM,
      CODE_SIGN_ENTITLEMENTS: "Fixture/WatchTests.entitlements",
      TARGET_BUILD_DIR: path.join(root, "project derived data", "Watch Product.app", "PlugIns"),
      FULL_PRODUCT_NAME: "Watch Tests.xctest",
      PRODUCT_BUNDLE_IDENTIFIER: "org.example.watch.tests",
      TEST_HOST: path.join(root, "project derived data", "Watch Product.app",
        mode === "wrong-test-host" ? "OtherHost" : "OpenClawWatchApp")
    }
  };
  const other = { target: "OtherTarget", buildSettings: { TARGET_BUILD_DIR: "/wrong", FULL_PRODUCT_NAME: "Wrong.app" } };
  console.log(JSON.stringify(!args.includes("build-for-testing") ? [other, product] :
    mode === "missing-product" ? [other, tests] :
    mode === "ambiguous-product" ? [product, product, tests] :
    mode === "duplicate-test-target" ? [other, product, tests, tests] :
    mode === "missing-test-product" ? [other, product] : [other, product, tests]));
} else if (tool === "codesign") {
  if (args.includes("--verify")) {
    if ((mode === "invalid-signature" && args.at(-1).endsWith(".app")) ||
        (mode === "invalid-test-signature" && args.at(-1).endsWith(".xctest"))) {
      process.exit(25);
    }
  } else {
    console.log(JSON.stringify({ "get-task-allow": true }));
  }
} else if (tool === "plutil") {
  const input = args.at(-1);
  const plist = JSON.parse(readFileSync(input === "-" ? 0 : input, "utf8"));
  if (mode === "cleanup-failed" && path.basename(input) === "entitlements.plist" &&
      path.dirname(path.dirname(input)) === process.env.TMPDIR) {
    chmodSync(process.env.TMPDIR, 0o500);
  }
  console.log(JSON.stringify(plist));
} else if (args.some((arg) => arg === "test" || arg === "test-without-building") && mode === "voice-tests-failed") {
  process.exit(25);
} else if (args.includes("build-for-testing")) {
  mkdirSync(targetTempDir, { recursive: true });
  if (mode !== "missing-generated") {
    const generated = mode === "missing-generated-id" ? {} : {
      "application-identifier": mode === "unresolved-generated-id" ?
        "$(AppIdentifierPrefix)org.example.watch" : mode === "invalid-generated-prefix" ?
        "BAD_PREFIX.org.example.watch" : mode === "wrong-generated-bundle" ?
        "SEEDFIX123.org.example.other" : applicationID
    };
    writeFileSync(generatedPath, mode === "malformed-generated" ? "not a plist" : JSON.stringify(generated));
  }
  writeFileSync(path.join(productPath, "Info.plist"), JSON.stringify({
    CFBundleIdentifier: mode === "built-bundle-mismatch" ? "org.example.other" : "org.example.watch"
  }));
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  for (const tool of ["xcrun", "xcodebuild", "codesign", "plutil", "pnpm", "uname", "installer", "simslim"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  if (mode.includes("slim")) {
    const scripts = path.join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    if (!mode.endsWith("missing-installer")) {
      copyFileSync(path.join(bin, "installer"), path.join(scripts, "install-simslim.sh"));
    }
    if (!mode.endsWith("missing-prepare")) {
      copyFileSync(
        "scripts/ios-simulator-prepare.sh",
        path.join(scripts, "ios-simulator-prepare.sh"),
      );
    }
  }
  const environmentFile = path.join(root, "github-env");
  const summaryFile = path.join(root, "summary.md");
  writeFileSync(environmentFile, "");
  writeFileSync(summaryFile, "");
  const script = steps
    .map((step) => {
      if (!step?.run) {
        throw new Error("Missing simulator workflow step");
      }
      return `${step.run}\nset -a\nsource "$GITHUB_ENV"\nset +a`;
    })
    .join("\n");
  let result;
  try {
    const options = {
    cwd: root,
    encoding: "utf8" as const,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
      TMPDIR: temporaryRoot,
      TMP: temporaryRoot,
      TEMP: temporaryRoot,
      CI: "true",
      OPENCLAW_CI_SIMSLIM_BINARY: "",
      WATCH_FIXTURE_ROOT: root,
      WATCH_FIXTURE_MODE: mode,
      GITHUB_ENV: environmentFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      IOS_SIMULATOR_SELECTION: JSON.stringify(resolveIosSimulatorTestSelection(null)),
      IOS_CI_PHASE: "smoke",
      IOS_MAIN_TIER: "false",
      HISTORICAL_TARGET: "false",
      IOS_DEST: "",
      XCODE_XCCONFIG_FILE: "",
      ...env,
    },
    };
    if (phases) {
      const state = path.join(root, "owned-build");
      mkdirSync(state, { mode: 0o700 });
      for (const phase of phases) {
        if (mode === "wrong-owned-device" && phase !== "build") {
          const file = path.join(state, "build.json");
          writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), simulator: randomUUID() }),
          );
        }
        result = spawnSync(
          "/bin/bash",
          [
            "scripts/ios-watch-operation-tests.sh",
            path.join(root, `${phase}.xcresult`),
            "11111111-1111-4111-8111-111111111111",
            phase,
            state,
          ],
          options,
        );
        if (result.status !== 0) {
          break;
        }
      }
    } else {
      result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], options);
    }
  } finally {
    chmodSync(temporaryRoot, 0o700);
  }
  assert(result);
  const trace = path.join(root, "commands.jsonl");
  const commands: Command[] = existsSync(trace)
    ? readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return {
    result,
    commands,
    product,
    testProduct,
    temporaryRoot,
    root,
    summary: readFileSync(summaryFile, "utf8"),
  };
}

function runWatchStep(mode = "ready", qualificationMode = false, phases?: string[]) {
  const step = qualificationMode
    ? qualificationSteps.find(
        (entry) => entry.name === "Run focused Apple Watch operation simulator tests",
      )
    : watchStep;
  return runSimulatorStep(mode, [step], {}, phases);
}

describe.skipIf(process.platform === "win32")("SimSlim workflow admission", () => {
  it("prewarms and slims the build's exact iPhone before testing", () => {
    const { result, commands } = runSimulatorStep("voice-slim", [
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const slim = commands.filter(({ tool }) => tool === "simslim");
    expect(slim.map(({ args }) => args[0])).toEqual(["on", "verify"]);
    for (const { args } of slim) {
      expect(args[1]).toBe("11111111-2222-3333-4444-555555555555");
    }
    expect(commands.indexOf(slim[1]!)).toBeLessThan(commands.findIndex(isTestCommand));
    expect(
      commands.filter(({ tool, args }) => tool === "xcrun" && args[1] === "bootstatus"),
    ).toHaveLength(3);
  });

  it.each(["missing-installer", "missing-prepare"])("keeps %s targets stock", (mode) => {
    const { result, commands } = runSimulatorStep(`voice-slim-${mode}`, [
      configureStep,
      prepareStep,
      buildStep,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(commands.some(({ tool }) => tool === "simslim" || tool === "installer")).toBe(false);
    expect(commands.some(({ tool }) => tool === "pnpm")).toBe(true);
  });

  it.each(["install", "on", "verify", "boot"])("stops before XCTest on %s failure", (mode) => {
    const { result, commands } = runSimulatorStep(`voice-slim-${mode}-failed`, [
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status).toBe(23);
    expect(commands.some(({ tool }) => tool === "pnpm")).toBe(true);
    expect(commands.some(isTestCommand)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it("exports the fixed qualification Xcode without changing global selection", () => {
    const { result, commands, environment } = runXcodeSelection(true);
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([
      "xcodebuild:/Applications/Xcode_26.6.app/Contents/Developer",
      "xcodebuild:/Applications/Xcode_26.6.app/Contents/Developer",
      "swift:/Applications/Xcode_26.6.app/Contents/Developer",
    ]);
    expect(environment).toBe("DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer\n");
  });

  it.each([
    ["absent", false, "26.6"],
    ["wrong-version", true, "26.5"],
  ] as const)(
    "fails qualification for %s Xcode without global selection or fallback",
    (_, present, version) => {
      const { result, commands } = runXcodeSelection(true, present, version);
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.startsWith("sudo:"))).toBe(false);
      expect(commands.some((command) => command.startsWith("swift:"))).toBe(false);
    },
  );

  it("preserves ordinary Periphery Xcode selection", () => {
    const { result, commands, environment } = runXcodeSelection(false);
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([
      "sudo:xcode-select -s /Applications/Xcode_26.6.app/Contents/Developer",
      "xcodebuild:unset",
      "xcodebuild:unset",
      "swift:unset",
    ]);
    expect(environment).toBe("");
  });

  it.each(["success", "failure", "cancelled", "skipped"])(
    "runs subsequent captures only after successful HTTPS/voice qualification: %s",
    (outcome) => {
      const live = qualificationSteps.find((step) => step.id === "watch_https");
      const captures = qualificationSteps.find(
        (step) => step.name === "Capture direct Watch review surfaces",
      );
      const condition = captures?.if;
      assert(live && condition);
      assert(condition.startsWith("${{") && condition.endsWith("}}"));
      // This workflow condition uses the JS-compatible &&/==/! expression subset.
      const admitted = runInNewContext(condition.slice(3, -2), {
        github: { event_name: "workflow_dispatch" },
        inputs: { watch_qualification: true },
        steps: { watch_tests: { outcome: "success" }, watch_https: { outcome } },
        cancelled: () => false,
      });
      expect(admitted).toBe(outcome === "success");
    },
  );

  it("reuses project build products and installs the exact Watch target before running its tests", () => {
    const { result, commands, product, testProduct, root, temporaryRoot } = runWatchStep();
    expect(result.status, result.stderr).toBe(0);
    const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
    for (const command of xcodeCommands) {
      expect(command.args).not.toContain("-derivedDataPath");
      expect(command.args).not.toContain("-target");
      expect(command.args).not.toContain("-alltargets");
    }
    expect(
      commands
        .filter((command) => command.tool === "xcrun" && command.args[0] === "simctl")
        .map((command) => command.args),
    ).toEqual([
      ["simctl", "list", "devices", "available", "--json"],
      ["simctl", "boot", "watch-fixture"],
      ["simctl", "bootstatus", "watch-fixture", "-b"],
      ["simctl", "install", "watch-fixture", product],
    ]);
    expect(
      xcodeCommands.map((command) =>
        command.args.find((arg) =>
          ["build-for-testing", "-showBuildSettings", "test-without-building"].includes(arg),
        ),
      ),
    ).toEqual(["build-for-testing", "-showBuildSettings", "test-without-building"]);
    const build = xcodeCommands.find((command) => !command.args.includes("-showBuildSettings"));
    const settingsQuery = xcodeCommands.find((command) =>
      command.args.includes("-showBuildSettings"),
    );
    expect(
      settingsQuery?.args.filter((arg) => arg !== "-showBuildSettings" && arg !== "-json"),
    ).toEqual(build?.args);
    for (const command of xcodeCommands.filter(
      (entry) =>
        entry.args.includes("build-for-testing") || entry.args.includes("test-without-building"),
    )) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "OpenClawWatchApp",
          "Debug",
          "platform=watchOS Simulator,id=watch-fixture",
          "-parallel-testing-enabled",
          "NO",
          "-only-testing:OpenClawWatchTests/WatchInboxStoreOperationTests",
          "-only-testing:OpenClawWatchTests/WatchRealtimeMediaTests",
          "-only-testing:OpenClawWatchTests/WatchGatewayConfigurationTests",
          "-only-testing:OpenClawWatchTests/WatchDirectConversationTests",
          "-only-testing:OpenClawWatchTests/WatchGatewayControllerTests",
          "CODE_SIGNING_ALLOWED=YES",
          "CODE_SIGN_IDENTITY=-",
          "CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES",
        ]),
      );
      expect(
        command.args.some((arg) =>
          /^(DEVELOPMENT_TEAM|CODE_SIGN_STYLE|CODE_SIGN_ENTITLEMENTS|PROVISIONING_PROFILE_SPECIFIER)=/.test(
            arg,
          ),
        ),
      ).toBe(false);
    }
    const installIndex = commands.findIndex((command) => command.args.includes("install"));
    expect(
      commands.slice(0, installIndex).filter((command) => command.tool === "codesign"),
    ).toEqual([
      { tool: "codesign", args: ["--verify", "--strict", product] },
      { tool: "codesign", args: ["--verify", "--strict", testProduct] },
    ]);
    const extraction = commands.find(
      (command) => command.tool === "xcrun" && command.args[0] === "segedit",
    );
    expect(extraction?.args.slice(0, 5)).toEqual([
      "segedit",
      path.join(product, "OpenClawWatchApp"),
      "-extract",
      "__TEXT",
      "__entitlements",
    ]);
    const plistPath = extraction?.args[5];
    assert(plistPath, "Expected an extracted entitlement plist");
    expect(plistPath).not.toBe("-");
    expect(path.dirname(path.dirname(plistPath))).toBe(temporaryRoot);
    expect(commands.slice(0, installIndex).filter((command) => command.tool === "plutil")).toEqual([
      { tool: "plutil", args: ["-convert", "json", "-o", "-", path.join(product, "Info.plist")] },
      {
        tool: "plutil",
        args: [
          "-convert",
          "json",
          "-o",
          "-",
          path.join(
            root,
            "project intermediates",
            "Watch Product.build",
            "Watch Product.app-Simulated.xcent",
          ),
        ],
      },
      { tool: "plutil", args: ["-convert", "json", "-o", "-", plistPath] },
    ]);
    expect(readdirSync(temporaryRoot)).toEqual([]);
    expect(result.stderr.split("\n")[0]).toBe(
      '{"watchBuildSettings":{"OpenClawWatchApp":1,"OpenClawWatchTests":1}}',
    );
    expect(result.stderr).toContain('"team":"TEAMFIX123"');
    expect(result.stderr).toContain('"applicationID":"SEEDFIX123.org.example.watch"');
    expect(result.stderr).toContain('"style":"Manual"');
    expect(result.stderr).toContain('"entitlementsFile":"Fixture/Watch.entitlements"');
    expect(result.stderr).toContain('"entitlementsSource":"__TEXT,__entitlements"');
    expect(result.stderr).toContain('"keychainAccessGroups":null');
    expect(
      xcodeCommands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain("apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult");
  });

  it.each([
    "missing-product",
    "ambiguous-product",
    "relative-product",
    "missing-test-product",
    "duplicate-test-target",
    "wrong-test-host",
    "invalid-signature",
    "invalid-test-signature",
    "missing-section",
    "malformed-section",
    "missing-application-id",
    "wrong-application-id",
    "wrong-compiled-seed",
    "compiled-seed-case-mismatch",
    "missing-generated",
    "malformed-generated",
    "missing-generated-id",
    "unresolved-generated-id",
    "invalid-generated-prefix",
    "wrong-generated-bundle",
    "missing-app-team",
    "missing-test-team",
    "team-mismatch",
    "missing-bundle-id",
    "built-bundle-mismatch",
    "malformed-keychain-groups",
  ])("rejects %s settings before simulator installation or test execution", (mode) => {
    const { result, commands, temporaryRoot } = runWatchStep(mode);
    expect(result.status).not.toBe(0);
    const appCount = mode === "missing-product" ? 0 : mode === "ambiguous-product" ? 2 : 1;
    const testCount =
      mode === "missing-test-product" ? 0 : mode === "duplicate-test-target" ? 2 : 1;
    expect(result.stderr.split("\n")[0]).toBe(
      JSON.stringify({
        watchBuildSettings: { OpenClawWatchApp: appCount, OpenClawWatchTests: testCount },
      }),
    );
    if (appCount !== 1) {
      expect(result.stderr).toContain(
        `Expected one OpenClawWatchApp target from Xcode, got ${appCount}`,
      );
    } else if (testCount !== 1) {
      expect(result.stderr).toContain(
        `Expected one OpenClawWatchTests target from Xcode, got ${testCount}`,
      );
    }
    if (mode === "missing-app-team") {
      expect(result.stderr).toContain("Missing configured Watch app development team");
    } else if (mode === "team-mismatch" || mode === "missing-test-team") {
      expect(result.stderr).toContain("Configured Watch test team does not match the app team");
    } else if (mode === "missing-bundle-id") {
      expect(result.stderr).toContain("Missing configured Watch app bundle identifier");
    } else if (mode === "built-bundle-mismatch") {
      expect(result.stderr).toContain(
        "Built Watch bundle identifier does not match its configuration",
      );
    } else if (
      [
        "missing-generated-id",
        "unresolved-generated-id",
        "invalid-generated-prefix",
        "wrong-generated-bundle",
      ].includes(mode)
    ) {
      expect(result.stderr).toContain(
        "Expected a fully evaluated generated Watch application identifier for the configured bundle",
      );
    } else if (mode === "wrong-compiled-seed" || mode === "compiled-seed-case-mismatch") {
      expect(result.stderr).toContain(
        "Simulated Watch host application identifier does not match its build identity",
      );
    }
    if (mode === "missing-generated" || mode === "malformed-generated") {
      expect(
        commands.some(
          (command) =>
            command.tool === "plutil" && command.args.at(-1)?.endsWith("-Simulated.xcent"),
        ),
      ).toBe(true);
      expect(commands.some((command) => command.args[0] === "segedit")).toBe(false);
    }
    expect(result.stderr).not.toContain("OtherTarget");
    expect(result.stderr).not.toContain("/wrong");
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("stops before installation and test execution when extraction cleanup fails", () => {
    const { result, commands, temporaryRoot } = runWatchStep("cleanup-failed");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EACCES|EPERM/);
    expect(commands.some((command) => command.tool === "plutil")).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.tool === "plutil" && command.args.at(-1)?.endsWith("/entitlements.plist"),
      ),
    ).toBe(true);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
    expect(readdirSync(temporaryRoot)).toHaveLength(1);
  });

  it("accepts an explicitly provided private Keychain group without changing signing configuration", () => {
    const { result, commands } = runWatchStep("explicit-private-group");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('"keychainAccessGroups":["SEEDFIX123.org.example.watch"]');
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(true);
  });

  it("preserves a mixed-case generated App ID prefix independently of the configured team", () => {
    const { result, commands } = runWatchStep("mixed-case-prefix");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('"team":"TEAMFIX123"');
    expect(result.stderr).toContain('"applicationID":"SeedFix123.org.example.watch"');
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(true);
  });

  it("preserves simulator readiness failure without installing or running tests", () => {
    const { result, commands } = runWatchStep("boot-failed");
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
  });

  it("runs the same Watch suites in qualification mode and retains an independent result bundle", () => {
    const normal = runWatchStep();
    const focused = runWatchStep("ready", true);
    expect(focused.result.status, focused.result.stderr).toBe(0);
    const testSelection = (commands: Command[]) =>
      commands
        .find((command) => command.args.includes("test-without-building"))
        ?.args.filter((arg) => arg.startsWith("-only-testing:"));
    expect(testSelection(focused.commands)).toEqual(testSelection(normal.commands));
    expect(
      focused.commands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain(path.join(focused.root, "watch-qualification/WatchOperationTests.xcresult"));
  });

  it("builds an owned qualification host once, then uses only that simulator without fixture phases in normal suites", () => {
    const { result, commands } = runWatchStep("ready", false, [
      "build",
      "identity",
      "negative",
      "positive",
      "voice",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const xcode = commands.filter((command) => command.tool === "xcodebuild");
    expect(
      xcode.filter(
        (command) =>
          command.args.includes("build-for-testing") &&
          !command.args.includes("-showBuildSettings"),
      ),
    ).toHaveLength(1);
    expect(xcode.filter((command) => command.args.includes("test-without-building"))).toHaveLength(
      4,
    );
    for (const command of xcode) {
      expect(command.args).toContain(
        "platform=watchOS Simulator,id=11111111-1111-4111-8111-111111111111",
      );
      expect(command.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
        "-only-testing:OpenClawWatchTests/WatchOperatorHTTPSQualificationTests",
      ]);
    }
    expect(
      commands.filter((command) => command.args[0] === "simctl").map((command) => command.args[1]),
    ).toEqual(["install"]);
  });

  it.each(["unknown-phase", "wrong-owned-device"])(
    "rejects %s before native phase execution",
    (mode) => {
      const { result, commands } = runWatchStep(
        mode,
        false,
        mode === "unknown-phase" ? ["unrecognized"] : ["build", "positive"],
      );
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(
        false,
      );
    },
  );

  it("keeps qualification opt-in and separates test evidence from Periphery reports", () => {
    expect(qualification.on.workflow_dispatch.inputs.watch_qualification.default).toBe(false);
    for (const name of [
      "Run Periphery",
      "Build Periphery report",
      "Upload Periphery report",
      "Fail on dead code",
    ]) {
      expect(qualificationSteps.find((step) => step.name === name)?.if).toContain(
        "!(github.event_name == 'workflow_dispatch' && inputs.watch_qualification)",
      );
    }
    const artifact = qualificationSteps.find(
      (step) => step.name === "Upload Watch qualification evidence",
    );
    expect(artifact?.if).toContain("always()");
    expect(artifact?.with?.["if-no-files-found"]).toBe("error");
    expect(String(artifact?.with?.path).trim().split("\n")).toEqual([
      "${{ runner.temp }}/watch-qualification/source-head.txt",
      "${{ runner.temp }}/watch-qualification/xcode-version.txt",
      "${{ runner.temp }}/watch-qualification/shared-tests.log",
      "${{ runner.temp }}/watch-qualification/watch-tests.log",
      "${{ runner.temp }}/watch-qualification/WatchOperationTests.xcresult",
      "${{ runner.temp }}/watch-qualification/ui-fixtures",
      "${{ runner.temp }}/watch-qualification/operator-https.json",
    ]);
    const liveHTTPS = qualificationSteps.find(
      (step) => step.name === "Prove Watch operator HTTPS and native voice retirement",
    );
    expect(liveHTTPS?.if).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.watch_qualification",
    );
    expect(liveHTTPS?.run).toBe(
      "node --import ./scripts/tsx.mjs scripts/ios-watch-operator-https-proof.mts",
    );
    const shared = qualificationSteps.find(
      (step) => step.name === "Run focused shared Watch transport tests",
    );
    expect(shared?.run).toContain("GatewayOperatorHTTPSessionTests");
    expect(shared?.run).toContain("GatewayOperatorHTTPWireTests");
    expect(shared?.run).toContain("--no-parallel");
  });
});

describe.skipIf(process.platform === "win32")("iOS voice cleanup workflow", () => {
  it.each([
    ["tests", "false"],
    ["smoke", "true"],
  ])("keeps the generic simulator build for phase=%s historical=%s", (phase, historical) => {
    const { result, commands } = runSimulatorStep("voice", [buildStep], {
      IOS_CI_PHASE: phase,
      HISTORICAL_TARGET: historical,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([{ tool: "pnpm", args: ["ios:build"], destination: "" }]);
  });

  it("retains universal build settings and verbose diagnostics in full manual validation", () => {
    const { result, commands } = runSimulatorStep(
      "voice",
      [configureStep, prepareStep, buildStep, voiceStep],
      {
        IOS_CI_PHASE: "tests",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const appBuild = commands.find((command) => command.tool === "pnpm");
    expect(appBuild?.destination).toBe("");
    expect(commands.every((command) => command.settings === undefined)).toBe(true);
    const testRun = commands.find((command) => command.tool === "xcodebuild");
    expect(testRun?.args).toEqual(
      expect.arrayContaining(["-collect-test-diagnostics", "on-failure"]),
    );
  });

  it("fails after the overlapping build without XCTest when the selected iPhone cannot boot", () => {
    const { result, commands } = runSimulatorStep("voice-boot-failed", [
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.tool === "pnpm")).toBe(true);
    expect(commands.some(isTestCommand)).toBe(false);
    expect(result.stdout).toContain("Intentional simulator boot failure");
  });

  it.each([
    ["smoke", "false"],
    ["tests", "true"],
  ])(
    "executes cleanup and sibling suites with normal Debug signing: %s, main=%s",
    (phase, main) => {
      const { result, commands } = runSimulatorStep(
        "voice",
        [configureStep, prepareStep, buildStep, voiceStep, iosStep],
        { IOS_CI_PHASE: phase, IOS_MAIN_TIER: main },
      );
      expect(result.status, result.stderr).toBe(0);
      const appBuild = commands.find((command) => command.tool === "pnpm");
      expect(appBuild?.args).toEqual([phase === "smoke" ? "ios:gen" : "ios:build"]);
      expect(appBuild?.destination).toBe("platform=iOS Simulator,id=watch-fixture");
      expect(appBuild?.settings).toBe("ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n");
      expect(
        commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
      ).toEqual([
        ["simctl", "list", "devices", "available", "--json"],
        ["simctl", "bootstatus", "watch-fixture", "-b"],
      ]);
      const builds = commands.filter((command) => command.tool === "xcodebuild");
      expect(
        builds.map((command) =>
          command.args.find((arg) =>
            ["build-for-testing", "test", "test-without-building"].includes(arg),
          ),
        ),
      ).toEqual(
        phase === "smoke"
          ? ["build-for-testing", "test-without-building", "test-without-building"]
          : ["test", "test"],
      );
      for (const command of builds) {
        expect(command.args).toEqual(expect.arrayContaining(["-configuration", "Debug"]));
        expect(command.args).toContain(appBuild?.destination);
        expect(command.settings).toBe(appBuild?.settings);
        expect(command.args.some((arg) => arg.startsWith("CODE_SIGN"))).toBe(false);
      }
      const build = builds.find(isTestCommand);
      if (!build) {
        throw new Error("Missing voice cleanup xcodebuild command");
      }
      expect(build.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
        "-only-testing:OpenClawTests/TalkRealtimeVoiceSessionCleanupTests",
        "-only-testing:OpenClawTests/TalkRealtimeConsultCancellationTests",
        "-only-testing:OpenClawTests/TalkRealtimeTranscriptWriteQueueTests",
        "-only-testing:OpenClawTests/TalkModeManagerTests",
        "-only-testing:OpenClawTests/ManagedDocumentEnvelopeTests",
        "-only-testing:OpenClawTests/IOSMediaArtifactLoaderTests",
        "-only-testing:OpenClawTests/OpenClawTypographyTests",
      ]);
      expect(build.args).toEqual(expect.arrayContaining(["-collect-test-diagnostics", "never"]));
      if (phase === "smoke") {
        const sources = readdirSync("apps/ios/Tests", { recursive: true })
          .filter((file): file is string => typeof file === "string" && file.endsWith(".swift"))
          .map((file) => ({
            file: `apps/ios/Tests/${file}`,
            source: readFileSync(path.join("apps/ios/Tests", file), "utf8"),
          }));
        const testCommands = builds.filter(isTestCommand);
        for (const [index, group] of ["voice", "lifecycle"].entries()) {
          const selectors = testCommands[index]!.args.filter((arg) =>
            arg.startsWith("-only-testing:"),
          );
          for (const selector of selectors) {
            const suite = selector.split("/")[1]!;
            const declarations = sources.filter(({ source }) =>
              new RegExp(`\\b(?:struct|class|enum)\\s+${suite}\\b`, "u").test(source),
            );
            expect(declarations, `Source owner for ${selector}`).toHaveLength(1);
            const file = declarations[0]!.file;
            const selection = resolveIosSimulatorTestSelection([file]);
            expect(
              group === "voice" ? selection.voice.selected : selection.lifecycle.selected,
              `The ${group} group must run when its ${suite} source ${file} changes`,
            ).toBe(true);
          }
        }
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("iOS Access simulator workflow", () => {
  const authClasses = [
    "CloudflareAccessClientTests",
    "CloudflareAccessTransferTests",
    "CloudflareAccessSessionStoreTests",
  ];

  it("executes the actual auth test classes during smoke and excludes compatibility targets", () => {
    expect(iosStep?.if).toContain("matrix.phase == 'smoke'");
    expect(iosStep?.if).toContain("needs.preflight.outputs.compatibility_target != 'true'");
    expect(workflow.jobs["ios-build"]?.env?.IOS_CI_PHASE).toBe("${{ matrix.phase }}");
    const { result, commands } = runSimulatorStep("voice", [
      configureStep,
      prepareStep,
      buildStep,
      iosStep,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter(isTestCommand);
    expect(tests).toHaveLength(1);
    expect(tests[0]?.args).toContain("platform=iOS Simulator,id=watch-fixture");
    expect(tests[0]?.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
      ...authClasses.map((name) => `-only-testing:OpenClawTests/${name}`),
      "-only-testing:OpenClawTests/ChatTypingFocusTests",
      "-only-testing:OpenClawTests/ChatSendHydrationTests",
    ]);
    for (const name of authClasses) {
      expect(readFileSync(`apps/ios/Tests/${name}.swift`, "utf8")).toContain(`struct ${name}`);
    }
  });

  it("keeps full lifecycle and UI tests alongside Access tests in full validation", () => {
    const { result, commands } = runSimulatorStep(
      "voice",
      [configureStep, prepareStep, buildStep, iosStep],
      {
        IOS_CI_PHASE: "tests",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter((command) => command.tool === "xcodebuild");
    expect(tests).toHaveLength(2);
    expect(tests[0]?.args).toEqual(
      expect.arrayContaining([
        ...authClasses.map((name) => `-only-testing:OpenClawTests/${name}`),
        "-only-testing:OpenClawTests/ChatTypingFocusTests",
        "-only-testing:OpenClawTests/ChatSendHydrationTests",
        "-only-testing:OpenClawLogicTests/WatchVoiceTurnTrackerTests",
        "-only-testing:OpenClawTests/NodeAppModelInvokeTests",
        "-only-testing:OpenClawTests/OpenClawTypographyTests",
      ]),
    );
    expect(tests[1]?.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testWatchMessageDeliveryIsReachableFromSettings",
      "-only-testing:OpenClawUITests/BootstrapSetupFailureUITests",
    ]);
  });

  it.each(["smoke", "tests"])(
    "propagates auth test errors without later UI tests (%s)",
    (phase) => {
      const { result, commands } = runSimulatorStep(
        "voice-tests-failed",
        [configureStep, prepareStep, buildStep, iosStep],
        {
          IOS_CI_PHASE: phase,
        },
      );
      expect(result.status).toBe(25);
      expect(commands.filter(isTestCommand)).toHaveLength(1);
    },
  );
});

describe("iOS simulator owner selection", () => {
  it.each([
    ["apps/ios/Sources/Voice/TalkModeManager.swift", true, true],
    ["apps/ios/Sources/Onboarding/OnboardingWizardView.swift", true, true],
    ["apps/ios/Sources/FutureFeature/NewService.swift", true, true],
    ["apps/ios/WatchApp/Sources/WatchInboxView.swift", true, false],
    ["apps/ios/ActivityWidget/OpenClawLiveActivity.swift", true, false],
    ["apps/ios/Tests/TalkModeConfigParsingTests.swift", true, false],
    ["apps/ios/Tests/Fixtures/managed-document-message.json", true, false],
    ["apps/ios/Tests/CloudflareAccessTestTokens.swift", false, true],
    ["apps/ios/Tests/ChatSendHydrationTests.swift", false, true],
    ["apps/ios/Tests/RootTabsNavigationTests.swift", false, false],
    ["apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift", false, false],
    ["apps/shared/OpenClawKit/Sources/OpenClawNativeState/NativeState.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/GatewayWebSocketTestSupport.swift", true, true],
    ["apps/swabble/Sources/SwabbleKit/Speech.swift", true, true],
    ["apps/swabble/Sources/swabble/main.swift", false, false],
    ["apps/ios/fastlane/Fastfile", false, false],
  ] as const)(
    "selects the actual runtime, test, and resource owners for %s",
    (file, voice, lifecycle) => {
      const selected = resolveIosSimulatorTestSelection([file]);
      expect(selected.voice.selected).toBe(voice);
      expect(selected.lifecycle.selected).toBe(lifecycle);
      for (const group of [selected.voice, selected.lifecycle]) {
        expect(group.reasons.some((reason: string) => reason.includes(file))).toBe(group.selected);
      }
    },
  );

  it.each([
    "apps/ios/project.yml",
    "apps/ios/Config/Signing.xcconfig",
    "apps/ios/Sources/Fonts/Inter[opsz,wght].ttf",
    "apps/ios/Tests/Info.plist",
    "apps/shared/OpenClawKit/Package.swift",
    "apps/swabble/Package.resolved",
    "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid/index.html",
    "scripts/lib/swift-toolchain.sh",
    "scripts/ios-simulator-prepare.sh",
    "scripts/lib/ci-ios-smoke-plan.mjs",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
  ])("retains both groups when shared build or bundle input changes: %s", (file) => {
    const selected = resolveIosSimulatorTestSelection([file]);
    expect(selected.voice.selected).toBe(true);
    expect(selected.lifecycle.selected).toBe(true);
  });

  it.each([
    null,
    ["../apps/ios/Tests/ChatTypingFocusTests.swift"],
    ["/unknown"],
    ["invalid\npath"],
  ])(
    "falls back to full coverage when changed paths are unavailable or invalid: %j",
    (changedPaths) => {
      const selected = resolveIosSimulatorTestSelection(changedPaths);
      expect(selected.mode).toBe("full");
      expect(selected.voice.selected).toBe(true);
      expect(selected.lifecycle.selected).toBe(true);
    },
  );

  it("never turns an unselected iOS job back on, even with the full-sequence override", () => {
    const selected = resolveIosSimulatorTestSelection(null, { enabled: false, forceFull: true });
    expect(selected.voice.selected).toBe(false);
    expect(selected.lifecycle.selected).toBe(false);
  });
});

function admittedSimulatorSteps(
  selection: ReturnType<typeof resolveIosSimulatorTestSelection>,
  phase = "smoke",
  compatibility = false,
) {
  return [configureStep, prepareStep, buildStep, voiceStep, iosStep].filter((step) => {
    if (!step) {
      throw new Error("Missing iOS simulator workflow step");
    }
    if (!step.if) {
      return true;
    }
    const expression = step.if.startsWith("${{") ? step.if : `\${{ ${step.if} }}`;
    return evaluateWorkflowExpression(expression, {
      repository: "openclaw/openclaw",
      eventName: "pull_request",
      runAttempt: 1,
      matrix: { phase },
      preflightOutputs: {
        compatibility_target: String(compatibility),
        run_ios_voice_cleanup_tests: String(selection.voice.selected),
        run_ios_lifecycle_tests: String(selection.lifecycle.selected),
      },
    });
  });
}

describe.skipIf(process.platform === "win32")("iOS selected simulator workflow", () => {
  it.each([
    { owner: "apps/ios/fastlane/Fastfile", groups: [] },
    { owner: "apps/ios/Tests/TalkModeConfigParsingTests.swift", groups: ["voice"] },
    { owner: "apps/ios/Tests/ChatSendHydrationTests.swift", groups: ["lifecycle"] },
  ])("builds the app and runs only selected groups for $owner", ({ owner, groups }) => {
    const selection = resolveIosSimulatorTestSelection([owner]);
    const steps = admittedSimulatorSteps(selection);
    expect(steps).toContain(buildStep);
    expect(steps.includes(prepareStep)).toBe(groups.length > 0);
    const { result, commands, summary } = runSimulatorStep("voice-slim", steps, {
      IOS_SIMULATOR_SELECTION: JSON.stringify(selection),
    });
    expect(result.status, result.stderr).toBe(0);
    const builds = commands.filter(
      ({ tool, args }) => tool === "xcodebuild" && args.includes("build-for-testing"),
    );
    expect(builds).toHaveLength(1);
    expect(builds[0]?.settings).toBe("ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n");
    expect(builds[0]?.args).toContain(
      groups.length
        ? "platform=iOS Simulator,id=11111111-2222-3333-4444-555555555555"
        : "generic/platform=iOS Simulator",
    );
    const tests = commands.filter(isTestCommand);
    expect(tests).toHaveLength(groups.length);
    for (const test of tests) {
      expect(test.args).toContain("test-without-building");
      expect(test.args).not.toContain("test");
      expect(test.args).toContain(
        groups[0] === "voice"
          ? "-only-testing:OpenClawTests/TalkRealtimeVoiceSessionCleanupTests"
          : "-only-testing:OpenClawTests/ChatTypingFocusTests",
      );
    }
    if (!groups.length) {
      expect(commands.some(({ tool }) => ["xcrun", "installer", "simslim"].includes(tool))).toBe(
        false,
      );
    }
    expect(summary).toBe(formatIosSimulatorSelectionSummary(selection));
    for (const group of ["voice", "lifecycle"]) {
      expect(summary).toContain(`| ${group} | ${groups.includes(group) ? "yes" : "no"} |`);
    }
  });

  it("retains the full tests phase and compatibility exclusions regardless of PR group flags", () => {
    const none = resolveIosSimulatorTestSelection([]);
    expect(admittedSimulatorSteps(none, "tests")).toEqual([
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
      iosStep,
    ]);
    const all = resolveIosSimulatorTestSelection(null);
    expect(admittedSimulatorSteps(all)).toEqual([
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
      iosStep,
    ]);
    for (const phase of ["smoke", "tests"]) {
      const compatible = admittedSimulatorSteps(all, phase, true);
      expect(compatible).toContain(buildStep);
      expect(compatible).not.toContain(prepareStep);
      expect(compatible).not.toContain(voiceStep);
      expect(compatible).not.toContain(iosStep);
    }
  });
});

it.each([
  { event: "pull_request", kill: "", full: false, releaseGate: false, historical: false },
  { event: "pull_request", kill: "true", full: true, releaseGate: false, historical: false },
  { event: "pull_request", kill: "1", full: true, releaseGate: false, historical: false },
  { event: "schedule", kill: "", full: true, releaseGate: false, historical: false },
  { event: "workflow_dispatch", kill: "", full: true, releaseGate: false, historical: false },
  { event: "workflow_dispatch", kill: "", full: true, releaseGate: false, historical: true },
  { event: "workflow_dispatch", kill: "", full: true, releaseGate: true, historical: false },
] as const)(
  "publishes iOS manifest decisions for $event, override=$kill, release=$releaseGate, historical=$historical",
  ({ event, kill, full, releaseGate, historical }) => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: historical,
      eventName: event,
      releaseGate,
      changedPaths: ["apps/ios/Tests/ChatSendHydrationTests.swift"],
      scopeEnv: {
        OPENCLAW_CI_RUN_IOS_BUILD: "true",
        OPENCLAW_CI_IOS_SIMULATOR_FULL: kill,
        OPENCLAW_CI_VALIDATION_TIER: event === "schedule" ? "main" : "full",
      },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_ios_build).toBe("true");
    expect(result.outputs.run_ios_voice_cleanup_tests).toBe(String(full));
    expect(result.outputs.run_ios_lifecycle_tests).toBe("true");
    const selection: ReturnType<typeof resolveIosSimulatorTestSelection> = JSON.parse(
      result.outputs.ios_simulator_selection!,
    );
    expect(selection.voice.selected).toBe(full);
    expect(selection.lifecycle.selected).toBe(true);
    expect(result.summary).toContain("iOS simulator test selection");
    expect(result.summary).toContain(`| voice | ${full ? "yes" : "no"} |`);
    expect(result.summary).toContain("| lifecycle | yes |");
    const phases = evaluateWorkflowExpression(workflow.jobs["ios-build"]?.strategy?.matrix?.phase, {
      repository: "openclaw/openclaw",
      eventName: event,
      runAttempt: 1,
      releaseGate,
      preflightOutputs: result.outputs,
    });
    expect(phases).toEqual(
      event === "schedule" || historical
        ? ["tests"]
        : event === "workflow_dispatch" && !releaseGate
          ? ["release", "tests"]
          : ["smoke"],
    );
  },
);
describe("Watch qualification phase admission", () => {
  it.each(["helper", "native", "unjoined", "malformed", "stale", "missing"])(
    "preserves only bounded public diagnostics for %s failure",
    async (mode) => {
      const directory = tempDirs.make("watch-phase-diagnostic-");
      const failure = await runWatchPhase("negative", randomUUID(), directory, async () => {
        const file = path.join(directory, "input.json");
        const input = JSON.parse(readFileSync(file, "utf8"));
        rmSync(file);
        if (mode !== "missing") {
          const errors =
            mode === "malformed"
              ? [
                  null,
                  "private-description",
                  { domain: "private-domain", code: 1 },
                  { domain: "NSURLErrorDomain", code: "private-code" },
                  { domain: "other", code: 1.5 },
                  { domain: "other", code: Number.MAX_SAFE_INTEGER + 1 },
                  { domain: "NSOSStatusErrorDomain", code: -50, description: "private-detail" },
                ]
              : Array.from({ length: 10 }, (_, index) => ({
                  domain: "NSURLErrorDomain",
                  code: -1200 - index,
                  description: "private-detail",
                }));
          writeFileSync(
            path.join(directory, "result.json"),
            JSON.stringify({
              ...input,
              nonce: mode === "stale" ? randomUUID() : input.nonce,
              ok: mode === "helper",
              ownersJoined: mode !== "unjoined",
              errors,
              token: "private-token",
              deviceID: "private-identity",
              path: "/private/fixture/result",
            }),
            { mode: 0o600 },
          );
        }
        if (mode === "helper") {
          throw new Error("private-helper-description");
        }
      }).then(
        () => {
          throw new Error("Expected phase failure");
        },
        (error: unknown) => error as AggregateError & { phaseFailure: unknown },
      );
      const unverified = ["unjoined", "stale", "missing"].includes(mode);
      expect(failure.phaseFailure).toEqual({
        phase: "negative",
        ownersJoined: !unverified,
        errors: ["stale", "missing"].includes(mode)
          ? []
          : mode === "malformed"
            ? [{ domain: "NSOSStatusErrorDomain", code: -50 }]
            : Array.from({ length: 8 }, (_, index) => ({
                domain: "NSURLErrorDomain",
                code: -1200 - index,
              })),
      });
      expect(hasUnjoinedWork(new AggregateError([failure], "outer phase failure"))).toBe(
        unverified,
      );
      expect(JSON.stringify(failure.phaseFailure)).not.toContain("private");
    },
  );

  it.each(["run", "phase", "nonce", "failed", "missing", "skipped", "oversized", "unjoined"])(
    "rejects %s evidence even when the tool reports success",
    async (mode) => {
      const directory = tempDirs.make("watch-phase-");
      await expect(
        runWatchPhase("negative", randomUUID(), directory, async () => {
          const file = path.join(directory, "input.json");
          const input = JSON.parse(readFileSync(file, "utf8"));
          if (mode === "missing") {
            rmSync(file);
            return;
          }
          if (mode !== "skipped") {
            rmSync(file);
          }
          const result = { ...input, ok: true, ownersJoined: true };
          if (["run", "phase", "nonce"].includes(mode)) {
            result[mode] = "stale";
          }
          if (mode === "failed") {
            result.ok = false;
          }
          if (mode === "oversized") {
            result.extra = "x".repeat(16384);
          }
          if (mode === "unjoined") {
            result.ownersJoined = false;
          }
          writeFileSync(path.join(directory, "result.json"), JSON.stringify(result), {
            mode: 0o600,
          });
        }),
      ).rejects.toThrow();
    },
  );

  it("accepts only a consumed request and matching current result", async () => {
    const directory = tempDirs.make("watch-phase-");
    const run = randomUUID();
    const result = await runWatchPhase("identity", run, directory, async () => {
      const file = path.join(directory, "input.json");
      const input = JSON.parse(readFileSync(file, "utf8"));
      rmSync(file);
      writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({ ...input, ok: true, ownersJoined: true }),
        {
          mode: 0o600,
        },
      );
    });
    expect(result).toMatchObject({ run, phase: "identity", ok: true });
  });
});

describe("Watch voice fixture lifecycle", () => {
  it.each(["sent", "closed"])(
    "reports old hello %s and joins callbacks plus both socket owners",
    async (outcome) => {
      const fixture = createVoiceFixture({
        cert: Buffer.from(TEST_TLS_CERT_PEM),
        key: Buffer.from(TEST_TLS_KEY_PEM),
        controlToken: "control-fixture",
        oldToken: "old-fixture",
        replacementToken: "new-fixture",
        deviceID: "fixture-device",
      });
      const endpoint = await fixture.listen();
      const clients: WebSocket[] = [];
      const raw = connect(Number(new URL(endpoint).port), "127.0.0.1");
      const rawClosed = once(raw, "close");
      const control = (action: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          // This local fixture certificate is deliberately not a system-trust qualification.
          const request = httpsRequest(
            `${endpoint}/${action}`,
            {
              rejectUnauthorized: false,
              agent: false,
              headers: { Authorization: "Bearer control-fixture" },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk) => {
                text += chunk;
              });
              response.on("end", () => {
                try {
                  assert.equal(response.statusCode, 200);
                  resolve(JSON.parse(text));
                } catch (error) {
                  reject(error instanceof Error ? error : new Error("Invalid fixture response"));
                }
              });
            },
          );
          request.on("error", reject);
          request.end();
        });
      const open = async (token: string) => {
        const socket = new WebSocket(endpoint.replace("https:", "wss:"), {
          rejectUnauthorized: false,
        });
        clients.push(socket);
        const challenge = once(socket, "message");
        await once(socket, "open");
        await challenge;
        socket.send(
          JSON.stringify({
            type: "req",
            id: randomUUID(),
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              device: { id: "fixture-device" },
              role: "operator",
              scopes: ["operator.read", "operator.talk"],
              auth: { deviceToken: token },
            },
          }),
        );
        return socket;
      };
      try {
        await once(raw, "connect");
        const old = await open("old-fixture");
        expect(await control("connected")).toEqual({ oldConnectObserved: true });
        if (outcome === "closed") {
          const closed = once(old, "close");
          old.close();
          await closed;
        }
        const oldHello = outcome === "sent" ? once(old, "message") : Promise.resolve();
        expect(await control("release")).toEqual({ oldHelloOutcome: outcome });
        await oldHello;
        const fresh = await open("new-fixture");
        await once(fresh, "message");
        fresh.send(JSON.stringify({ type: "req", id: randomUUID(), method: "agents.list" }));
        expect(await control("fresh")).toEqual({ freshAuthenticated: true });
        expect(await control("status")).toEqual({
          freshAuthenticated: true,
          oldHelloOutcome: outcome,
        });
      } finally {
        const closed = clients
          .filter((client) => client.readyState !== WebSocket.CLOSED)
          .map((client) => once(client, "close"));
        await fixture.close();
        await Promise.all([rawClosed, ...closed]);
      }
    },
  );
});
