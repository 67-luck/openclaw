const { WebSocketServer } = require(
  require.resolve("ws", { paths: [process.env.OPENCLAW_BENCH_REPO || process.cwd()] }),
);
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const root = process.env.RFC54_BENCH_ROOT || __dirname;
const mode = process.argv[2] || root + "/bin/openclaw-mac-node-sidecar";
const label = process.argv[3] || "candidate-functional";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function descendants(pid) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((x) => x.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  for (let i = 0; i < 4; i++) for (const [id, parent] of rows) if (ids.has(parent)) ids.add(id);
  return [...ids];
}
function deadline(p, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error(label + " timed out")), 5000);
      timer.unref();
    }),
  ]);
}
(async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(server, "listening");
  let ws;
  let child;
  let stderr = "";
  let stdout = "";
  const results = new Map(),
    progress = new Map(),
    cancelled = new Set(),
    cancelEvents = new Map();
  const observed = new Set();
  let finished = false;
  let record = { mode, checks: [] };
  server.on("connection", (socket) => {
    ws = socket;
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "functional-nonce", ts: Date.now() },
      }),
    );
    socket.on("message", (raw) => {
      const f = JSON.parse(raw);
      if (f.method === "connect")
        socket.send(
          JSON.stringify({
            type: "res",
            id: f.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: f.params.maxProtocol,
              server: { version: "fixture", connId: "functional" },
              features: {
                methods: ["node.invoke.result", "node.invoke.progress"],
                events: [],
                capabilities: [],
              },
              snapshot: {
                presence: [{ ts: 1 }],
                health: {},
                stateVersion: { presence: 0, health: 0 },
                uptimeMs: 0,
              },
              policy: { maxPayload: 16777216, maxBufferedBytes: 16777216, tickIntervalMs: 30000 },
              auth: { role: "node", scopes: [] },
            },
          }),
        );
      else {
        socket.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: {} }));
        if (f.method === "node.invoke.result") results.set(f.params.id, f.params);
        if (f.method === "node.invoke.progress") progress.set(f.params.invokeId, f.params);
      }
    });
  });
  const ready = new Promise((resolve, reject) => {
    child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-D",
        `BENCH_ROOT=${fs.realpathSync(root)}`,
        "-D",
        `BENCH_ENDPOINT=localhost:${server.address().port}`,
        "-f",
        root + "/sandbox.sb",
        root + "/bin/functional-probe",
        `ws://127.0.0.1:${server.address().port}`,
        mode,
      ],
      {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root + "/home",
          CFFIXED_USER_HOME: root + "/home",
          TMPDIR: root + "/tmp/",
          LANG: "en_US.UTF-8",
        },
      },
    );
    observed.add(child.pid);
    child.stdout.on("data", (data) => {
      stdout += data;
      while (stdout.includes("\n")) {
        const index = stdout.indexOf("\n");
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        const row = JSON.parse(line);
        if (row.ready) resolve();
        if (row.nativeCancelled) cancelled.add(row.nativeCancelled);
        if (row.nativeCancelEvent)
          cancelEvents.set(
            row.nativeCancelEvent,
            (cancelEvents.get(row.nativeCancelEvent) || 0) + 1,
          );
      }
    });
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("exit", (code, signal) => reject(Error(`exit ${code}/${signal} ${stderr}`)));
  });
  async function until(predicate, label) {
    return deadline(
      (async () => {
        while (!predicate()) {
          if (finished) throw Error("fixture finished");
          await delay(5);
        }
        return predicate();
      })(),
      label,
    );
  }
  const invoke = (id, command, params = { data: "native" }, timeoutMs = 30000) =>
    ws.send(
      JSON.stringify({
        type: "event",
        event: "node.invoke.request",
        payload: {
          id,
          nodeId: "functional-node",
          command,
          paramsJSON: JSON.stringify(params),
          timeoutMs,
          idempotencyKey: id,
        },
      }),
    );
  const payload = (result) =>
    result.payloadJSON === undefined ? result.payload : JSON.parse(result.payloadJSON);
  try {
    await deadline(ready, "startup");
    for (const pid of descendants(child.pid)) observed.add(pid);
    for (const [id, raw] of [
      ["raw-missing", undefined],
      ["raw-null", "null"],
      ["raw-order", '{ "b":2, "a":1 }'],
    ]) {
      const item = {
        id,
        nodeId: "functional-node",
        command: "benchmark.raw",
        timeoutMs: 30000,
        idempotencyKey: id,
      };
      if (raw !== undefined) item.paramsJSON = raw;
      ws.send(JSON.stringify({ type: "event", event: "node.invoke.request", payload: item }));
      const res = await until(() => results.get(id), "original paramsJSON");
      const body = payload(res);
      if (
        !res.ok ||
        body.present !== (raw !== undefined) ||
        body.raw !== (raw === undefined ? "missing" : raw)
      )
        throw Error("original paramsJSON changed: " + JSON.stringify({ id, res }));
    }
    record.checks.push({
      scenario: "missing, literal null, original whitespace/key-order paramsJSON preserved",
      passed: true,
    });
    invoke("system-one", "system.echo", { source: "Swift native handler" });
    const system = await until(() => results.get("system-one"), "system admission");
    if (!system.ok || payload(system).source !== "Swift native handler")
      throw Error("system echo mismatch");
    record.checks.push({ scenario: "system command admission and native result", passed: true });
    invoke("duplex-one", "benchmark.duplex");
    const initial = await until(() => progress.get("duplex-one"), "duplex progress");
    if (initial.seq !== 0 || initial.chunk !== "native-start") throw Error("progress integrity");
    const input = { source: "Gateway input", unicode: "☃" };
    ws.send(
      JSON.stringify({
        type: "event",
        event: "node.invoke.input",
        payload: {
          id: "duplex-one",
          nodeId: "functional-node",
          seq: 0,
          payloadJSON: JSON.stringify(input),
        },
      }),
    );
    const duplex = await until(() => results.get("duplex-one"), "duplex result");
    if (!duplex.ok || JSON.stringify(payload(duplex)) !== JSON.stringify(input))
      throw Error("duplex payload mismatch");
    record.checks.push({
      scenario: "native progress and Gateway input reach Swift; result integrity",
      passed: true,
    });
    invoke("cancel-one", "system.notify");
    await until(() => progress.get("cancel-one"), "cancel handler startup");
    ws.send(
      JSON.stringify({
        type: "event",
        event: "node.invoke.cancel",
        payload: { invokeId: "cancel-one", nodeId: "functional-node" },
      }),
    );
    const cancelledResult = await until(() => results.get("cancel-one"), "cancel result");
    if (cancelledResult.ok) throw Error("cancel succeeded unexpectedly");
    await until(() => cancelled.has("cancel-one"), "native Swift task cancellation");
    record.checks.push({
      scenario: "Gateway cancellation reaches native Swift task and yields failed result",
      passed: true,
      error: cancelledResult.error,
    });
    await delay(50);
    if (cancelEvents.get("cancel-one") !== 1)
      throw Error("expected exactly one native cancellation event");
    if (cancelEvents.has("system-one") || cancelEvents.has("duplex-one"))
      throw Error("spurious cancellation after native completion");
    invoke("timeout-one", "system.notify", {}, 200);
    await until(() => progress.get("timeout-one"), "timeout handler startup");
    const timed = await until(() => results.get("timeout-one"), "timeout result");
    if (timed.ok) throw Error("timeout succeeded unexpectedly");
    await until(() => cancelled.has("timeout-one"), "native Swift task timeout cleanup");
    record.checks.push({
      scenario: "deadline stops native Swift task and yields failed result",
      passed: true,
      error: timed.error,
    });
    if (mode !== "baseline" && process.env.RFC54_CHECK_OVERFLOW === "1") {
      invoke("overflow-one", "system.notify");
      await until(() => progress.get("overflow-one"), "overflow handler startup");
      const large = JSON.stringify({ data: "x".repeat(15000) });
      for (let seq = 0; seq < 128; seq++)
        ws.send(
          JSON.stringify({
            type: "event",
            event: "node.invoke.input",
            payload: { id: "overflow-one", nodeId: "functional-node", seq, payloadJSON: large },
          }),
        );
      const overflow = await until(() => results.get("overflow-one"), "overflow result");
      if (overflow.ok || overflow.error?.code !== "INPUT_BUFFER_OVERFLOW")
        throw Error("expected INPUT_BUFFER_OVERFLOW: " + JSON.stringify(overflow));
      await until(() => cancelled.has("overflow-one"), "native Swift task overflow cleanup");
      record.checks.push({
        scenario: "input overflow stops native Swift task",
        passed: true,
        error: overflow.error,
      });
    }
  } catch (error) {
    record.failure = error.message;
    throw error;
  } finally {
    finished = true;
    for (const pid of descendants(child.pid)) observed.add(pid);
    child.stdin.end();
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++)
      await delay(20);
    const forced = [];
    const live = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let remaining = [...observed].filter(live);
    for (let i = 0; i < 50 && remaining.length; i++) {
      await delay(20);
      remaining = remaining.filter(live);
    }
    for (const pid of remaining) {
      forced.push(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (let i = 0; i < 50 && remaining.length; i++) {
      await delay(20);
      remaining = remaining.filter(live);
    }
    record.nativeCancelEvents = Object.fromEntries(cancelEvents);
    record.cleanup = { observedPIDs: [...observed], forcedPIDs: forced, remainingPIDs: remaining };
    record.stderr = stderr;
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    fs.writeFileSync(root + "/" + label + ".json", JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record));
    if (forced.length || remaining.length) throw Error("unclean process shutdown");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
