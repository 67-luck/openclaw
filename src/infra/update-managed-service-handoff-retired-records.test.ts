import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: () => fixture.root }));

let store: ReturnType<typeof createManagedHandoffLeaseStore>;

function databasePath() {
  return path.join(fixture.root, "managed-update-handoffs.sqlite");
}

/** Seed a foreign row the way an older build left one behind in the shared tmp store. */
function seedRow(installRoot: string, owner: string, payload: string) {
  const db = new DatabaseSync(databasePath());
  try {
    db.prepare(
      "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run(installRoot, owner, payload, Date.now());
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-retired-")));
  fs.chmodSync(fixture.root, 0o700);
  store = createManagedHandoffLeaseStore();
  // Acquiring one lease creates the shared table every install root writes into.
  const acquired = store.acquire(path.join(fixture.root, "install"), "owner", { kind: "update" });
  expect(acquired.kind).toBe("acquired");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

it.each([3, 9])(
  "refuses unsupported v%s leases without replacing them or admitting children",
  (version) => {
    const installRoot = path.join(fixture.root, "future-install");
    const identity = store.processIdentity();
    const payload = JSON.stringify({
      version,
      helper: identity,
      executor: identity,
      action: { kind: "update" },
      nativeBorrower: {
        id: "11111111-1111-4111-8111-111111111111",
        phase: "reserved",
        source: {
          runId: "run",
          transactionId: "transaction",
          claimId: "claim",
          revision: 1,
          recordSha256: "a".repeat(64),
          serviceKey: path.join(fixture.root, "service"),
          configPaths: [path.join(fixture.root, "config.json")],
          lifetimeId: "lifetime",
        },
      },
    });
    seedRow(installRoot, "future-owner", payload);

    expect(store.read(installRoot)).toEqual({ kind: "unreadable" });
    expect(store.readLegacyParent(installRoot)).toBeNull();
    expect(() => store.acquire(installRoot, "replacement", { kind: "update" })).toThrow(
      /existing managed handoff lease is incompatible/u,
    );
    const childRoot = `${installRoot}/.openclaw-update-child-future`;
    expect(() => store.acquire(childRoot, "child", { kind: "update" })).toThrow(
      /existing managed handoff lease is incompatible/u,
    );
    expect(store.read(childRoot)).toEqual({ kind: "absent" });
    const db = new DatabaseSync(databasePath(), { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root=?")
          .get(installRoot),
      ).toEqual({
        owner: "future-owner",
        payload_json: payload,
      });
    } finally {
      db.close();
    }
  },
);
