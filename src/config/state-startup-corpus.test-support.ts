import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureDiagnostics } from "../../test/helpers/fixture-diagnostics.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { stateStartupCorpusTestFiles } from "../../test/vitest/vitest.startup-corpus-paths.mjs";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../agents/test-helpers/agent-message-fixtures.js";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { applyLegacyCompatibilityStep } from "../commands/doctor/shared/config-flow-steps.js";
import { normalizeCompatibilityConfigValues } from "../commands/doctor/shared/legacy-config-core-migrate.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { loadGatewayStartupConfigSnapshot } from "../gateway/server-startup-config-helpers.js";
import { runStartupSessionMigration } from "../gateway/server-startup-session-migration.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import type { ToolResultMessage } from "../llm/types.js";
import { resolveBundledDirFromPackageRoot } from "../plugins/bundled-dir.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getUserPreferences } from "../state/user-preferences.js";
import {
  listConfigCorpusFixtureNames,
  readConfigCorpusFixture,
} from "./config-corpus.test-support.js";
import { createConfigIO } from "./io.js";
import {
  readRecentUserAssistantTextForSession,
  resolveDefaultSessionStorePath,
} from "./sessions.js";
import { loadSessionEntryReadOnly } from "./sessions/session-accessor.js";
import {
  loadTranscriptReadSnapshotSync,
  readTranscriptEventRows,
} from "./sessions/session-accessor.sqlite-read.js";
import { readActiveTranscriptEntryAnchor } from "./sessions/session-accessor.sqlite-transcript-anchor.js";

const bundledPluginsDir = resolveBundledDirFromPackageRoot(
  fileURLToPath(new URL("../../", import.meta.url)),
);
if (!bundledPluginsDir) {
  throw new Error("Missing bundled plugin fixtures for startup corpus");
}

type StateFixture = {
  release: string;
  sessions: Array<{
    agentId: string;
    sessionKey: string;
    sessionId: string;
    transcriptText: string;
  }>;
  profiles: Record<string, Record<string, unknown>>;
  cronJob: {
    id: string;
    name: string;
    enabled: false;
    schedule: { kind: "every"; everyMs: number };
    sessionTarget: "main";
    wakeMode: "next-heartbeat";
    payload: { kind: "systemEvent"; text: string };
  };
  cronStorePath: string;
  controlUi: { userId: string; settings: Record<string, unknown> };
};

const corpusDir = fileURLToPath(new URL("../../test/fixtures/state-corpus/", import.meta.url));
const releases = fs
  .readdirSync(corpusDir)
  .filter((name) => fs.statSync(path.join(corpusDir, name)).isDirectory())
  .toSorted();
const configNames = listConfigCorpusFixtureNames();
const allCases = releases.flatMap((release) =>
  configNames.map((configName) => [release, configName] as const),
);

function prepareState(home: string, release: string, configName: string) {
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.cpSync(path.join(corpusDir, release, "state"), stateDir, { recursive: true });
  const fixture: StateFixture = JSON.parse(
    fs.readFileSync(path.join(corpusDir, release, "manifest.json"), "utf8"),
  );
  const pluginDir = path.join(home, "external-plugin");
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture-extension",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { apiKey: { type: "string" } },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.ts"),
    'export default { id: "fixture-extension", register() {} };\n',
  );
  const config: unknown = JSON.parse(readConfigCorpusFixture(configName), (_key, value: unknown) =>
    typeof value === "string" && value.startsWith("/home/fixture/")
      ? path.join(home, value.slice("/home/fixture/".length))
      : value,
  );
  fs.writeFileSync(configPath, JSON.stringify(config));
  return {
    home,
    stateDir,
    configPath,
    fixture,
    env: {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_TEST_HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    },
  };
}

function assertDatabaseIntegrity(stateDir: string, fixture: StateFixture) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const databases = [
    { path: resolveOpenClawStateSqlitePath(env), version: OPENCLAW_STATE_SCHEMA_VERSION },
    ...[...new Set(fixture.sessions.map((session) => session.agentId))].map((agentId) => ({
      path: resolveOpenClawAgentSqlitePath({ agentId, env }),
      version: OPENCLAW_AGENT_SCHEMA_VERSION,
    })),
  ];
  for (const target of databases) {
    const label = path.relative(stateDir, target.path).split(path.sep).join("/");
    try {
      const database = openNodeSqliteDatabase(target.path, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA integrity_check").all(), label).toEqual([
          { integrity_check: "ok" },
        ]);
        expect(database.prepare("PRAGMA user_version").get(), label).toEqual({
          user_version: target.version,
        });
      } finally {
        database.close();
      }
    } catch (error) {
      throw new Error("Corpus database integrity failed: " + label, { cause: error });
    }
  }
}

