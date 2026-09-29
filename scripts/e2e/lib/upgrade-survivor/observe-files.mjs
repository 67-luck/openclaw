#!/usr/bin/env node

// Exercise the installed Gateway's observers after the published updater has finished.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  await fs.rm(fixture.memoryDir, { recursive: true, force: true });
  await Promise.all(fixture.files.map((file) => fs.rm(file, { force: true })));
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  evidence.configRestored = true;
  evidence.status = evidence.observationsPassed && evidence.socketClosed ? "passed" : "failed";
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log("Published-upgrade observation fixtures restored after Gateway shutdown.");
  process.exit(0);
}
assert(command === "prepare" || command === "observe");
assert(configPath && workspace);

const currentConfig = await fs.readFile(configPath, "utf8");
const config = JSON.parse(currentConfig);
const nonce =
  command === "prepare" ? randomUUID() : JSON.parse(await fs.readFile(fixturePath, "utf8")).nonce;
const skillName = `upgrade-observation-${nonce}`;
const skillDir = path.join(workspace, "skills", skillName);
const skillPath = path.join(skillDir, "SKILL.md");
const memoryDir = path.join(workspace, "memory", skillName);
const memoryPath = path.join(memoryDir, "note.md");
const memoryRelativePath = path.relative(workspace, memoryPath).split(path.sep).join("/");
const memoryTokens = ["seed", "warmup", "edited"].map(
  (label) => `clawmemory${label}${nonce.replaceAll("-", "")}`,
);
const includePath = path.join(path.dirname(configPath), `upgrade-observation-${nonce}.json`);
if (command === "prepare") {
  assert.equal(process.env.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE ?? "manual", "manual");
  await fs.writeFile(
    fixturePath,
    JSON.stringify({
      configPath,
      originalConfig: currentConfig,
      nonce,
      skillDir,
      memoryDir,
      files: [includePath, `${configPath}.${nonce}.tmp`, `${includePath}.${nonce}.tmp`],
    }),
    { mode: 0o600, flag: "wx" },
  );
  await fs.writeFile(
    evidencePath,
    `${JSON.stringify({ status: "prepared", observationsPassed: false, socketClosed: false })}\n`,
  );
  // Prime discovery in the Gateway before any watcher can publish its initial scan.
  config.skills = { ...config.skills, load: { ...config.skills?.load, watch: false } };
  const agent = config.agents?.entries?.main;
  assert(agent, "Memory observation requires the fixture's main agent");
  agent.memory = {
    ...agent.memory,
    search: {
      ...agent.memory?.search,
      enabled: true,
      provider: "none",
      fallback: "none",
      sources: ["memory"],
      rememberAcrossConversations: false,
    },
  };
  config.plugins = {
    ...config.plugins,
    slots: { ...config.plugins?.slots, memory: "memory-core" },
    entries: {
      ...config.plugins?.entries,
      "memory-core": { ...config.plugins?.entries?.["memory-core"], enabled: true },
    },
  };
  if (config.plugins.allow) {
    config.plugins.allow = [...new Set([...config.plugins.allow, "memory-core"])];
  }
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(memoryPath, memoryTokens[0], { flag: "wx" });
  await writeJson(configPath, config);
  process.exit(0);
}
assert(packageRoot && gatewayLog && token);
assert(process.env.OPENCLAW_STATE_DIR);
const memoryDatabase = path.join(
  process.env.OPENCLAW_STATE_DIR,
  "agents",
  "main",
  "agent",
  "openclaw-agent.sqlite",
);
assert.equal(config.skills?.load?.watch, false, "Skills observation requires prepared startup");
const startedAt = Date.now();
const observationBudgetMs = 120_000;
const deadline = startedAt + observationBudgetMs;
const evidence = {
  config: [],
  skills: [],
  memory: [],
  observationsPassed: false,
  socketClosed: false,
  activeLabel: "connect",
  activeStage: "opening",
  failureStage: null,
  lastConfigAttempt: null,
  lastSkillAttempt: null,
  lastMemoryAttempt: null,
  primedAgents: [],
  reloadTail: [],
};
const scanner = createConfigReloadLogScanner(gatewayLog);
const WebSocket = createRequire(path.join(packageRoot, "package.json"))("ws");
const socket = new WebSocket("ws://127.0.0.1:18789");

