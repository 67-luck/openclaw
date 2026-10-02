import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "../../infra/runtime-worker-generation.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { openSqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type { FixtureOperations } from "../../infra/sqlite-worker-store.test-support.js";
import * as transportOwner from "../../infra/sqlite-worker-transport.js";
import { getTrackedWorkerCpuSources } from "../../infra/worker-cpu.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { retainGatewaySessionBroker } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";

export async function withMixedSessionOwners(
  first: "durable" | "Gateway" | "completed updater",
  run: (fixture: {
    durable: SessionManager;
    manager: SessionManager;
    target: Parameters<typeof SessionManager.open>[0] & { env: NodeJS.ProcessEnv };
    scope: { agentId: string; sessionKey: string; storePath: string };
    hostPosts: Array<{
      id: number;
      actor: number;
      type: SqliteWorkerRequest["type"];
      databasePath?: string;
      atNs: bigint;
    }>;
    nativePosts: Array<{ id: number; actor: number; atNs: bigint }>;
    readEntry(this: void): ReturnType<typeof readExactSessionEntryRow>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pairs: ReturnType<typeof transportOwner.createSqliteWorkerTransport>[] = [];
    const hostPosts: Parameters<typeof run>[0]["hostPosts"] = [];
    const nativePosts: Parameters<typeof run>[0]["nativePosts"] = [];
    let databasePath: string | undefined;
    let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
    const create = transportOwner.createSqliteWorkerTransport;
    const transports = vi
      .spyOn(transportOwner, "createSqliteWorkerTransport")
      .mockImplementation((options) => {
        const pair = create({
          ...options,
          posted(id, actor, atNs) {
            nativePosts.push({ id, actor, atNs });
            options.posted(id, actor, atNs);
          },
        });
        pairs.push(pair);
        return {
          ...pair,
          post(request, transfers) {
            hostPosts.push({
              id: request.id,
              actor: request.actor,
              type: request.type,
              ...(request.type === "open" ? { databasePath: request.databasePath } : {}),
              atNs: process.hrtime.bigint(),
            });
            pair.post(request, transfers);
          },
        };
      });
    try {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      databasePath = database.path;
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:carrier-patch",
      };
      const durable = SessionManager.open(
        { ...scope, sessionId: "carrier-durable" },
        state.workspaceDir,
      );
      durable.appendMessage({ role: "user", content: "durable opening", timestamp: 1 });
      const append = () =>
        durable.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "retained durable runtime" }],
          }),
        );
      if (first === "completed updater") {
        const moduleUrl = new URL(
          "../../infra/sqlite-worker-store.test-support.ts",
          import.meta.url,
        );
        const retained = pathToFileURL(
          await state.writeText(
            "retained-carrier.mts",
            `export * from ${JSON.stringify(moduleUrl.href)};\n`,
          ),
        );
        const before = getTrackedWorkerCpuSources().workers;
        let released = false;
        await withRuntimeWorkerGeneration(
          async (bind) => {
            bind((url) => (url.href === moduleUrl.href ? retained : url));
            const store = await openSqliteWorkerStore<FixtureOperations>({
              ...captureRuntimeWorkerSource(moduleUrl),
              databasePath: state.path("retained.sqlite"),
              input: undefined,
            });
            await store.execute({ type: "append", input: { value: "retained update" } });
            expect(getTrackedWorkerCpuSources().workers).toHaveLength(before.length + 1);
            expect(pairs).toHaveLength(0);
          },
          async () => {
            expect(getTrackedWorkerCpuSources().workers).toEqual(before);
            released = true;
          },
        );
        expect(released).toBe(true);
      }
      if (first === "durable") {
        await append();
      }
      broker = retainGatewaySessionBroker();
      await broker.ready;
      if (first !== "durable") {
        await append();
      }
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:incognito-carrier",
        sessionId: "carrier-incognito",
        env: state.env,
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      };
      const manager = SessionManager.open(target, state.workspaceDir);
      manager.appendMessage({ role: "user", content: "only B", timestamp: 2 });
      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.worker.threadId).not.toBe(-1);
      await run({
        durable,
        manager,
        target,
        scope,
        hostPosts,
        nativePosts,
        readEntry: () => readExactSessionEntryRow(database, scope.sessionKey),
      });
      expect(pairs).toHaveLength(1);
    } finally {
      try {
        if (databasePath) {
          await closeOpenClawAgentDatabaseByPathAsync(databasePath);
        }
      } finally {
        try {
          await broker?.stop();
        } finally {
          transports.mockRestore();
        }
      }
    }
    expect(pairs.every((pair) => pair.worker.threadId === -1)).toBe(true);
  });
}
