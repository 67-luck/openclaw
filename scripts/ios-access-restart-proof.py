#!/usr/bin/env python3
"""Verify acknowledged Access sign-out across two processes on one installed app."""

import copy
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(arguments, capture=False, env=None):
    return subprocess.run(
        arguments, check=True, text=True, stdout=subprocess.PIPE if capture else None,
        env=env,
    ).stdout


def read_plist(path):
    with path.open("rb") as handle:
        return plistlib.load(handle)


def bundle_identity(bundle):
    info = read_plist(bundle / "Info.plist")
    executable = bundle / info["CFBundleExecutable"]
    require(executable.parent == bundle, "Unexpected bundle executable path")
    return info["CFBundleIdentifier"], hashlib.sha256(executable.read_bytes()).hexdigest()


def selected_target(document):
    if document.get("__xctestrun_metadata__", {}).get("FormatVersion", 1) == 1:
        return document["OpenClawTests"]
    return document["TestConfigurations"][0]["TestTargets"][0]


def selected_run(products):
    candidates = []
    for path in products.glob("OpenClaw_*.xctestrun"):
        document = read_plist(path)
        version = document.get("__xctestrun_metadata__", {}).get("FormatVersion", 1)
        require(version in (1, 2), "Unsupported generated test run format")
        # Schemes without a test plan still generate v1's top-level target dictionaries.
        if version == 1:
            if isinstance(document.get("OpenClawTests"), dict):
                candidates.append({
                    key: copy.deepcopy(value) for key, value in document.items()
                    if key == "OpenClawTests" or key.startswith("__")
                })
            continue
        for configuration in document.get("TestConfigurations", []):
            if not configuration.get("IsEnabled", True):
                continue
            for target in configuration.get("TestTargets", []):
                if target.get("BlueprintName") == "OpenClawTests":
                    selected = copy.deepcopy(document)
                    selected_configuration = copy.deepcopy(configuration)
                    selected_configuration["TestTargets"] = [copy.deepcopy(target)]
                    selected["TestConfigurations"] = [selected_configuration]
                    candidates.append(selected)
    require(len(candidates) == 1, "Expected one generated OpenClawTests run configuration")
    selected = candidates[0]
    target = selected_target(selected)
    require(isinstance(target.get("TestingEnvironmentVariables"), dict), "Missing test host environment")
    for key in ["OnlyTestIdentifiers", "SkipTestIdentifiers"]:
        target.pop(key, None)
    return selected


def verify_result(result, suite, method):
    prefix = ["xcrun", "xcresulttool", "get", "test-results"]
    summary = json.loads(run(prefix + ["summary", "--path", str(result)], capture=True))
    require(
        summary.get("result") == "Passed" and summary.get("totalTestCount") == 1
        and summary.get("passedTests") == 1 and summary.get("failedTests") == 0
        and summary.get("skippedTests") == 0 and summary.get("expectedFailures") == 0
        and summary.get("testFailures") == [],
        "Restart phase must execute exactly one passing test with no skips",
    )
    tree = json.loads(run(prefix + ["tests", "--path", str(result)], capture=True))
    cases = []

    def visit(node):
        if isinstance(node, dict):
            if node.get("nodeType") == "Test Case":
                cases.append(node)
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for value in node:
                visit(value)

    visit(tree)
    require(len(cases) == 1, "Missing or duplicate restart test case")
    identifier = cases[0].get("nodeIdentifier", "")
    require(suite in identifier and method in identifier and cases[0].get("result") == "Passed", "Wrong restart test executed")


