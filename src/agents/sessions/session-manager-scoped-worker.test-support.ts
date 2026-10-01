import fs from "node:fs";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { expect, vi } from "vitest";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { hasUnjoinedWork } from "../../../scripts/lib/managed-child-process.mts";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { retainGatewaySessionBroker } from "../../state/openclaw-agent-execution.js";
import { createNodeEvalArgs } from "../../test-utils/node-process.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

type Fixture = {
  manager: SessionManager;
  target: Parameters<typeof SessionManager.open>[0] & {
    env: OpenClawTestState["env"];
    storePath: string;
  };
  read: () => AgentMessage[];
  durable?: { agentId: string; storePath: string; sessionKey: string };
};
export function createScopedWorkerFixture(
  nativeFault: { control: SharedArrayBuffer },
  nativeFaultKey: string,
) {
  async function withReadyManager(run: (fixture: Fixture) => Promise<void>, seedDurable = false) {
    const previous = getEnvironmentData(nativeFaultKey);
    new Int32Array(nativeFault.control).fill(0);
    setEnvironmentData(nativeFaultKey, nativeFault.control);
    try {
      await withOpenClawTestState({ label: "session-scoped-worker" }, async (state) => {
        let durable: ReturnType<typeof agentDatabase.openOpenClawAgentDatabase> | undefined;
        let durableScope: Fixture["durable"];
        let broker: ReturnType<typeof retainGatewaySessionBroker> | undefined;
        try {
          if (seedDurable) {
            durable = agentDatabase.openOpenClawAgentDatabase({ agentId: "main" });
            durableScope = {
              agentId: "main",
              storePath: durable.path,
              sessionKey: "agent:main:outer-durable",
            };
            writeSessionEntry(durable, durableScope.sessionKey, {
              sessionId: "outer-durable",
              updatedAt: 1,
              label: "original A",
            });
          }
          broker = retainGatewaySessionBroker();
          await broker.ready;
          const target = {
            agentId: "main",
            sessionId: "scoped-session",
            sessionKey: "agent:main:dashboard:incognito-scoped",
            storePath: agentDatabase.resolveIncognitoOpenClawAgentSqlitePath({
              agentId: "main",
              env: state.env,
            }),
            env: state.env,
          };
          const hostOpen = vi
            .spyOn(agentDatabase, "openOpenClawAgentDatabase")
            .mockImplementation(() => {
              throw new Error("Enrolled session attempted to open agent SQLite on the host");
            });
          try {
            const manager = SessionManager.open(target, state.workspaceDir);
            manager.appendMessage({ role: "user", content: "opening turn", timestamp: 1 });
            await run({
              manager,
              target,
              read: () => SessionManager.readSessionContext(target, (messages) => [...messages]),
              durable: durableScope,
            });
            expect(hostOpen).not.toHaveBeenCalled();
            expect(fs.existsSync(target.storePath)).toBe(false);
            expect(agentDatabase.listOpenIncognitoAgentDatabases()).toEqual([]);
          } finally {
            hostOpen.mockRestore();
          }
        } finally {
          try {
            if (durable) {
              await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(durable.path);
            }
          } finally {
            await broker?.stop();
          }
        }
      });
    } finally {
      // Retried native cleanup belongs to the fixture too; keep its controller
      // until withOpenClawTestState has joined the complete resource drain.
      setEnvironmentData(nativeFaultKey, previous);
    }
  }
  return { withReadyManager };
}

