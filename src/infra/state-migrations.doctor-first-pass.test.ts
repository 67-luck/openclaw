import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { loadAndMaybeMigrateDoctorConfig } from "../commands/doctor-config-flow.js";
import { prepareDoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
// Only presentation and the stopped fixture Gateway are mocked; migrations and repairs are real.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: async () => {
    throw new Error("Fixture Gateway is offline");
  },
}));
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

const fixtures = createFixtureLifetime();
afterAll(() => fixtures.cleanup());

function seedHistoricalSharedDatabase(pathname: string, stamped: boolean): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const database = new DatabaseSync(pathname);
  try {
    // Exact schema and metadata written by v2026.7.35, before deletion history existed.
    database.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-state-schema-v1.sql", import.meta.url),
        "utf8",
      ),
    );
    database.exec("PRAGMA user_version = 1;");
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, ?, 1, 1)")
      .run(stamped ? "2026.7.1" : null);
  } finally {
    database.close();
  }
}

function seedHistoricalAgentDatabase(pathname: string, agentId: string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const database = new DatabaseSync(pathname);
  try {
    // Exact schema bytes from v2026.7.35, whose agent databases used user_version=1.
    database.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v1.sql", import.meta.url),
        "utf8",
      ),
    );
    database.exec("PRAGMA user_version = 1;");
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', 1, ?, NULL, 1, 1)")
      .run(agentId);
  } finally {
    database.close();
  }
}

