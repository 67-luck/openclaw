import { expect, it, vi } from "vitest";
import { bindSqliteWorkerBackend } from "../../agents/sessions/session-manager-metadata.worker.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as entryReads from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";

it.each(["row", "unencodable"] as const)(
  "encodes only canonical native entry row failures (%s)",
  async (kind) => {
    await withOpenClawTestState({ label: "readonly-native-result" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:result",
        env,
      };
      writeSessionEntry(database, scope.sessionKey, { sessionId: "result", updatedAt: 1 });
      const context = captureOpenClawStateWorkerContext({ env });
      const backend = bindSqliteWorkerBackend(undefined, {
        databasePath: database.path,
        database: database.db,
        admit() {
          throw new Error("Readonly entry attempted a write");
        },
      });
      const failure = kind === "row" ? new Error("selected row failed") : { unavailable: true };
      const read = vi.spyOn(entryReads, "readSessionEntryRow").mockImplementation(() => {
        // oxlint-disable-next-line typescript/only-throw-error -- The native row encoder must preserve raw, unencodable read failures.
        throw failure;
      });
      const execute = (expected?: { identity: string }) =>
        runWithSqliteWorkerStateContext(context, () =>
          backend.execute({
            type: "session.metadata.entryRead",
            input: {
              scope: resolveSqliteScope(scope),
              query: { kind: "resolve-result" },
              expected,
            },
          }),
        );
      try {
        expect(() => execute({ identity: "different-original-owner" })).toThrow(
          "Captured session database changed before read",
        );
        expect(read).not.toHaveBeenCalled();
        if (kind === "row") {
          expect(execute()).toMatchObject({
            ok: true,
            value: {
              result: {
                kind: "resolve-result",
                value: {
                  ok: false,
                  error: {
                    version: 1,
                    root: 0,
                    nodes: [{ name: "Error", message: "selected row failed" }],
                  },
                },
              },
            },
          });
          expect(database.db.isTransaction).toBe(false);
          expect(database.db.isOpen).toBe(true);
        } else {
          let thrown: unknown;
          try {
            execute();
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBe(failure);
        }
      } finally {
        read.mockRestore();
        await backend.close();
      }
    });
  },
);
