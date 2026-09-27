import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Test-only allocator, NOT a Gateway/service/storage mock. Each allocation owns
// an actual installed OpenClaw node process in a separate home. Only this
// backend's synthetic infrastructure and receipts live in this process.
const [packageRoot, root, artifacts] = process.argv.slice(2);
assert(packageRoot && root && artifacts);
await fsp.mkdir(root, { recursive: true, mode: 0o700 });
const leases = new Map();
const runtimes = new Map();
const waiters = new Set();
const active = new Set();
let closing = false;
const receiptPath = path.join(artifacts, "legacy-worker-backend.json");
const leaseIdFor = (operationId) => {
  assert.equal(typeof operationId, "string");
  assert(operationId.length > 0 && operationId.length < 256);
  return "legacy-" + createHash("sha256").update(operationId).digest("hex").slice(0, 24);
};
const projection = () =>
  Array.from(leases.values(), ({ child, joined: _joined, ...entry }) => {
    entry.running = Boolean(child && child.exitCode === null && child.signalCode === null);
    return entry;
  });
function record() {
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({ backend: "controlled-local-node", leases: projection(), closing }, null, 2) +
      "\n",
  );
  for (const check of waiters) {
    check();
  }
}
async function installedRuntime() {
  const build = JSON.parse(
    await fsp.readFile(path.join(packageRoot, "dist/build-info.json"), "utf8"),
  );
  assert.match(build.commit, /^[a-f0-9]{40}$/u);
  // Never let replacement of the Gateway's package mutate an existing node.
  // No second updater or npm install: copy the currently installed application
  // and dependencies, then use its public node CLI and real worker-bundle IPC.
  if (!runtimes.has(build.commit)) {
    runtimes.set(
      build.commit,
      (async () => {
        const destination = path.join(root, "runtimes", build.commit);
        await fsp.cp(packageRoot, destination, { recursive: true, dereference: true });
        assert.deepEqual(
          JSON.parse(await fsp.readFile(path.join(destination, "dist/build-info.json"), "utf8")),
          build,
        );
        return { cli: path.join(destination, "openclaw.mjs"), build };
      })(),
    );
  }
  return runtimes.get(build.commit);
}
async function joinProcessGroup(group) {
  const deadline = Date.now() + 10_000;
  while (true) {
    const live = (
      await Promise.all(
        (await fsp.readdir("/proc"))
          .filter((name) => /^\d+$/u.test(name))
          .map(async (pid) => {
            try {
              const stat = await fsp.readFile("/proc/" + pid + "/stat", "utf8");
              const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
              return Number(fields[2]) === group && fields[0] !== "Z";
            } catch (error) {
              if (error.code === "ENOENT" || error.code === "ESRCH") {
                return false;
              }
              throw error;
            }
          }),
      )
    ).some(Boolean);
    if (!live) {
      return;
    }
    assert(Date.now() < deadline, "Owned worker process group did not stop");
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function destroy(entry, cleanup = false) {
  entry.destroyCalls += cleanup ? 0 : 1;
  if (entry.destroyed) {
    record();
    return;
  }
  if (entry.child?.pid) {
    const child = entry.child;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 10_000);
    try {
      await entry.joined;
    } finally {
      clearTimeout(timer);
    }
    // Kill any remaining descendants in this exclusively owned process group.
    kill("SIGKILL");
    await joinProcessGroup(child.pid);
  }
  entry.groupJoined = true;
  entry.destroyed = true;
  entry.destructions++;
  entry.cleanup = cleanup;
  record();
}
async function dispatch(action, params) {
  if (action === "snapshot") {
    return { leases: projection() };
  }
  if (action === "wait-inspected") {
    const satisfied = () => (leases.get(params.leaseId)?.inspections ?? 0) > params.after;
    if (!satisfied()) {
      await new Promise((resolve, reject) => {
        const check = () => {
          if (closing || satisfied()) {
            clearTimeout(timer);
            waiters.delete(check);
            if (closing) {
              reject(new Error("Backend closed before inspection"));
            } else {
              resolve();
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("Gateway did not inspect the retained lease"));
        }, 180_000);
        waiters.add(check);
      });
    }
    return { leases: projection() };
  }
  assert(!closing, "Backend is closing");
  if (action === "resolve" || action === "allocate") {
    const leaseId = leaseIdFor(params.operationId);
    if (action === "allocate") {
      if (!leases.has(leaseId)) {
        leases.set(leaseId, {
          leaseId,
          operationId: params.operationId,
          allocations: 1,
          allocateCalls: 0,
          launches: 0,
          inspections: 0,
          destroyCalls: 0,
          destructions: 0,
          destroyed: false,
        });
      }
      const entry = leases.get(leaseId);
      assert(!entry.destroyed, "Cannot reallocate a destroyed operation");
      entry.allocateCalls++;
      record();
    }
    return { leaseId, sharedHost: false };
  }
  const entry = leases.get(params.leaseId);
  if (action === "inspect") {
    if (!entry) {
      return { status: "unknown" };
    }
    entry.inspections++;
    record();
    return entry.destroyed
      ? { status: "destroyed" }
      : {
          status:
            entry.child && entry.child.exitCode === null && entry.child.signalCode === null
              ? "active"
              : "unknown",
          sharedHost: false,
        };
  }
  if (action === "destroy") {
    // resolveAllocation is an identity, not evidence that allocate ran.
    if (entry) {
      await destroy(entry);
    }
    return { destroyed: true };
  }
  assert(entry, "Unknown owned lease");
  assert.equal(action, "launch");
  assert(!entry.destroyed);
  if (entry.child) {
    assert.equal(entry.child.exitCode, null);
    return { pid: entry.child.pid };
  }
  const runtime = await installedRuntime();
  assert(!closing, "Backend closed during runtime preparation");
  const home = path.join(root, entry.leaseId);
  const state = path.join(home, ".openclaw");
  await fsp.mkdir(state, { recursive: true, mode: 0o700 });
  // Enrollment credentials stay private, never in uploaded receipts or argv.
  const target = path.join(home, "enrollment-code");
  assert.equal(params.mode, "connect", "Fresh local allocation requires public connect enrollment");
  assert.equal(typeof params.setupCode, "string");
  // Observe the real enrollment payload, never substitute its URL or credentials.
  const enrollment = JSON.parse(Buffer.from(params.setupCode, "base64url").toString("utf8"));
  const gateway = new URL(enrollment.url);
  assert.equal(gateway.protocol, "wss:");
  assert(
    Object.values(os.networkInterfaces())
      .flat()
      .some(
        (address) =>
          address &&
          !address.internal &&
          address.family === "IPv4" &&
          address.address === gateway.hostname,
      ),
    "Enrollment must target this container's non-loopback interface",
  );
  assert.match(enrollment.tlsFingerprint, /^[a-f0-9]{64}$/u);
  entry.gateway = { url: enrollment.url, tlsFingerprint: enrollment.tlsFingerprint };
  await fsp.writeFile(target, params.setupCode, { mode: 0o600 });
  const log = fs.openSync(path.join(home, "node.log"), "a", 0o600);
  assert(!closing, "Backend closed during node preparation");
  const child = spawn(
    process.execPath,
    [
      runtime.cli,
      "connect",
      "--target-file",
      target,
      "--ephemeral",
      "--display-name",
      params.displayName,
    ],
    {
      cwd: home,
      // Deliberately do not inherit Gateway config, plugin paths, auth, or update markers.
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        CI: "true",
        OPENCLAW_ALLOW_ROOT: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
      },
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  fs.closeSync(log);
  entry.child = child;
  entry.joined = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      entry.exit = { code, signal };
      record();
      resolve();
    });
  });
  await once(child, "spawn");
  entry.pid = child.pid;
  entry.build = runtime.build;
  entry.launches++;
  record();
  return { pid: child.pid };
}
// Mutating backend requests are serialized. Inspection waits must not occupy
// that queue, or the Gateway's later inspection could never satisfy them.
let mutations = Promise.resolve();
const server = http.createServer((request, response) => {
  const task = (async () => {
    try {
      assert.equal(request.method, "POST");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert(body.length <= 65_536);
      }
      const params = JSON.parse(body);
      const action = request.url.slice(1);
      const operation = () => dispatch(action, params);
      const pending = ["snapshot", "wait-inspected"].includes(action)
        ? operation()
        : mutations.then(operation);
      if (!["snapshot", "wait-inspected"].includes(action)) {
        mutations = pending.catch(() => {});
      }
      const value = await pending;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    } catch (error) {
      // No request body is copied into the receipts; the publisher redacts logs.
      response.writeHead(500).end("Controlled backend operation failed");
      console.error(
        error instanceof Error ? error.name + ": " + error.message : "Unknown backend failure",
      );
    }
  })();
  active.add(task);
  void task.finally(() => active.delete(task));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
fs.writeFileSync(
  path.join(artifacts, "legacy-worker-endpoint"),
  "http://127.0.0.1:" + server.address().port + "/\n",
);
record();
let shutdown;
function stop() {
  shutdown ??= (async () => {
    try {
      closing = true;
      record();
      server.close();
      await Promise.allSettled(active);
      await mutations;
      await Promise.all([...leases.values()].map((entry) => destroy(entry, true)));
      server.closeAllConnections();
      record();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  })();
  return shutdown;
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
