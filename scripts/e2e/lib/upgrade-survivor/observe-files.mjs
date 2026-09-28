#!/usr/bin/env node

// Exercise the installed Gateway's observers after the published updater has finished.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { sleep } from "../../../lib/sleep.mjs";
import { createConfigReloadLogScanner } from "../config-reload/log-scanner.mjs";
import { onceFrame } from "../gateway-network/ws-frames.mts";
import { waitForWebSocketOpen } from "../websocket-open.mjs";

const [command, packageRoot, gatewayLog] = process.argv.slice(2);
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const workspace = process.env.OPENCLAW_TEST_WORKSPACE_DIR;
const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const token = process.env.GATEWAY_AUTH_TOKEN_REF;
assert(artifactRoot);
assert.equal(process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO ?? "base", "base");
const fixturePath = path.join(artifactRoot, "file-observation-fixture.json");
const evidencePath = path.join(artifactRoot, "file-observation.json");

if (command === "cleanup") {
  let fixture;
  try {
    fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      process.exit(0);
    }
    throw error;
  }
  // The survivor's process owner joins Gateway shutdown before restoring these bytes.
  assert.equal(configPath, fixture.configPath);
  await fs.writeFile(configPath, fixture.originalConfig);
  assert.equal(await fs.readFile(configPath, "utf8"), fixture.originalConfig);
  await fs.rm(fixture.skillDir, { recursive: true, force: true });
  await Promise.all(fixture.files.map((file) => fs.rm(file, { force: true })));
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  evidence.configRestored = true;
  evidence.status = evidence.observationsPassed && evidence.socketClosed ? "passed" : "failed";
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log("Published-upgrade observation fixtures restored after Gateway shutdown.");
  process.exit(0);
}
assert.equal(command, "observe");
assert(packageRoot && gatewayLog && configPath && workspace && token);

const originalConfig = await fs.readFile(configPath, "utf8");
const config = JSON.parse(originalConfig);
const nonce = randomUUID();
const skillName = `upgrade-observation-${nonce}`;
const skillDir = path.join(workspace, "skills", skillName);
const skillPath = path.join(skillDir, "SKILL.md");
const includePath = path.join(path.dirname(configPath), `upgrade-observation-${nonce}.json`);
await fs.writeFile(
  fixturePath,
  JSON.stringify({
    configPath,
    originalConfig,
    skillDir,
    files: [includePath, `${configPath}.${nonce}.tmp`, `${includePath}.${nonce}.tmp`],
  }),
  { mode: 0o600, flag: "wx" },
);
const startedAt = Date.now();
const deadline = startedAt + 120_000;
const evidence = {
  config: [],
  skills: [],
  observationsPassed: false,
  socketClosed: false,
  activeLabel: "connect",
  activeStage: "opening",
  failureStage: null,
  lastConfigAttempt: null,
  reloadTail: [],
};
const scanner = createConfigReloadLogScanner(gatewayLog);
const WebSocket = createRequire(path.join(packageRoot, "package.json"))("ws");
const socket = new WebSocket("ws://127.0.0.1:18789");

function remainingMs() {
  const remaining = deadline - Date.now();
  assert(remaining > 0, "post-upgrade observation exceeded its two-minute budget");
  return Math.min(30_000, remaining);
}

async function request(method, params = {}) {
  const id = randomUUID();
  const response = onceFrame(
    socket,
    (frame) => frame.type === "res" && frame.id === id,
    remainingMs(),
  );
  socket.send(JSON.stringify({ type: "req", id, method, params }));
  const frame = await response;
  assert.equal(frame.ok, true, `${method} failed: ${frame.error?.code ?? "unknown error"}`);
  return frame.payload;
}

async function writeJson(file, value, atomic = false) {
  const target = atomic ? `${file}.${nonce}.tmp` : file;
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (atomic) {
    await fs.rename(target, file);
  }
}

function fixtureValue(value, allowed) {
  return value === undefined ? null : allowed.includes(value) ? value : "other";
}

function opaqueRevision(value) {
  return typeof value === "string" ? value.slice(0, 128) : null;
}

function captureReloadTail(scanned) {
  evidence.reloadTail = scanned.tailLines
    .filter((line) => /reload|error|failed|refused|superseded|invalid/iu.test(line))
    .slice(-12)
    .map((line) => Buffer.from(line).subarray(0, 512).toString("utf8"));
}

async function observeConfig(label, changedPath, mutate, matches) {
  evidence.activeLabel = label;
  evidence.activeStage = "config-before-read";
  const before = await request("config.get");
  const { reloadLines, restartLines } = scanner.scan();
  const reloadCount = reloadLines.length;
  const restartCount = restartLines.length;
  const mutationStartedAt = Date.now();
  evidence.activeStage = "config-write";
  await mutate();
  evidence.activeStage = "config-observe";
  while (true) {
    const snapshot = await request("config.get");
    const scanned = scanner.scan();
    const detection = scanned.reloadLines
      .slice(reloadCount)
      .find((line) => line.includes(changedPath));
    captureReloadTail(scanned);
    const facts = {
      label,
      changedPath,
      elapsedMs: Date.now() - mutationStartedAt,
      valid: snapshot.valid === true,
      mode: fixtureValue(snapshot.config?.gateway?.reload?.mode, [
        "off",
        "hot",
        "hybrid",
        "restart",
      ]),
      seamColor: fixtureValue(snapshot.config?.ui?.seamColor, ["#112233", "#224466", "#335577"]),
      locale: fixtureValue(snapshot.config?.ui?.prefs?.locale, ["en", "en-US"]),
      beforeRevision: opaqueRevision(before.configRevisionHash),
      currentRevision: opaqueRevision(snapshot.configRevisionHash),
      appliedRevision: opaqueRevision(snapshot.appliedConfigHash),
      detection: Boolean(detection),
      restart: scanned.restartLines.length !== restartCount,
      hasRevision: typeof snapshot.configRevisionHash === "string",
      revisionChanged: snapshot.configRevisionHash !== before.configRevisionHash,
      applied: snapshot.configRevisionHash === snapshot.appliedConfigHash,
      valuesMatch: null,
    };
    evidence.lastConfigAttempt = facts;
    assert.equal(scanned.restartLines.length, restartCount, `${label} requested a Gateway restart`);
    // Keep predicate evaluation in its original order; diagnostics must not change the gate.
    if (detection && snapshot.valid) {
      facts.valuesMatch = matches(snapshot.config);
    }
    if (
      detection &&
      snapshot.valid &&
      facts.valuesMatch &&
      typeof snapshot.configRevisionHash === "string" &&
      snapshot.configRevisionHash !== before.configRevisionHash &&
      snapshot.configRevisionHash === snapshot.appliedConfigHash
    ) {
      evidence.config.push({
        label,
        changedPath,
        elapsedMs: Date.now() - mutationStartedAt,
        appliedConfigHash: snapshot.appliedConfigHash,
      });
      return;
    }
    await sleep(Math.min(100, remainingMs()));
  }
}

