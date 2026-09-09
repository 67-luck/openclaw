import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { TLSSocket } from "node:tls";

const scopes = ["operator.read", "operator.talk"];
const systemKeychain = "/Library/Keychains/System.keychain";
const packagePath = "apps/shared/OpenClawKit";
const proofSource = "test/fixtures/ios-watch-operator-https.swift";
const cancelled = new AbortController();

type CommandResult = { code: number | null; stdout: string };
type DriverResult = {
  ok: boolean;
  stage?: string;
  deviceID?: string;
  publicKey?: string;
  platform?: string;
  deviceFamily?: string;
  connectionID?: string;
  persistedAuth?: boolean;
  tokenlessHello?: boolean;
  unchangedStoredGrant?: boolean;
  methods?: string[];
  errors?: { domain: string; code: number }[];
};
type Delivery = { route: string; status: number; tls: string | null; connectionID?: string };
type SwiftCommand = {
  moduleName: string;
  objects: string[];
  importPath: string;
  otherArguments: string[];
};

async function command(
  tool: string,
  args: string[],
  options: {
    input?: string;
    timeout?: number;
    cleanup?: boolean;
    allowFailure?: boolean;
    compilerDiagnostics?: boolean;
  } = {},
): Promise<CommandResult> {
  assert(!options.compilerDiagnostics || (["swift", "swiftc"].includes(tool) && !options.input));
  const child = spawn(tool, args, {
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.cleanup ? undefined : cancelled.signal,
    timeout: options.timeout ?? 30000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let diagnostics = "";
  let bytes = 0;
  let overflow = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (options.compilerDiagnostics && diagnostics.length < 65536) {
        diagnostics += chunk.toString("utf8").slice(0, 65536 - diagnostics.length);
      }
      if (bytes > 4 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      } else if (stream === child.stdout) {
        stdout += chunk.toString("utf8");
      }
    });
  }
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  let spawnFailed = false;
  child.on("error", () => {
    spawnFailed = true;
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  if (options.compilerDiagnostics && (code !== 0 || spawnFailed || overflow)) {
    // These commands run before identity/token/CA provisioning. Runtime stderr is
    // never included; retain bounded source diagnostics without runner paths.
    console.error(
      diagnostics
        .replaceAll(process.cwd(), "<checkout>")
        .replace(/\/(?:Users|private|var|tmp|Volumes)\/[^\s:)"']+/g, "<path>"),
    );
  }
  assert(
    !spawnFailed && !overflow && (options.allowFailure || code === 0),
    `${path.basename(tool)} failed (${code})`,
  );
  return { code, stdout };
}

async function compileDriver(scratch: string, executable: string): Promise<void> {
  await command(
    "swift",
    [
      "build",
      "--package-path",
      packagePath,
      "--scratch-path",
      scratch,
      "--target",
      "OpenClawKit",
      "--jobs",
      "4",
    ],
    { timeout: 300000, compilerDiagnostics: true },
  );
  const { stdout } = await command("swift", [
    "build",
    "--package-path",
    packagePath,
    "--scratch-path",
    scratch,
    "--show-bin-path",
  ]);
  const bin = await realpath(stdout.trim());
  const description: {
    swiftCommands: Record<string, SwiftCommand>;
    targetDependencyMap: Record<string, string[]>;
  } = JSON.parse(await readFile(path.join(bin, "description.json"), "utf8"));
  // Use SwiftPM's actual production dependency closure, never test objects or a filesystem glob.
  const modules = new Set(["OpenClawKit"]);
  for (const name of modules) {
    assert(!name.includes("Test"), "Test target in production link closure");
    for (const dependency of description.targetDependencyMap[name] ?? []) {
      modules.add(dependency);
    }
  }
  const objects: string[] = [];
  let root: SwiftCommand | undefined;
  for (const name of modules) {
    const matches = Object.values(description.swiftCommands).filter(
      (entry) => entry.moduleName === name,
    );
    assert.equal(matches.length, 1, `Missing or ambiguous production module: ${name}`);
    const entry = matches[0];
    assert(entry && entry.objects.length > 0);
    if (name === "OpenClawKit") {
      root = entry;
    }
    for (const object of entry.objects) {
      assert(
        object.startsWith(`${bin}${path.sep}`) && object.endsWith(".o"),
        "Object outside build manifest",
      );
      objects.push(object);
    }
  }
  assert(root);
  const compilerArgs = ["-swift-version", "6", "-parse-as-library", "-I", root.importPath];
  for (const flag of ["-target", "-sdk"]) {
    const value: string | undefined = root.otherArguments[root.otherArguments.indexOf(flag) + 1];
    assert(value && root.otherArguments.includes(flag), `Missing SwiftPM ${flag}`);
    compilerArgs.push(flag, value);
  }
  await command(
    "swiftc",
    [...compilerArgs, proofSource, ...objects, "-lsqlite3", "-o", executable],
    {
      timeout: 120000,
      compilerDiagnostics: true,
    },
  );
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function main(): Promise<void> {
  assert(
    process.platform === "darwin" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "This proof changes certificate trust only on a disposable GitHub-hosted macOS runner",
  );
  const runnerTemp = await realpath(process.env.RUNNER_TEMP ?? "");
  const output = path.join(runnerTemp, "watch-qualification");
  const privateRoot = path.join(runnerTemp, `watch-https-private-${randomUUID()}`);
  const scratch = path.join(runnerTemp, "watch-qualification-swift");
  await mkdir(output, { recursive: true });
  await mkdir(privateRoot, { mode: 0o700 });
  process.umask(0o077);
  const gatewayState = path.join(privateRoot, "gateway");
  const swiftState = path.join(privateRoot, "swift");
  const home = path.join(privateRoot, "home");
  await Promise.all([gatewayState, swiftState, home].map((dir) => mkdir(dir, { mode: 0o700 })));

  // Select isolation before importing any runtime module that can capture a state/config root.
  const inherited = new Set(["PATH", "TMPDIR", "DEVELOPER_DIR", "SDKROOT", "LANG", "LC_ALL"]);
  for (const key of Object.keys(process.env)) {
    if (!inherited.has(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCLAW_STATE_DIR: gatewayState,
    OPENCLAW_CONFIG_PATH: path.join(gatewayState, "openclaw.json"),
  });
  const report: Record<string, unknown> = { ok: false, node: process.version, stages: [] };
  const stages: string[] = [];
  report.stages = stages;
  const deliveries: Delivery[] = [];
  let overflow = false;
  let gateway:
    | Awaited<ReturnType<typeof import("../src/gateway/server.js").startGatewayServer>>
    | undefined;
  let trustAttempted = false;
  let fingerprint = "";
  let subscribed = false;
  let port = 0;
  const ca = path.join(privateRoot, "ca.pem");
  const responseFinish = channel("http.server.response.finish");
  const observe = (message: unknown) => {
    const { request, response, socket } = message as {
      request: IncomingMessage;
      response: ServerResponse;
      socket: TLSSocket;
    };
    if (!(socket instanceof TLSSocket) || socket.localPort !== port) {
      return;
    }
    const match = /^\/api\/operator\/connections(?:\/([^/?]+)(?:\/(frames|poll))?)?$/.exec(
      request.url ?? "",
    );
    if (!match) {
      return;
    }
    if (deliveries.length >= 128) {
      overflow = true;
      return;
    }
    deliveries.push({
      route: request.method === "DELETE" ? "delete" : (match[2] ?? "begin"),
      status: response.statusCode,
      tls: socket.getProtocol(),
      connectionID: match[1],
    });
  };
  const interrupt = () => cancelled.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let failure = false;
  try {
    stages.push("compile-production-driver");
    const executable = path.join(privateRoot, "operator-https");
    await compileDriver(scratch, executable);
    const driver = async (mode: string, input?: object) => {
      const result = await command(executable, [mode, swiftState], {
        input: input ? JSON.stringify(input) : undefined,
        timeout: 90000,
        allowFailure: true,
      });
      assert(Buffer.byteLength(result.stdout) <= 16384, "Driver output exceeds bound");
      const value: DriverResult = JSON.parse(result.stdout);
      if (result.code !== 0 || !value.ok) {
        // The driver emits only allowlisted stages and numeric error metadata.
        report.driverFailure = { stage: value.stage, errors: value.errors };
        throw new Error("Foundation driver failed");
      }
      return value;
    };
    const identity = await driver("identity");
    assert(identity.deviceID && identity.publicKey && identity.platform && identity.deviceFamily);
    stages.push("generate-localhost-certificate");
    const caKey = path.join(privateRoot, "ca.key");
    const leafKey = path.join(privateRoot, "leaf.key");
    const csr = path.join(privateRoot, "leaf.csr");
    const cert = path.join(privateRoot, "leaf.pem");
    const ext = path.join(privateRoot, "leaf.ext");
    await command("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      `/CN=OpenClaw HTTPS proof ${randomUUID()}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      caKey,
      "-out",
      ca,
    ]);
    fingerprint = new X509Certificate(await readFile(ca)).fingerprint256.replaceAll(":", "");
    await command("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=localhost",
      "-keyout",
      leafKey,
      "-out",
      csr,
    ]);
    await writeFile(
      ext,
      [
        "basicConstraints=critical,CA:FALSE",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "",
      ].join("\n"),
    );
    await command("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      ext,
      "-out",
      cert,
    ]);
    port = await reservePort();
    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token: randomBytes(32).toString("base64url") },
          tailscale: { mode: "off" },
          controlUi: { enabled: false },
          tls: { enabled: true, autoGenerate: false, certPath: cert, keyPath: leafKey, caPath: ca },
        },
        agents: { list: [{ id: "proof", workspace: path.join(privateRoot, "workspace") }] },
        logging: {
          level: "silent",
          consoleLevel: "silent",
          file: path.join(privateRoot, "gateway.log"),
        },
      }),
    );
    stages.push("canonical-owner-pairing");
    const { requestDevicePairing, getPairedDevice } =
      await import("../src/infra/device-pairing.js");
    const { approveDevicePairing } = await import("../src/infra/device-pairing-approval.js");
    const request = await requestDevicePairing(
      {
        deviceId: identity.deviceID,
        publicKey: identity.publicKey,
        platform: identity.platform,
        deviceFamily: identity.deviceFamily,
        clientId: "openclaw-watchos",
        clientMode: "node",
        role: "operator",
        scopes,
      },
      gatewayState,
    );
    const approved = await approveDevicePairing(
      request.request.requestId,
      {
        callerScopes: scopes,
        approvedVia: "owner",
      },
      gatewayState,
    );
    assert(approved?.status === "approved");
    const grant = approved.device.tokens?.operator;
    assert(grant && grant.token && grant.role === "operator");
    assert.deepEqual(grant.scopes, scopes);
    const paired = await getPairedDevice(identity.deviceID, gatewayState);
    assert.equal(paired?.approvedVia, "owner");
    assert.equal(paired?.tokens?.operator?.token, grant.token);
    const input = {
      endpoint: `https://localhost:${port}`,
      gatewayID: `watch-direct:https://localhost:${port}`,
      deviceID: identity.deviceID,
      token: grant.token,
    };
    stages.push("real-gateway-startup");
    const { startGatewayServer } = await import("../src/gateway/server.js");
    gateway = await startGatewayServer(port, { host: "127.0.0.1", updateCanary: true });
    await gateway.startupSettled;
    responseFinish.subscribe(observe);
    subscribed = true;
    stages.push("negative-system-trust");
    const negative = await driver("negative", input);
    assert.equal(negative.stage, "untrusted-certificate-rejected");
    assert.equal(negative.persistedAuth, true);
    assert.equal(deliveries.length, 0, "Operator HTTP reached Gateway before CA trust");
    report.negative = { persistedAuth: true, errors: negative.errors, operatorResponses: 0 };

    stages.push("install-hosted-localhost-trust");
    trustAttempted = true;
    await command("sudo", [
      "/usr/bin/security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-p",
      "ssl",
      "-s",
      "localhost",
      "-k",
      systemKeychain,
      ca,
    ]);
    stages.push("positive-system-trust");
    const positive = await driver("positive", input);
    assert.equal(positive.tokenlessHello, true);
    assert.equal(positive.unchangedStoredGrant, true);
    assert.deepEqual(positive.methods, ["agents.list", "sessions.list"]);
    assert(positive.connectionID && !overflow);
    assert.equal(
      deliveries.filter((event) => event.route === "begin" && event.status === 201).length,
      1,
    );
    assert(deliveries.every((event) => event.tls === "TLSv1.3"));
    assert(deliveries.some((event) => event.route === "frames" && event.status === 202));
    assert(deliveries.some((event) => event.route === "poll" && event.status === 200));
    assert(
      deliveries.some(
        (event) =>
          event.route === "delete" &&
          event.status === 204 &&
          event.connectionID === positive.connectionID,
      ),
      "No completed DELETE 204 for the actor connection",
    );
    report.positive = {
      tokenlessHello: true,
      unchangedStoredGrant: true,
      methods: positive.methods,
      responses: deliveries.map(({ route, status, tls }) => ({ route, status, tls })),
    };
  } catch {
    failure = true;
  } finally {
    const cleanupFailures: string[] = [];
    if (gateway) {
      await gateway
        .close({ reason: "qualification complete", drainTimeoutMs: 1000 })
        .catch(() => cleanupFailures.push("gateway-close"));
    }
    if (subscribed) {
      responseFinish.unsubscribe(observe);
    }
    if (trustAttempted) {
      for (const args of [
        ["/usr/bin/security", "remove-trusted-cert", "-d", ca],
        ["/usr/bin/security", "delete-certificate", "-Z", fingerprint, systemKeychain],
      ]) {
        await command("sudo", args, { cleanup: true }).catch(() =>
          cleanupFailures.push(args[1] ?? "trust-cleanup"),
        );
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await rm(privateRoot, { recursive: true, force: true }).catch(() =>
      cleanupFailures.push("private-state-cleanup"),
    );
    report.cleanupFailures = cleanupFailures;
    report.ok = !failure && !cancelled.signal.aborted && cleanupFailures.length === 0;
    await writeFile(
      path.join(output, "operator-https.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  assert.equal(
    report.ok,
    true,
    `Operator HTTPS qualification failed at ${stages.at(-1)}; see operator-https.json`,
  );
}

await main();
