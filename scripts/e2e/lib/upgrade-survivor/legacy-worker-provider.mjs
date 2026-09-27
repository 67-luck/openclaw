import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const providerId = "survivor-legacy";
const profileId = "legacy-survivor";
const pluginId = "legacy-worker-provider";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

export function assertLegacyEnvironment(actual, expected, state) {
  assert.equal(actual.id, expected.id, "Environment identity changed");
  for (const key of ["profileId", "providerId", "leaseId"]) {
    assert.equal(actual.worker[key], expected.worker[key], "Worker custody changed: " + key);
  }
  assert.equal(actual.worker.state, state);
  assert.equal(actual.worker.error, undefined, "Native worker lifecycle recorded an error");
  assert.deepEqual(actual.worker.attachedSessionIds, [], "Fixture lease unexpectedly attached");
}

export function assertLegacyBackend(receipt, expected) {
  assert.equal(receipt.leases.length, expected.length, "Missing or duplicate backend allocations");
  for (const { leaseId, commit, destroyed } of expected) {
    const rows = receipt.leases.filter((entry) => entry.leaseId === leaseId);
    assert.equal(rows.length, 1);
    const entry = rows[0];
    assert.equal(entry.allocations, 1);
    assert.equal(entry.allocateCalls, 1, "Provider unexpectedly allocated again");
    assert.equal(entry.launches, 1);
    assert.equal(entry.build.commit, commit);
    assert.equal(entry.destroyed, destroyed);
    assert.equal(entry.running, !destroyed);
    assert.equal(entry.destructions, destroyed ? 1 : 0);
    if (destroyed) {
      assert.equal(entry.groupJoined, true, "Worker descendants were not joined");
    }
    assert.equal(entry.destroyCalls, destroyed ? 1 : 0, "Teardown was omitted or duplicated");
    assert(!entry.cleanup, "Emergency cleanup is not successful provider teardown");
  }
}

export function assertLegacyDriver(started, exited, baseline, candidate) {
  assert.notEqual(candidate.sha256, baseline.sha256, "Candidate is the published archive");
  assert.notEqual(
    candidate.buildInfo.commit,
    baseline.buildInfo.commit,
    "Candidate source is still the published baseline",
  );
  assert.notEqual(
    candidate.buildInfo.buildId,
    baseline.buildInfo.buildId,
    "Candidate is already current",
  );
  assert.equal(started.postCore, false);
  assert.equal(started.version, baseline.version);
  assert.deepEqual(
    started.buildInfo,
    baseline.buildInfo,
    "First hop ran candidate code instead of the published driver",
  );
  assert.equal(started.entrySha256, baseline.files[started.relativeEntry]?.sha256);
  assert.equal(started.root, path.dirname(baseline.cli));
  assert(Number.isSafeInteger(started.pid) && started.pid > 0);
  assert(Number.isFinite(started.timeOriginUnixMs));
  assert.deepEqual(exited, { ...started, exitCode: 0 });
  assert.equal(started.args[0], "update");
  const tag = started.args[started.args.indexOf("--tag") + 1];
  assert(tag.startsWith("file:"), "Same-version first hop must target explicit candidate bytes");
  assert(started.args.includes("--no-restart"));
}

export function assertLegacyUpdateResult(result, baseline, candidate) {
  assert.equal(result.status, "ok");
  assert.notEqual(result.reason, "already-current");
  assert.equal(result.before?.version, baseline.version);
  assert.equal(result.after?.version, candidate.version);
  assert(
    Array.isArray(result.steps) && result.steps.length > 0,
    "First hop performed no update steps",
  );
}

function pluginInventory(root) {
  const files = {};
  const visit = (relative) => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), "External fixture contains a symlink");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).toSorted()) {
        visit(path.join(relative, name));
      }
    } else {
      assert(stat.isFile());
      files[relative] = hash(fs.readFileSync(file));
    }
  };
  visit("");
  return files;
}