function skillContent(description) {
  return `---\nname: ${skillName}\ndescription: ${description}\n---\n\nSynthetic upgrade observation fixture.\n`;
}

async function observeSkill(label, mutate, description) {
  evidence.activeLabel = `skills-${label}`;
  evidence.activeStage = "skills-write";
  const mutationStartedAt = Date.now();
  // Settle the event before reading inventory: a fresh read alone could hide a broken watcher.
  const observed = onceFrame(
    socket,
    (frame) =>
      frame.type === "event" &&
      frame.event === "skills.changed" &&
      frame.payload?.reason === "watch",
    remainingMs(),
  ).then(
    (frame) => frame,
    () => null,
  );
  await mutate();
  evidence.activeStage = "skills-observe";
  const event = await observed;
  assert(event, `${label} did not receive a skills.changed watch event`);
  evidence.activeStage = "skills-inventory";
  const report = await request("skills.status", { agentId: "main" });
  const skill = report.skills.find((entry) => entry.name === skillName);
  if (description === undefined) {
    assert.equal(skill, undefined, `${label} retained the removed skill`);
  } else {
    assert.equal(skill?.description, description, `${label} returned stale skill contents`);
  }
  evidence.skills.push({
    label,
    reason: event.payload.reason,
    elapsedMs: Date.now() - mutationStartedAt,
  });
}

try {
  const challenge = onceFrame(
    socket,
    (frame) => frame.event === "connect.challenge",
    remainingMs(),
  );
  await Promise.all([waitForWebSocketOpen(socket, remainingMs()), challenge]);
  evidence.activeStage = "connect-rpc";
  await request("connect", {
    minProtocol: 4,
    maxProtocol: 4,
    client: { id: "cli", mode: "cli", version: "1.0.0", platform: process.platform },
    role: "operator",
    scopes: ["operator.read"],
    caps: [],
    auth: { token },
  });

  evidence.activeLabel = "root-write";
  evidence.activeStage = "prepare-config";
  await writeJson(includePath, { seamColor: "#112233" });
  config.gateway.reload = { ...config.gateway.reload, mode: "hot" };
  config.ui = { ...config.ui, $include: `./${path.basename(includePath)}` };
  delete config.ui.seamColor;
  config.ui.prefs = { ...config.ui.prefs, locale: "en" };
  await observeConfig(
    "root-write",
    "gateway.reload.mode",
    () => writeJson(configPath, config),
    (current) => current.gateway.reload.mode === "hot" && current.ui.seamColor === "#112233",
  );

  config.ui.prefs = { ...config.ui.prefs, locale: "en-US" };
  await observeConfig(
    "root-atomic-replace",
    "ui.prefs.locale",
    () => writeJson(configPath, config, true),
    (current) => current.ui.prefs.locale === "en-US",
  );
  await observeConfig(
    "include-write",
    "ui.seamColor",
    () => writeJson(includePath, { seamColor: "#224466" }),
    (current) => current.ui.seamColor === "#224466",
  );
  await observeConfig(
    "include-atomic-replace",
    "ui.seamColor",
    () => writeJson(includePath, { seamColor: "#335577" }, true),
    (current) => current.ui.seamColor === "#335577",
  );

  evidence.activeLabel = "skills-initial";
  evidence.activeStage = "skills-inventory";
  const initialSkills = await request("skills.status", { agentId: "main" });
  assert.equal(path.resolve(initialSkills.workspaceDir), path.resolve(workspace));
  assert(!initialSkills.skills.some((entry) => entry.name === skillName));
  await observeSkill(
    "create",
    async () => {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillPath, skillContent("Created after upgrade"));
    },
    "Created after upgrade",
  );
  evidence.activeLabel = "health";
  evidence.activeStage = "health-rpc";
  await request("health");
  evidence.observationsPassed = true;
  evidence.activeStage = "complete";
} catch (error) {
  evidence.failureStage = { label: evidence.activeLabel, stage: evidence.activeStage };
  throw error;
} finally {
  try {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) => {
        socket.once("close", resolve);
      });
      const timer = setTimeout(() => socket.terminate(), 8_000);
      try {
        socket.close();
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
    evidence.socketClosed = true;
  } finally {
    try {
      captureReloadTail(scanner.scan());
    } catch {
      evidence.reloadTailUnavailable = true;
    }
    await fs.writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          status: "pending-cleanup",
          ...evidence,
          elapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      )}\n`,
    );
  }
}
console.log("Published-upgrade Gateway config and skills observation passed; connection closed.");