export function assistant(id: string) {
  return makeAgentAssistantMessage({
    content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
}

export async function runReadyPredecessorChild(
  mode: "scope-free" | "scoped" | "queued-scoped",
  signal: AbortSignal,
) {
  const dirs = createTempDirTracker();
  const root = dirs.make("session-ready-predecessor-");
  // The regression blocks the original host thread before its finally can run.
  // Keep its workers and scratch under the existing managed child owner.
  const source = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import os from "node:os";
    import { syncBuiltinESMExports } from "node:module";
    import { setImmediate } from "node:timers/promises";
    import { deserialize } from "node:v8";
    import { Worker } from "node:worker_threads";
    os.availableParallelism = () => 1;
    syncBuiltinESMExports();
    const { SessionManager } = await import("./src/agents/sessions/session-manager.ts");
    const { withOpenClawTestState } = await import("./src/test-utils/openclaw-test-state.ts");
    const { retainGatewaySessionBroker } = await import("./src/state/openclaw-agent-execution.ts");
    const { resolveIncognitoOpenClawAgentSqlitePath } = await import("./src/state/openclaw-agent-db.ts");
    const { openVolatileAgentDatabaseSqliteWorkerStore } = await import("./src/infra/sqlite-worker-store.ts");
    const { isSqliteWorkerError } = await import("./src/infra/sqlite-worker-contract.ts");
    const mode = ${JSON.stringify(mode)};
    const post = Worker.prototype.postMessage;
    const sent = [];
    Worker.prototype.postMessage = function(message, ...rest) {
      const request = message?.kind === "request" ? message.request : undefined;
      if (request?.type === "execute") {
        const command = deserialize(request.input);
        const logical = command.type === "database.volatile.execute" ? command.input.command : command;
        const operation = logical.type === "database.domain.run" ? logical.input.command : logical;
        sent.push({
          worker: this,
          actor: request.actor,
          command: operation.type,
          admitted: Boolean(request.operationAdmission),
        });
      }
      return Reflect.apply(post, this, [message, ...rest]);
    };
    try {
      await withOpenClawTestState({ label: "ready-predecessor" }, async (state) => {
        const broker = retainGatewaySessionBroker();
        const gate = state.path("release-native-preparation");
        const marker = state.path("native-preparation-entered");
        const originals = [];
        const errors = [];
        const track = (promise) => {
          originals.push(promise.then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error }),
          ));
          return promise;
        };
        let currentStore;
        try {
          await broker.ready;
          const target = {
            agentId: "main",
            sessionId: "ready-predecessor",
            sessionKey: "agent:main:dashboard:incognito-ready-predecessor",
            storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
            env: state.env,
          };
          const manager = SessionManager.open(target, state.workspaceDir);
          manager.appendMessage({ role: "user", content: "opening turn", timestamp: 1 });
          const managerWorker = sent.at(-1)?.worker;
          assert.ok(managerWorker);
          if (mode === "queued-scoped") {
            currentStore = await openVolatileAgentDatabaseSqliteWorkerStore({
              id: "ready-predecessor-current",
              moduleUrl: new URL("./src/infra/sqlite-worker-store.test-support.ts", import.meta.url),
              input: { type: "prepare", markerPath: marker, gatePath: gate },
              assertCurrent() {},
            });
            track(currentStore.execute({ type: "append", input: { value: "current native work" } }));
            const deadline = Date.now() + 5_000;
            while (!fs.existsSync(marker)) {
              assert.ok(Date.now() < deadline, "original native preparation did not enter");
              await setImmediate();
            }
            assert.equal(sent.at(-1)?.worker, managerWorker);
          }
          sent.length = 0;
          let callbackCalls = 0;
          let nestedReads = 0;
          let appendObserved = false;
          const appending = track(manager.appendMessageAsync(
            { role: "user", content: "pending fresh input", timestamp: 2 },
            mode === "scope-free" ? undefined : {
              beforeFreshMessageCommit() {
                callbackCalls += 1;
                // The original host continuation may perform its authorized descendant read.
                SessionManager.readSessionContext(target, (messages) => {
                  nestedReads += 1;
                  assert.equal([...messages].length, 1);
                });
              },
            },
          ));
          const observer = appending.then(() => { appendObserved = true; }, () => undefined);
          let readEntered = 0;
          const beforeRead = sent.length;
          process.stdout.write("ready-predecessor:entered\n");
          if (mode === "scope-free") {
            SessionManager.readSessionContext(target, (messages) => {
              readEntered += 1;
              assert.equal([...messages].length, 2);
            });
            assert.equal(readEntered, 1);
            assert.equal(appendObserved, false);
          } else {
            let refused;
            try {
              SessionManager.readSessionContext(target, () => { readEntered += 1; });
            } catch (error) {
              refused = { error };
            }
            assert.ok(refused && isSqliteWorkerError(refused.error, "unavailable"));
            assert.equal(readEntered, 0);
            assert.equal(callbackCalls, 0);
            assert.equal(sent.length, beforeRead, "refused follower reached native dispatch");
            if (mode === "queued-scoped") {
              assert.equal(beforeRead, 0, "scoped predecessor was not queued behind current native work");
            }
          }
          fs.writeFileSync(gate, "release");
          await appending;
          await observer;
          assert.equal(callbackCalls, mode === "scope-free" ? 0 : 1);
          assert.equal(nestedReads, mode === "scope-free" ? 0 : 1);
          const appends = sent.filter(row => row.command === "session.message.append");
          assert.equal(appends.length, 1, "original append was replayed");
          assert.equal(appends[0].worker, managerWorker);
          assert.equal(appends[0].admitted, true, "native request lost its captured admission");
          SessionManager.readSessionContext(target, (messages) => {
            assert.deepEqual([...messages].map(message => message.content), [
              "opening turn", "pending fresh input",
            ]);
          });
          manager.appendMessage({ role: "user", content: "later input", timestamp: 3 });
          SessionManager.readSessionContext(target, (messages) => {
            assert.equal([...messages].length, 3);
          });
        } catch (error) {
          errors.push(error);
        } finally {
          fs.writeFileSync(gate, "release");
          for (const outcome of await Promise.all(originals)) {
            if (!outcome.ok && !errors.includes(outcome.error)) {
              errors.push(outcome.error);
            }
          }
          for (const close of [() => currentStore?.close(), () => broker.stop()]) {
            try {
              await close();
            } catch (error) {
              errors.push(error);
            }
          }
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Ready predecessor proof and cleanup failed");
        }
      });
    } finally {
      Worker.prototype.postMessage = post;
    }
    process.stdout.write("ready-predecessor:complete\n");
  `;
  const result = await runNodeScript(
    createNodeEvalArgs(source, { imports: [import.meta.resolve("tsx/esm")] }),
    { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    30_000,
    { signal, maxBuffer: 64 * 1024, requireProcessTreeExit: process.platform !== "win32" },
  );
  // A cleanup uncertainty retains the child's inputs; timeout alone does not.
  if (!hasUnjoinedWork(result.error)) {
    dirs.cleanup();
  }
  return result;
}