async function main() {
  const [mode, argument] = process.argv.slice(2);
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const runtime = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
  const state = process.env.OPENCLAW_STATE_DIR;
  assert(artifacts && runtime && state);
  assert(path.resolve(state).startsWith(path.resolve(runtime) + path.sep));
  const plugin = path.join(runtime, "external-legacy-worker-provider");
  const proofFile = path.join(artifacts, "legacy-worker-proof.json");
  const proof = fs.existsSync(proofFile)
    ? readJson(proofFile)
    : {
        scenario: "legacy-worker-provider",
        status: "incomplete",
        snapshots: {},
        environments: {},
      };
  const cli = (args) =>
    execFileSync("openclaw", args, {
      encoding: "utf8",
      timeout: 660_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENCLAW_ALLOW_ROOT: "1" },
    });
  const rpc = (method, params = {}) =>
    JSON.parse(
      cli([
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--url",
        "wss://localhost:18789",
        "--token",
        process.env.GATEWAY_AUTH_TOKEN_REF,
        "--timeout",
        "600000",
        "--json",
      ]),
    );
  const endpointFile = path.join(artifacts, "legacy-worker-endpoint");
  const backend = async (action, params = {}) => {
    const endpoint = fs.readFileSync(endpointFile, "utf8").trim();
    const response = await fetch(new URL(action, endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(200_000),
    });
    assert(response.ok, "Controlled backend operation failed: " + action);
    return response.json();
  };
  const config = () => JSON.parse(cli(["config", "get", "cloudWorkers", "--json"]));
  const pluginOrigin = () => {
    const inspected = JSON.parse(cli(["plugins", "inspect", pluginId, "--json"]));
    assert.equal(inspected.plugin.id, pluginId);
    assert.equal(fs.realpathSync(inspected.plugin.source), path.join(plugin, "index.mjs"));
    assert.notEqual(inspected.plugin.origin, "bundled");
    return {
      id: inspected.plugin.id,
      source: inspected.plugin.source,
      origin: inspected.plugin.origin,
    };
  };
  const snapshot = async (stage) => {
    assert.deepEqual(
      pluginInventory(plugin),
      proof.pluginFiles,
      "External plugin bytes changed across upgrade",
    );
    assert.deepEqual(config(), proof.profileConfig, "Configured worker profile changed");
    const inventory = rpc("environments.list");
    assert(
      inventory.profiles.some((entry) => entry.id === profileId && entry.providerId === providerId),
      "Baseline plugin loader did not register the external provider",
    );
    const workers = inventory.environments.filter(
      (entry) => entry.worker?.providerId === providerId,
    );
    assert.equal(
      workers.length,
      Object.keys(proof.environments).length,
      "Lost or duplicated native environment rows",
    );
    const value = { workers, plugin: pluginOrigin(), backend: await backend("snapshot") };
    const name = "legacy-worker-" + stage + ".json";
    writeJson(path.join(artifacts, name), value);
    proof.snapshots[stage] = {
      file: name,
      sha256: hash(fs.readFileSync(path.join(artifacts, name))),
    };
    writeJson(proofFile, proof);
    return value;
  };
  const create = (label) => {
    const params = { profileId, idempotencyKey: "published-legacy-worker-" + label };
    const result = rpc("environments.create", params);
    assert.equal(
      result.worker?.state,
      "ready",
      "Real node enrollment/worker admission did not complete",
    );
    assert.equal(result.worker.providerId, providerId);
    assert.equal(result.worker.profileId, profileId);
    assert(result.worker.leaseId);
    proof.environments[label] = result;
    writeJson(proofFile, proof);
    assertLegacyEnvironment(rpc("environments.create", params), result, "ready");
    return result;
  };
  const destroy = (label) => {
    const expected = proof.environments[label];
    const result = rpc("environments.destroy", { environmentId: expected.id });
    assertLegacyEnvironment(result, expected, "destroyed");
    // Repeat the public Stop; the provider must not tear down twice.
    assertLegacyEnvironment(
      rpc("environments.destroy", { environmentId: expected.id }),
      expected,
      "destroyed",
    );
  };
  const waitInspected = async (label, after) => {
    await backend("wait-inspected", { leaseId: proof.environments[label].worker.leaseId, after });
  };
  const expectedBackend = (destroyedLabels) =>
    Object.entries(proof.environments).map(([label, environment]) => ({
      leaseId: environment.worker.leaseId,
      commit: readJson(
        path.join(
          artifacts,
          label === "fresh" ? "candidate-package-identity.json" : "baseline-package-identity.json",
        ),
      ).buildInfo.commit,
      destroyed: destroyedLabels.includes(label),
    }));

  if (mode === "setup") {
    await new Promise((resolve, reject) => {
      const check = () => {
        if (fs.existsSync(endpointFile) && fs.readFileSync(endpointFile, "utf8").endsWith("\n")) {
          clearTimeout(timer);
          watcher.close();
          resolve();
        }
      };
      const watcher = fs.watch(artifacts, check);
      const timer = setTimeout(() => {
        watcher.close();
        reject(new Error("Local backend did not bind"));
      }, 30_000);
      check();
    });
    fs.cpSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/legacy-worker-provider"),
      plugin,
      { recursive: true },
    );
    proof.pluginFiles = pluginInventory(plugin);
    cli(["plugins", "install", "--link", "--force", "--accept-capabilities", plugin]);
    assert.deepEqual(pluginInventory(plugin), proof.pluginFiles);
    proof.plugin = pluginOrigin();
    cli(["config", "set", "gateway.mode", "local"]);
    // The published enrollment owner advertises the container LAN address and
    // includes the local TLS pin. Do not override publicOrigin (that loses the pin).
    cli(["config", "set", "gateway.bind", "lan"]);
    cli(["config", "set", "gateway.controlUi.enabled", "false", "--strict-json"]);
    cli([
      "config",
      "set",
      "gateway.auth",
      JSON.stringify({ mode: "token", token: process.env.GATEWAY_AUTH_TOKEN_REF }),
      "--strict-json",
    ]);
    cli([
      "config",
      "set",
      "cloudWorkers",
      JSON.stringify({
        profiles: {
          [profileId]: {
            provider: providerId,
            install: "bundle",
            readyWorkers: 0,
            settings: { endpoint: fs.readFileSync(endpointFile, "utf8").trim() },
          },
        },
        preparedPool: { maxTotal: 0 },
      }),
      "--strict-json",
    ]);
    proof.profileConfig = config();
    writeJson(proofFile, proof);
  } else if (mode === "control") {
    create("control");
    await snapshot("baseline-control");
  } else if (mode === "seed") {
    const control = readJson(path.join(artifacts, proof.snapshots["baseline-control"].file)).backend
      .leases[0];
    await waitInspected("control", control.inspections);
    // Create replay shares the environment owner lock with reconciliation; it
    // observes settled inspect/guard errors, not just receipt of the backend call.
    assertLegacyEnvironment(
      rpc("environments.create", { profileId, idempotencyKey: "published-legacy-worker-control" }),
      proof.environments.control,
      "ready",
    );
    destroy("control");
    create("retained");
    const retained = await snapshot("baseline-retained");
    assertLegacyBackend(retained.backend, expectedBackend(["control"]));
  } else if (mode === "storage") {
    // Gateway has stopped. Read actual durable custody; never seed or migrate SQL.
    const db = new DatabaseSync(path.join(state, "state/openclaw.sqlite"), { readOnly: true });
    let rows;
    try {
      rows = db
        .prepare(
          "SELECT environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, lease_id, node_device_id, shared_host, owner_epoch, state, bootstrap_bundle_hash FROM worker_environments WHERE provider_id = ? ORDER BY environment_id",
        )
        .all(providerId)
        // SQLite returns null-prototype records; JSON snapshots use ordinary objects.
        .map((row) => Object.fromEntries(Object.entries(row)));
    } finally {
      db.close();
    }
    assert.equal(rows.length, Object.keys(proof.environments).length);
    if (argument === "before-update") {
      const retained = rows.find(
        (entry) => entry.environment_id === proof.environments.retained.id,
      );
      assert.equal(
        retained.state,
        "ready",
        "Published graceful Stop did not retain the ready lease; investigate shutdown contract",
      );
      assert(retained.node_device_id && retained.bootstrap_bundle_hash);
      assert.equal(retained.shared_host, 0);
      proof.nativeBeforeUpdate = rows;
      proof.backendBeforeUpdate = await backend("snapshot");
    } else {
      assert.equal(argument, "after-update");
      assert.deepEqual(
        rows,
        proof.nativeBeforeUpdate,
        "Updater lost or rewrote preexisting native worker custody",
      );
      proof.nativeAfterUpdate = rows;
    }
    writeJson(proofFile, proof);
  } else if (mode === "updater") {
    const baseline = readJson(path.join(artifacts, "baseline-package-identity.json"));
    const candidate = readJson(path.join(artifacts, "candidate-package-identity.json"));
    const starts = fs
      .readdirSync(argument)
      .filter((name) => /^legacy-worker-driver-\d+-started\.json$/u.test(name));
    const drivers = starts
      .map((name) => [name, readJson(path.join(argument, name))])
      .filter(
        ([, value]) => !value.postCore && value.buildInfo.commit === baseline.buildInfo.commit,
      );
    assert(drivers.length > 0, "Missing actual published updater process receipt");
    const updateText = fs.readFileSync(path.join(artifacts, "update.json"), "utf8");
    const update = JSON.parse(updateText.slice(updateText.indexOf("{")));
    assertLegacyUpdateResult(update, baseline, candidate);
    proof.update = { status: update.status, before: update.before, after: update.after };
    proof.drivers = drivers.map(([name, started]) => {
      const exited = readJson(path.join(argument, name.replace("-started", "-exited")));
      assertLegacyDriver(started, exited, baseline, candidate);
      return exited;
    });
    proof.baseline = {
      version: baseline.version,
      sha256: baseline.sha256,
      integrity: baseline.integrity,
      buildInfo: baseline.buildInfo,
    };
    proof.candidate = {
      version: candidate.version,
      sha256: candidate.sha256,
      integrity: candidate.integrity,
      buildInfo: candidate.buildInfo,
    };
    writeJson(proofFile, proof);
  } else if (mode === "candidate") {
    const retained = proof.environments.retained;
    const before = proof.backendBeforeUpdate.leases.find(
      (entry) => entry.leaseId === retained.worker.leaseId,
    );
    await waitInspected("retained", before.inspections);
    // Join the native owner lock after inspection before accepting its result.
    assertLegacyEnvironment(
      rpc("environments.create", { profileId, idempotencyKey: "published-legacy-worker-retained" }),
      retained,
      "ready",
    );
    assertLegacyEnvironment(
      rpc("environments.status", { environmentId: retained.id }),
      retained,
      "ready",
    );
    const after = await snapshot("candidate-retained");
    assertLegacyBackend(after.backend, expectedBackend(["control"]));
    destroy("retained");
    create("fresh");
    destroy("fresh");
    const final = await snapshot("candidate-destroyed");
    assertLegacyBackend(final.backend, expectedBackend(["control", "retained", "fresh"]));
  } else if (mode === "final") {
    const final = await snapshot("candidate-restarted");
    for (const expected of Object.values(proof.environments)) {
      assertLegacyEnvironment(
        final.workers.find((entry) => entry.id === expected.id),
        expected,
        "destroyed",
      );
    }
    assertLegacyBackend(final.backend, expectedBackend(["control", "retained", "fresh"]));
    assert(proof.drivers?.length && proof.nativeAfterUpdate);
    proof.status = "lifecycle-passed"; // The canonical summary still owns finally/cleanup success.
    writeJson(proofFile, proof);
  } else if (mode === "cleanup") {
    // Best-effort product cleanup first; backend finally owns all local processes
    // even if setup/provisioning failed before its RPC result reached the harness.
    if (fs.existsSync(proofFile)) {
      const inventory = rpc("environments.list");
      for (const entry of inventory.environments.filter(
        (item) => item.worker?.providerId === providerId && item.worker.state !== "destroyed",
      )) {
        rpc("environments.destroy", { environmentId: entry.id });
      }
    }
  } else {
    throw new Error("Unknown legacy worker survivor phase: " + mode);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