def process_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def main(simulator):
    source = run(["git", "rev-parse", "HEAD"], capture=True).strip()
    require(len(source) == 40 and all(c in "0123456789abcdef" for c in source), "Missing source identity")
    nonce = str(uuid.uuid4())
    destination = f"platform=iOS Simulator,id={simulator}"
    build = ["xcodebuild", "-project", "apps/ios/OpenClaw.xcodeproj", "-scheme", "OpenClaw",
             "-configuration", "Debug", "-destination", destination]
    # Reuse the preceding lifecycle build products; the generated plist owns host paths and environment.
    run(build + ["-parallel-testing-enabled", "NO", "build-for-testing"])
    settings = json.loads(run(build + ["-showBuildSettings", "-json"], capture=True))
    hosts = [row["buildSettings"] for row in settings if row.get("target") == "OpenClaw"]
    require(len(hosts) == 1, "Expected one OpenClaw build target")
    products = Path(hosts[0]["BUILD_DIR"])
    built_app = Path(hosts[0]["TARGET_BUILD_DIR"]) / hosts[0]["FULL_PRODUCT_NAME"]
    require(products.is_absolute() and built_app.is_absolute(), "Build products must be absolute")
    bundle_id, built_digest = bundle_identity(built_app)
    document = selected_run(products)
    results = Path("apps/ios/build/LifecycleTestResults")
    results.mkdir(parents=True, exist_ok=True)

    def phase(name, suite, method, configuration):
        # Keep __TESTROOT__ unchanged when copying the generated run configuration.
        run_file = products / f"OpenClawAccessRestart{name.title()}.xctestrun"
        with run_file.open("wb") as handle:
            plistlib.dump(configuration, handle)
        result = results / f"AccessRestart{name.title()}.xcresult"
        environment = dict(os.environ)
        for key, value in {"NONCE": nonce, "SOURCE": source, "PHASE": name}.items():
            environment[f"TEST_RUNNER_OPENCLAW_ACCESS_RESTART_{key}"] = value
        run(["xcodebuild", "-xctestrun", str(run_file), "-destination", destination,
             "-parallel-testing-enabled", "NO", f"-only-testing:OpenClawTests/{suite}",
             "-resultBundlePath", str(result), "test-without-building"], env=environment)
        verify_result(result, suite, method)

    phase("seed", "GatewayAccessRestartSeedTests", "seed acknowledged sign out", document)

    def container(kind):
        return Path(run(["xcrun", "simctl", "get_app_container", simulator, bundle_id, kind], capture=True).strip()).resolve(strict=True)

    app, data = container("app"), container("data")
    require(bundle_identity(app) == (bundle_id, built_digest), "Installed app differs from the seed build")
    test_bundles = list((app / "PlugIns").glob("OpenClawTests.xctest"))
    require(len(test_bundles) == 1, "Expected one installed hosted test bundle")
    test_bundle = test_bundles[0]
    test_identity = bundle_identity(test_bundle)
    receipt = read_plist(data / "Library/Application Support" / f"access-restart-{nonce}.plist")
    require(receipt["nonce"] == nonce and receipt["source"] == source and receipt["bundleID"] == bundle_id,
            "Seed handoff identity mismatch")
    require(Path(receipt["container"]).resolve() == data and receipt["executableSHA256"] == built_digest,
            "Seed handoff storage or binary mismatch")
    pid = receipt["processID"]
    require(type(pid) is int and pid > 1, "Missing seed process identity")
    if process_exists(pid):
        # Only the exact app on this simulator may be terminated, never a host PID.
        run(["xcrun", "simctl", "terminate", simulator, bundle_id])
    deadline = time.monotonic() + 5
    while process_exists(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    require(not process_exists(pid), "Seed app process did not exit")

    installed_run = copy.deepcopy(document)
    target = selected_target(installed_run)
    target["UseDestinationArtifacts"] = True
    target["TestHostBundleIdentifier"] = bundle_id
    target["TestBundleDestinationRelativePath"] = "__TESTHOST__/" + test_bundle.relative_to(app).as_posix()
    for key in ["TestHostPath", "TestBundlePath", "UITargetAppPath"]:
        target.pop(key, None)
    # Xcode's destination-artifact mode forbids reinstalling between the two processes.
    phase("verify", "GatewayAccessRestartVerifyTests", "verify acknowledged sign out", installed_run)
    require(container("app") == app and container("data") == data, "App or data container changed across restart")
    require(bundle_identity(app) == (bundle_id, built_digest) and bundle_identity(test_bundle) == test_identity,
            "Installed app or test executable changed across restart")
    print(f"ACCESS_RESTART passed source={source} seed_pid={pid} app_sha256={built_digest} test_sha256={test_identity[1]}")


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and bool(sys.argv[1]), "Expected simulator UDID")
        main(sys.argv[1])
    except Exception as error:
        print(str(error), file=sys.stderr)
        print("[ios-access-restart] FAILED (exit 1)", file=sys.stderr)
        sys.exit(1)