function readDatabase<T>(pathname: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

it.each(["current", "historical-v1", "historical-v1-stamped"] as const)(
  "settles historical agent migration before auth and session repair with %s shared state",
  async (sharedState) => {
    const root = fs.realpathSync(fixtures.createTempDir("doctor-agent-database-order-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const sharedDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const sessionDir = path.join(root, "custom-sessions");
    const customDatabasePath = path.join(sessionDir, "openclaw-agent.sqlite");
    const agentIds = ["main", "worker"];
    const agentDatabasePaths = agentIds.map((agentId) =>
      path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
    );
    const databasePaths = [...agentDatabasePaths, customDatabasePath];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_TEST_FAST: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
      NO_COLOR: "1",
    };
    for (const key of [
      ...listKnownProviderAuthEnvVarNamesCore({ config: {}, env }),
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]) {
      env[key] = undefined;
    }
    return await withEnvAsync(env, async () => {
      if (sharedState.startsWith("historical-v1")) {
        seedHistoricalSharedDatabase(sharedDatabasePath, sharedState === "historical-v1-stamped");
      } else {
        openOpenClawStateDatabase({ env });
        closeOpenClawStateDatabaseForTest();
      }
      agentIds.forEach((agentId, index) =>
        seedHistoricalAgentDatabase(agentDatabasePaths[index]!, agentId),
      );
      // Custom session stores are inspected before repair without being registered by runtime opens.
      seedHistoricalAgentDatabase(customDatabasePath, "main");
      for (const [index, agentId] of agentIds.entries()) {
        fs.writeFileSync(
          path.join(path.dirname(agentDatabasePaths[index]!), "auth-profiles.json"),
          JSON.stringify({
            version: 1,
            profiles: {
              [`anthropic:${agentId}`]: {
                type: "api_key",
                provider: "anthropic",
                key: `synthetic-${agentId}-credential`,
              },
            },
          }),
        );
      }
      const sessionId = "historical-session";
      fs.writeFileSync(
        path.join(sessionDir, "sessions.json"),
        JSON.stringify({
          "agent:main:history": { sessionId, label: "Preserved session", updatedAt: 1000 },
        }),
      );
      fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.jsonl`),
        [
          {
            type: "session",
            id: sessionId,
            version: 3,
            timestamp: "2026-07-01T00:00:00Z",
            cwd: root,
          },
          {
            type: "message",
            id: "message-1",
            parentId: null,
            message: { role: "user", content: "Preserved history" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
        session: { store: path.join(sessionDir, "sessions.json") },
        plugins: { enabled: false },
      };
      fs.writeFileSync(configPath, JSON.stringify(cfg));
      const migrate = async () => {
        const messages: string[] = [];
        vi.mocked(note).mockImplementation((message) => {
          messages.push(String(message));
        });
        const runtime = {
          log: (...args: unknown[]) => {
            messages.push(args.map(String).join(" "));
          },
          error: (...args: unknown[]) => {
            messages.push(args.map(String).join(" "));
          },
          exit: (code: number): never => {
            throw new Error("Doctor exit " + code);
          },
        };
        const options = { repair: true, nonInteractive: true, yes: true };
        const prompter = createDoctorPrompter({ runtime, options });
        const preflight = await prepareDoctorDatabasePreflight({ cfg });
        const repaired = await loadAndMaybeMigrateDoctorConfig({
          options,
          runtime,
          prompter,
          confirm: async () => true,
          agentDatabaseMigrationDiscovery: preflight.agentDatabaseMigrationDiscovery,
        });
        const stepReceipts = [...(repaired.stateMigrationStepReceipts ?? [])];
        await noteSessionTranscriptHealth({
          cfg: repaired.cfg,
          env,
          shouldRepair: true,
          postSessionPluginMigration: repaired.postSessionPluginMigration,
          postSessionPluginMigrationPlanBound: repaired.postSessionPluginMigrationPlanBound,
          onStepReceipt: (receipt) => {
            stepReceipts.push(receipt);
          },
          onWarnings: (warnings) => {
            messages.push(...warnings);
          },
        });
        return { changes: messages, warnings: [], stepReceipts };
      };
      const first = await migrate();
      const output = [...first.changes, ...first.warnings].join("\n");
      expect(
        first.stepReceipts?.filter((step) => step.outcome === "refused"),
        output,
      ).toEqual([]);
      expect(output).not.toMatch(
        /MediaMigrationRequiredError|run openclaw doctor --fix to migrate persisted media/u,
      );
      for (const pathname of databasePaths) {
        expect(
          readDatabase(
            pathname,
            (database) => database.prepare("PRAGMA user_version").get()?.user_version,
          ),
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
      }
      const authMigration = output.indexOf("Migrated auth profile JSON");
      const sessionMigration = output.indexOf("Transcript events: imported=");
      const schemaMigration = output.lastIndexOf("Upgraded agent database schema");
      expect(schemaMigration).toBeGreaterThanOrEqual(0);
      expect(authMigration).toBeGreaterThan(schemaMigration);
      expect(sessionMigration).toBeGreaterThan(authMigration);

      const readPersistedState = () => ({
        sharedAuth: readDatabase(sharedDatabasePath, (database) =>
          JSON.parse(
            String(
              database
                .prepare(
                  "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
                )
                .get()?.value_json,
            ),
          ),
        ),
        workerAuth: readDatabase(agentDatabasePaths[1]!, (database) =>
          JSON.parse(
            String(
              database
                .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
                .get()?.store_json,
            ),
          ),
        ),
        sessions: readDatabase(customDatabasePath, (database) =>
          database
            .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key")
            .all(),
        ),
        transcript: readDatabase(
          customDatabasePath,
          (database) =>
            executeSqliteQuerySync(
              database,
              getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
                .selectFrom("transcript_events")
                .select(transcriptEventJsonSql(database).as("event_json"))
                .where("session_id", "=", sessionId)
                .orderBy("seq"),
            ).rows,
        ),
      });
      const migrated = readPersistedState();
      expect(migrated.sharedAuth.profiles["anthropic:main"]).toMatchObject({
        key: "synthetic-main-credential",
      });
      expect(migrated.workerAuth.profiles["anthropic:worker"]).toMatchObject({
        key: "synthetic-worker-credential",
      });
      expect(migrated.sessions).toContainEqual({
        session_key: "agent:main:history",
        entry_json: expect.any(String),
      });
      expect(
        JSON.parse(
          String(
            migrated.sessions.find((row) => row.session_key === "agent:main:history")?.entry_json,
          ),
        ),
      ).toMatchObject({ sessionId, label: "Preserved session" });
      expect(migrated.transcript.map((row) => JSON.parse(row.event_json))).toContainEqual(
        expect.objectContaining({ message: { role: "user", content: "Preserved history" } }),
      );

      const second = await migrate();
      const repeatedOutput = [...second.changes, ...second.warnings].join("\n");
      expect(
        second.stepReceipts?.filter((step) => step.outcome === "refused"),
        repeatedOutput,
      ).toEqual([]);
      expect(repeatedOutput).not.toMatch(
        /Upgraded agent database schema|Migrated media persistence|Migrated auth profile JSON|Transcript events: imported=[1-9]/u,
      );
      expect(readPersistedState()).toEqual(migrated);
    });
  },
);