async function assertReleasedTranscriptAppendReplay(params: {
  home: string;
  stateDir: string;
  session: StateFixture["sessions"][number];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  lifetime: ReturnType<typeof createFixtureLifetime>;
  phase: (name: string) => void;
}) {
  const { home, stateDir, session, env, signal, lifetime, phase } = params;
  const target = {
    agentId: session.agentId,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    storePath: resolveDefaultSessionStorePath(session.agentId),
    env,
  };
  const workspace = path.join(home, "workspaces", session.agentId);
  const readRows = () =>
    readTranscriptEventRows(
      openOpenClawAgentDatabase({ agentId: session.agentId, env }),
      session.sessionId,
    );
  const publications: SessionTranscriptUpdate[] = [];
  const unsubscribe = onSessionTranscriptUpdate((update) => {
    if (
      update.target.agentId === session.agentId &&
      update.target.sessionKey === session.sessionKey &&
      update.target.sessionId === session.sessionId
    ) {
      publications.push(update);
    }
  });
  try {
    phase("released-transcript-open");
    const manager = await SessionManager.openAsync(target, workspace, undefined, signal);
    phase("released-transcript-append");
    const releasedUser = expectDefined(
      manager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "user"),
      "released user message",
    );
    expect(releasedUser).toMatchObject({
      message: { role: "user", content: [{ type: "text", text: session.transcriptText }] },
    });
    const releasedRows = readRows();
    const releasedAnchor = expectDefined(
      readActiveTranscriptEntryAnchor({ ...target, entryId: releasedUser.id }),
      "released user transcript anchor",
    );
    expect(manager.getAppendParentId()).toBe(releasedUser.id);
    const other = await SessionManager.openAsync(target, workspace, undefined, signal);
    signal.throwIfAborted();
    const metadataId = await other.appendModelChange("openai", "gpt-5.5");
    signal.throwIfAborted();
    // Keep this manager's original watermark; only the native append may adopt
    // the compatible metadata tail, never an explicit pre-append reload.
    expect(manager.getAppendParentId()).toBe(releasedUser.id);
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "released-call", name: "read", arguments: {} }],
      stopReason: "toolUse",
    });
    const assistant = await manager.appendMessageWithTranscriptAnchorAsync(assistantMessage);
    signal.throwIfAborted();
    const assistantAnchor = expectDefined(
      assistant.anchor,
      "committed assistant transcript anchor",
    );
    expect(assistant.appended).toBe(true);
    expect(assistant.message).toEqual(assistantMessage);
    expect(assistantAnchor).toMatchObject({
      entryId: assistant.entryId,
      effectiveParentId: metadataId,
    });
    expect(readActiveTranscriptEntryAnchor({ ...target, entryId: assistant.entryId })).toEqual(
      assistantAnchor,
    );
    const assistantRow = JSON.parse(
      expectDefined(
        readRows().find((row) => row.seq === assistantAnchor.rawSeq),
        "committed assistant raw transcript row",
      ).eventJson,
    );
    expect(assistantRow).toMatchObject({ id: assistant.entryId, parentId: metadataId });
    expect(assistantRow.message).toEqual(assistantMessage);
    const resultMessage = {
      role: "toolResult",
      toolCallId: "released-call",
      toolName: "read",
      content: [{ type: "text", text: "released-state result" }],
      isError: false,
      timestamp: 0,
      idempotencyKey: "released-state:tool-result",
    } satisfies ToolResultMessage & { idempotencyKey: string };
    const result = await manager.appendMessageWithTranscriptAnchorAsync(resultMessage);
    signal.throwIfAborted();
    const resultAnchor = expectDefined(result.anchor, "committed keyed result transcript anchor");
    expect(result.appended).toBe(true);
    expect(result.message).toEqual(resultMessage);
    expect(resultAnchor).toMatchObject({
      entryId: result.entryId,
      effectiveParentId: assistant.entryId,
      idempotencyKey: resultMessage.idempotencyKey,
    });
    expect(readActiveTranscriptEntryAnchor({ ...target, entryId: result.entryId })).toEqual(
      resultAnchor,
    );
    const committedRows = readRows();
    expect(committedRows).toHaveLength(releasedRows.length + 3);
    expect(committedRows.slice(0, releasedRows.length)).toEqual(releasedRows);
    const resultRow = JSON.parse(
      expectDefined(
        committedRows.find((row) => row.seq === resultAnchor.rawSeq),
        "committed keyed result raw transcript row",
      ).eventJson,
    );
    expect(resultRow).toMatchObject({ id: result.entryId, parentId: assistant.entryId });
    expect(resultRow.message).toEqual(resultMessage);

    phase("released-transcript-drain");
    await lifetime.verifyCleanup(() => closeOpenClawAgentDatabasesAsync(stateDir));
    phase("released-transcript-replay");
    const reopened = await SessionManager.openAsync(target, workspace, undefined, signal);
    signal.throwIfAborted();
    const replayCursors = [reopened.getLeafId(), reopened.getAppendParentId()];
    const replayView = structuredClone(reopened.getEntries());
    const replayVersion = loadTranscriptReadSnapshotSync(target).version;
    const replayPublications = [...publications];
    const replay = await reopened.appendMessageWithTranscriptAnchorAsync(resultMessage);
    signal.throwIfAborted();
    expect(replay).toMatchObject({
      entryId: result.entryId,
      message: resultMessage,
      anchor: resultAnchor,
      lifecycleRevision: result.lifecycleRevision,
      appended: false,
    });
    expect([reopened.getLeafId(), reopened.getAppendParentId()]).toEqual(replayCursors);
    expect(reopened.getEntries()).toEqual(replayView);
    expect(loadTranscriptReadSnapshotSync(target).version).toEqual(replayVersion);
    expect(readActiveTranscriptEntryAnchor({ ...target, entryId: result.entryId })).toEqual(
      resultAnchor,
    );
    expect(readRows()).toEqual(committedRows);
    expect(publications).toEqual(replayPublications);

    phase("released-transcript-conflict");
    const newerWriter = await SessionManager.openAsync(target, workspace, undefined, signal);
    signal.throwIfAborted();
    const newerUser = await newerWriter.appendMessageWithTranscriptAnchorAsync(
      makeAgentUserMessage({ content: [{ type: "text", text: "a newer user turn" }] }),
    );
    signal.throwIfAborted();
    expect(newerUser.appended).toBe(true);
    const newerUserAnchor = expectDefined(newerUser.anchor, "newer user transcript anchor");
    const beforeRefusal = readRows();
    expect(beforeRefusal).toHaveLength(committedRows.length + 1);
    const versionBeforeRefusal = loadTranscriptReadSnapshotSync(target).version;
    const identityBeforeRefusal = loadSessionEntryReadOnly(target);
    const publicationsBeforeRefusal = [...publications];
    const staleCursors = [reopened.getLeafId(), reopened.getAppendParentId()];
    const staleView = structuredClone(reopened.getEntries());
    await expect(
      reopened.appendMessageWithTranscriptAnchorAsync(assistantMessage),
    ).rejects.toMatchObject({
      name: "SqliteTranscriptMutationConflictError",
      message: `SQLite transcript changed while preparing rewrite for ${session.sessionId}`,
    });
    signal.throwIfAborted();
    expect(readRows()).toEqual(beforeRefusal);
    expect(loadTranscriptReadSnapshotSync(target).version).toEqual(versionBeforeRefusal);
    expect(loadSessionEntryReadOnly(target)).toEqual(identityBeforeRefusal);
    for (const anchor of [releasedAnchor, assistantAnchor, resultAnchor, newerUserAnchor]) {
      expect(readActiveTranscriptEntryAnchor({ ...target, entryId: anchor.entryId })).toEqual(
        anchor,
      );
    }
    expect([reopened.getLeafId(), reopened.getAppendParentId()]).toEqual(staleCursors);
    expect(reopened.getEntries()).toEqual(staleView);
    expect(publications).toEqual(publicationsBeforeRefusal);

    phase("released-transcript-final-drain");
    await lifetime.verifyCleanup(() => closeOpenClawAgentDatabasesAsync(stateDir));
    phase("released-transcript-final-read");
    const finalReader = await SessionManager.openAsync(target, workspace, undefined, signal);
    signal.throwIfAborted();
    expect(finalReader.getBranch()).toContainEqual(releasedUser);
    expect(finalReader.getBranch().filter((entry) => entry.id === result.entryId)).toHaveLength(1);
    expect(finalReader.getLeafId()).toBe(newerUser.entryId);
    expect(finalReader.getAppendParentId()).toBe(newerUser.entryId);
    expect(readRows()).toEqual(beforeRefusal);
    expect(beforeRefusal.slice(0, releasedRows.length)).toEqual(releasedRows);
  } finally {
    unsubscribe();
  }
}

