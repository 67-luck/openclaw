import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  logSqliteReclamationWorkerOutcome,
  SqliteReclamationInputsChangedError,
} from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn() }));
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([
  {
    kind: "superseded",
    elapsedMs: 999,
    level: "debug",
    message: "SQLite reclamation Worker superseded by newer inputs",
  },
  {
    kind: "superseded",
    elapsedMs: 1_000,
    level: "warn",
    message: "slow SQLite reclamation Worker operation",
  },
  { kind: "failure", elapsedMs: 999, level: "warn", message: "SQLite reclamation Worker failed" },
  {
    kind: "failure",
    elapsedMs: 1_000,
    level: "warn",
    message: "slow SQLite reclamation Worker operation",
  },
] as const)("logs $kind at $elapsedMs ms as $level", ({ kind, elapsedMs, level, message }) => {
  vi.spyOn(performance, "now").mockReturnValue(elapsedMs);
  // Matching text/name must not turn an ordinary failure into a typed supersession.
  const failure =
    kind === "superseded"
      ? new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance inputs changed before commit",
        )
      : Object.assign(new Error("SQLite automatic maintenance inputs changed before commit"), {
          name: "SqliteReclamationInputsChangedError",
        });
  logSqliteReclamationWorkerOutcome({
    startedAt: 0,
    outcome: "rejected",
    kind: "maintenance-plan",
    failure,
  });
  expect(log[level]).toHaveBeenCalledExactlyOnceWith(
    message,
    expect.objectContaining({ elapsedMs, outcome: "rejected" }),
  );
  expect(log[level === "debug" ? "warn" : "debug"]).not.toHaveBeenCalled();
});