function remainingMs(limit = 30_000) {
  const remaining = deadline - Date.now();
  assert(remaining > 0, "post-upgrade observation exceeded its two-minute budget");
  return Math.min(limit, remaining);
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
  const waitBudgetMs = remainingMs(observationBudgetMs);
  const attempt = { label, waitBudgetMs, eventElapsedMs: null, elapsedMs: 0 };
  evidence.lastSkillAttempt = attempt;
  // Settle the event before reading inventory: a fresh read alone could hide a broken watcher.
  const observed = onceFrame(
    socket,
    (frame) =>
      frame.type === "event" &&
      frame.event === "skills.changed" &&
      frame.payload?.reason === "watch",
    waitBudgetMs,
  ).then(
    (frame) => {
      attempt.eventElapsedMs = Date.now() - mutationStartedAt;
      return frame;
    },
    () => null,
  );
  await mutate();
  evidence.activeStage = "skills-observe";
  const event = await observed;
  attempt.elapsedMs = Date.now() - mutationStartedAt;
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

function readMemorySnapshot() {
  const db = new DatabaseSync(memoryDatabase, { readOnly: true, timeout: 0 });
  try {
    db.exec("BEGIN");
    const chunks = db
      .prepare(
        "SELECT id, text FROM memory_index_chunks WHERE path = ? AND source = 'memory' ORDER BY id",
      )
      .all(memoryRelativePath);
    const ftsRows = db
      .prepare(
        "SELECT id, text FROM memory_index_chunks_fts WHERE path = ? AND source = 'memory' ORDER BY id",
      )
      .all(memoryRelativePath);
    const match = db.prepare(
      "SELECT id, text FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? AND path = ? AND source = 'memory' ORDER BY id",
    );
    return {
      chunks,
      ftsRows,
      matches: memoryTokens.map((marker) => match.all(marker, memoryRelativePath)),
    };
  } finally {
    db.close();
  }
}

async function observeMemory(label, markerIndex) {
  evidence.activeLabel = `memory-${label}`;
  evidence.activeStage = "memory-durable-observe";
  const began = Date.now();
  while (true) {
    remainingMs();
    let snapshot;
    try {
      snapshot = readMemorySnapshot();
    } catch (error) {
      if (error.code !== "ERR_SQLITE_ERROR" || ![5, 6].includes(error.errcode)) {
        throw error;
      }
      await sleep(Math.min(100, remainingMs()));
      continue;
    }
    const expected = markerIndex === undefined ? undefined : memoryTokens[markerIndex];
    const matches = expected === undefined ? [] : snapshot.matches[markerIndex];
    const priorAbsent = snapshot.matches.every(
      (rows, index) => index === markerIndex || rows.length === 0,
    );
    const chunksMatch =
      expected === undefined
        ? snapshot.chunks.length === 0
        : snapshot.chunks.length === 1 && snapshot.chunks[0].text === expected;
    const ftsMatch =
      expected === undefined
        ? snapshot.ftsRows.length === 0
        : matches.length === 1 &&
          snapshot.ftsRows.length === 1 &&
          matches[0].id === snapshot.chunks[0]?.id &&
          matches[0].text === snapshot.chunks[0]?.text &&
          snapshot.ftsRows[0].id === matches[0].id &&
          snapshot.ftsRows[0].text === matches[0].text;
    evidence.lastMemoryAttempt = {
      label,
      elapsedMs: Date.now() - began,
      chunks: snapshot.chunks.length,
      ftsRows: snapshot.ftsRows.length,
      tokenMatches: snapshot.matches.map((rows) => rows.length),
      chunksMatch,
      ftsMatch,
      priorAbsent,
    };
    if (chunksMatch && ftsMatch && priorAbsent) {
      evidence.memory.push(evidence.lastMemoryAttempt);
      return;
    }
    await sleep(Math.min(100, remainingMs()));
  }
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
    scopes: ["operator.read", "operator.write"],
    caps: ["agent-kind"],
    auth: { token },
  });

  evidence.activeLabel = "skills-prime";
  evidence.activeStage = "skills-inventory";
  const agents = await request("agents.list");
  assert(agents.agents.some((agent) => agent.id === "main"));
  for (const agent of agents.agents) {
    const initial = await request("skills.status", { agentId: agent.id });
    assert(!initial.skills.some((entry) => entry.name === skillName));
    evidence.primedAgents.push(agent.id);
  }

  evidence.activeLabel = "root-write";
  evidence.activeStage = "prepare-config";
  await writeJson(includePath, { seamColor: "#112233" });
  config.gateway.reload = { ...config.gateway.reload, mode: "hybrid" };
  config.skills.load.watch = true;
  config.ui = { ...config.ui, $include: `./${path.basename(includePath)}` };
  delete config.ui.seamColor;
  config.ui.prefs = { ...config.ui.prefs, locale: "en" };
  await observeConfig(
    "root-write",
    "gateway.reload.mode",
    () => writeJson(configPath, config),
    (current) =>
      current.gateway.reload.mode === "hybrid" &&
      current.skills.load.watch === true &&
      current.ui.seamColor === "#112233",
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
  evidence.activeLabel = "memory-initialize";
  evidence.activeStage = "memory-tool-rpc";
  const invoked = await request("tools.invoke", {
    name: "memory_search",
    agentId: "main",
    sessionKey: "main",
    args: { query: memoryTokens[0], corpus: "memory", minScore: 0 },
  });
  assert.equal(invoked.ok, true, "Memory initialization tool failed");
  assert.equal(invoked.toolName, "memory_search");
  const memoryResult = invoked.output?.details;
  assert.equal(memoryResult?.provider, "none");
  for (const key of ["unavailable", "disabled", "partial", "stale"]) {
    assert(!memoryResult[key], `Memory initialization returned ${key}`);
  }
  assert(
    memoryResult.results.some(
      (entry) => entry.path === memoryRelativePath && entry.snippet.includes(memoryTokens[0]),
    ),
    "Memory initialization did not return the seeded note",
  );
  await observeMemory("seed", 0);
  // Sequential durable states prove automatic convergence, not a drained OS event queue.
  for (const [index, label] of [
    [1, "warmup"],
    [2, "edit"],
  ]) {
    evidence.activeLabel = `memory-${label}`;
    evidence.activeStage = "memory-write";
    await fs.writeFile(memoryPath, memoryTokens[index]);
    await observeMemory(label, index);
  }
  evidence.activeLabel = "memory-delete";
  evidence.activeStage = "memory-remove";
  await fs.rm(memoryPath);
  await observeMemory("delete");
  console.log(
    `Published-upgrade Memory automatic convergence passed: ${JSON.stringify(evidence.memory)}`,
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