export function createStateStartupCorpusFixture() {
  const lifetime = createFixtureLifetime();
  const originalEnv = new Map<string, string | undefined>();
  let cleanupReceipt: Promise<void> | undefined;
  const corpusFixture = {
    runCase(release: string, configName: string, signal: AbortSignal): Promise<void> {
      if (cleanupReceipt) {
        return cleanupReceipt.then(() => corpusFixture.runCase(release, configName, signal));
      }
      return lifetime.run(async () => {
        signal.throwIfAborted();
        const home = lifetime.createTempDir("openclaw-state-corpus-");
        const stateDir = path.join(home, ".openclaw");
        const scope = createSqliteReadOnlyWorkerScope({ signal, deadlineOwnedByCaller: false });
        const diagnostics = createFixtureDiagnostics("state-startup-corpus");
        const onAbort = () => diagnostics.report("abort");
        signal.addEventListener("abort", onAbort, { once: true });
        const phase = (name: string) => {
          signal.throwIfAborted();
          diagnostics.stage(name);
        };
        const errors: unknown[] = [];
        try {
          await scope.run(async () => {
            const { configPath, fixture, env } = prepareState(home, release, configName);
            // Vitest may start teardown before this timed-out body settles. The fixture
            // owns these values until database and worker cleanup have both joined.
            for (const [key, value] of Object.entries(env)) {
              if (!originalEnv.has(key)) {
                originalEnv.set(key, process.env[key]);
              }
              process.env[key] = value;
            }
            const io = createConfigIO({
              configPath,
              env: process.env,
              homedir: () => home,
              observe: false,
            });
            phase("config-read");
            const snapshot = await io.readConfigFileSnapshot();
            phase("config-migration");
            const migrated = applyLegacyCompatibilityStep({
              snapshot,
              state: {
                cfg: snapshot.sourceConfig,
                candidate: snapshot.sourceConfig,
                pendingChanges: false,
                fixHints: [],
              },
              shouldRepair: true,
              doctorFixCommand: "openclaw doctor --fix",
            });
            const normalized = normalizeCompatibilityConfigValues(migrated.state.candidate, {
              sourceRaw: snapshot.parsed,
              sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
            });
            fs.writeFileSync(configPath, JSON.stringify(normalized.config));
            // Repeat the real repair path: a second run must preserve the same records.
            for (let pass = 0; pass < 2; pass += 1) {
              phase("doctor-repair");
              await runDoctorConfigPreflight({
                observe: false,
                repairPrefixedConfig: true,
                doctorOnlyStateMigrations: true,
                preparePluginMetadataSnapshot: true,
              });
              phase("startup-config-read");
              const initialSnapshotRead = await io.readConfigFileSnapshotWithPluginMetadata();
              phase("startup-config");
              const startup = await loadGatewayStartupConfigSnapshot({
                initialSnapshotRead,
                minimalTestGateway: false,
                ambientEnvTriggers: "suppress",
                log: console,
              });
              const config = startup.snapshot.config;
              phase("startup-session-migration");
              await runStartupSessionMigration({ cfg: config, log: console });
              phase("state-assertions");
              for (const session of fixture.sessions) {
                signal.throwIfAborted();
                const target = {
                  agentId: session.agentId,
                  sessionKey: session.sessionKey,
                  storePath: resolveDefaultSessionStorePath(session.agentId),
                };
                expect(loadSessionEntryReadOnly(target), session.sessionKey).toMatchObject({
                  sessionId: session.sessionId,
                });
                expect(
                  await readRecentUserAssistantTextForSession(target),
                  session.sessionKey,
                ).toContainEqual(expect.objectContaining({ text: session.transcriptText }));
              }
              signal.throwIfAborted();
              const auth = loadAuthProfileStoreWithoutExternalProfiles(
                path.join(stateDir, "agents", "main", "agent"),
              );
              for (const [profileId, credential] of Object.entries(fixture.profiles)) {
                expect(auth.profiles[profileId], profileId).toMatchObject(credential);
              }
              const cronPath = resolveCronJobsStorePathFromConfig(config);
              expect(cronPath).toBe(fixture.cronStorePath);
              const cron = await loadCronJobsStore(cronPath);
              signal.throwIfAborted();
              expect(cron.jobs.find((job) => job.id === fixture.cronJob.id)).toMatchObject(
                fixture.cronJob,
              );
              expect(getUserPreferences(fixture.controlUi.userId)).toMatchObject(
                fixture.controlUi.settings,
              );
              phase("model-inspection");
              for (const agentId of listAgentIds(config)) {
                signal.throwIfAborted();
                const lease = await acquireReadOnlyPreparedModelRuntime(
                  {
                    config,
                    agentId,
                    agentDir: path.join(stateDir, "agents", agentId, "agent"),
                    workspaceDir: path.join(home, "workspaces", agentId),
                    env: process.env,
                    readOnly: true,
                    skipCredentials: true,
                  },
                  {
                    catalogMode: "static",
                    pluginMetadataSnapshot: startup.pluginMetadataSnapshot,
                  },
                );
                const leaseErrors: unknown[] = [];
                try {
                  signal.throwIfAborted();
                  if (configName === "generic-github-token.json") {
                    expect(lease.snapshot.modelCatalog.entries).toEqual([]);
                  } else {
                    expect(lease.snapshot.modelCatalog.entries.length).toBeGreaterThan(0);
                  }
                } catch (error) {
                  leaseErrors.push(error);
                }
                try {
                  await lifetime.verifyCleanup(() => lease[Symbol.asyncDispose]());
                } catch (error) {
                  leaseErrors.push(error);
                }
                if (leaseErrors.length === 1) {
                  throw leaseErrors[0];
                }
                if (leaseErrors.length > 1) {
                  throw new AggregateError(leaseErrors, "Model inspection and cleanup failed");
                }
              }
              phase("database-close");
              await lifetime.verifyCleanup(() => closeOpenClawAgentDatabasesAsync(stateDir));
              await lifetime.verifyCleanup(() => closeOpenClawStateDatabaseAsync());
              phase("database-integrity");
              assertDatabaseIntegrity(stateDir, fixture);
            }
            if (release === "2026.9.2" && configName === "api-key-no-models.json") {
              await assertReleasedTranscriptAppendReplay({
                home,
                stateDir,
                session: expectDefined(fixture.sessions[0], "selected released session"),
                env: { ...process.env },
                signal,
                lifetime,
                phase,
              });
            }
          });
        } catch (error) {
          diagnostics.report(signal.aborted ? "abort" : "failure");
          errors.push(error);
        }
        for (const [stage, close] of [
          ["agent-database-close", () => closeOpenClawAgentDatabasesAsync(stateDir)],
          ["state-database-close", () => closeOpenClawStateDatabaseAsync()],
          ["sqlite-worker-scope-close", () => scope.close()],
        ] as const) {
          diagnostics.stage(stage);
          try {
            await lifetime.verifyCleanup(close);
          } catch (error) {
            diagnostics.report(signal.aborted ? "abort" : "failure");
            errors.push(error);
          }
        }
        signal.removeEventListener("abort", onAbort);
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Startup corpus fixture and cleanup failed");
        }
      });
    },
    cleanup(): Promise<void> {
      // A rejected drain abandons its local handles, not its ownership evidence.
      // Retain that receipt so another hook or case cannot certify the lost join.
      return (cleanupReceipt ??= lifetime.cleanup().then(() => {
        for (const [key, value] of originalEnv) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        originalEnv.clear();
        cleanupReceipt = undefined;
      }));
    },
  };
  return corpusFixture;
}

export function defineStateStartupCorpusTests(fileUrl: string) {
  const file = path
    .relative(fileURLToPath(new URL("../../", import.meta.url)), fileURLToPath(fileUrl))
    .split(path.sep)
    .join("/");
  const partition = stateStartupCorpusTestFiles.indexOf(file);
  if (partition < 0) {
    throw new Error(`Unregistered startup corpus file: ${file}`);
  }
  const cases = allCases.filter(
    (_entry, index) => index % stateStartupCorpusTestFiles.length === partition,
  );
  const fixture = createStateStartupCorpusFixture();
  afterEach(() => fixture.cleanup());

  describe("prior-release state startup corpus", () => {
    if (partition === 0) {
      it("retains the previous stable and frozen fleet releases", () => {
        expect(releases).toEqual(expect.arrayContaining(["2026.9.2", "2026.9.3-95f3ed9"]));
      });
    }

    // These released snapshots retain POSIX cron partition keys, not Windows-native paths.
    it.skipIf(process.platform === "win32").for(cases)(
      "%s × %s preserves state through Doctor and Gateway startup",
      { timeout: 120_000 },
      ([release, configName], { signal }) => fixture.runCase(release, configName, signal),
    );
  });
}
