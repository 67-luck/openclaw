import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import { captureCoordinatorDatabase } from "./sqlite-coordinator.test-support.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireGatewayMaintenanceCoordinator,
  tryCreateGatewaySchemaFenceDelegate,
  attachGatewaySchemaFenceDelegate,
  withStateSchemaFence,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function options() {
  const root = tempDirs.make("gateway-restore-fence-");
  return { databasePath: path.join(root, "db"), runtimeDirectory: root, excludeGateway: true };
}

it("refuses late foreign delegates from an earlier ordinary maintenance owner", () => {
  const params = options();
  const ordinary = acquireGatewayMaintenanceCoordinator({ ...params, excludeGateway: false });
  const exclusion = acquireGatewayMaintenanceCoordinator(params);
  try {
    expect(() =>
      ordinary.createSchemaFenceDelegate({ ...params, actorId: "late" })?.release(),
    ).toThrow("gateway-lifecycle");
    expect(
      tryCreateGatewaySchemaFenceDelegate({ ...params, actorId: "late-gateway" }),
    ).toBeUndefined();
    exclusion.release();
    const delegate = ordinary.createSchemaFenceDelegate({ ...params, actorId: "after" });
    expect(delegate).toBeDefined();
    delegate?.release();
  } finally {
    exclusion.release();
    ordinary.release();
  }
});

it("refuses exclusion until an existing ordinary maintenance delegate settles", () => {
  const params = options();
  const ordinary = acquireGatewayMaintenanceCoordinator({ ...params, excludeGateway: false });
  const delegate = ordinary.createSchemaFenceDelegate({ ...params, actorId: "earlier" });
  try {
    expect(delegate).toBeDefined();
    expect(() => acquireGatewayMaintenanceCoordinator(params).release()).toThrow(
      "gateway-lifecycle",
    );
    ordinary.release();
    expect(() => acquireGatewayMaintenanceCoordinator(params).release()).toThrow(
      "gateway-lifecycle",
    );
    delegate?.release();
    acquireGatewayMaintenanceCoordinator(params).release();
  } finally {
    delegate?.release();
    ordinary.release();
  }
});

it("seals additional maintenance owners and unowned schema admission during exclusion", () => {
  const params = options();
  const exclusion = acquireGatewayMaintenanceCoordinator(params);
  try {
    for (const excludeGateway of [false, true]) {
      expect(() =>
        acquireGatewayMaintenanceCoordinator({ ...params, excludeGateway }).release(),
      ).toThrow("gateway-lifecycle");
    }
    expect(() => withStateSchemaFence(params, () => "foreign schema")).toThrow("schema");
  } finally {
    exclusion.release();
  }
  const ordinary = acquireGatewayMaintenanceCoordinator({ ...params, excludeGateway: false });
  const nested = acquireGatewayMaintenanceCoordinator({ ...params, excludeGateway: false });
  try {
    expect(withStateSchemaFence(params, () => withStateSchemaFence(params, () => "ordinary"))).toBe(
      "ordinary",
    );
    acquireGatewayLifecycleCoordinator(params).release();
  } finally {
    nested.release();
    ordinary.release();
  }
});

it("does not enter exclusion reentrantly from an active unowned schema operation", () => {
  const params = options();
  withStateSchemaFence(params, () => {
    expect(() => acquireGatewayMaintenanceCoordinator(params).release()).toThrow(
      "gateway-lifecycle",
    );
  });
  acquireGatewayMaintenanceCoordinator(params).release();
});

it("lends only live owner authority while retaining exclusion through all delegate cleanup", async () => {
  const params = { ...options(), actorId: "owned" };
  const exclusion = acquireGatewayMaintenanceCoordinator(params);
  const first = exclusion.createSchemaFenceDelegate(params)!;
  const last = exclusion.createSchemaFenceDelegate(params)!;
  const attached = await attachGatewaySchemaFenceDelegate(last.port, params);
  try {
    expect(attached.run(() => withStateSchemaFence(params, () => "owned schema"))).toBe(
      "owned schema",
    );
    exclusion.release();
    expect(() => exclusion.createSchemaFenceDelegate(params)?.release()).toThrow("closed");
    first.release();
    expect(tryAcquireExclusiveSqliteCoordinator(exclusion.path)).toBeNull();
    expect(() => acquireGatewayLifecycleCoordinator(params).release()).toThrow("gateway-lifecycle");
    expect(() => acquireGatewayMaintenanceCoordinator(params).release()).toThrow(
      "gateway-lifecycle",
    );
    await Promise.resolve();
    expect(attached.run(() => withStateSchemaFence(params, () => "retained schema"))).toBe(
      "retained schema",
    );
    last.release();
    expect(() => attached.run(() => withStateSchemaFence(params, () => "stale"))).toThrow("schema");
    acquireGatewayLifecycleCoordinator(params).release();
    const next = tryAcquireExclusiveSqliteCoordinator(exclusion.path);
    expect(next).not.toBeNull();
    next?.release();
  } finally {
    attached.close();
    last.release();
    first.release();
    exclusion.release();
  }
});

it("keeps local Gateway exclusion until a borrowed maintenance owner settles", () => {
  const params = options();
  const maintenance = acquireGatewayMaintenanceCoordinator(params);
  const delegate = maintenance.createSchemaFenceDelegate({ ...params, actorId: "doctor" });
  try {
    expect(delegate).toBeDefined();
    maintenance.release();
    expect(() => acquireGatewayLifecycleCoordinator(params)).toThrow("gateway-lifecycle");
    delegate?.release();
    acquireGatewayLifecycleCoordinator(params).release();
  } finally {
    delegate?.release();
    maintenance.release();
  }
});

it("refuses restoration while a stopped Gateway still has an unsettled worker delegate", () => {
  const params = options();
  const gateway = acquireGatewayLifecycleCoordinator(params);
  const delegate = tryCreateGatewaySchemaFenceDelegate({ ...params, actorId: "gateway-worker" });
  try {
    expect(delegate).toBeDefined();
    gateway.release();
    expect(() => acquireGatewayMaintenanceCoordinator(params)).toThrow("gateway-lifecycle");
    delegate?.release();
    acquireGatewayMaintenanceCoordinator(params).release();
  } finally {
    delegate?.release();
    gateway.release();
  }
});

it("does not admit a Gateway after failed native maintenance close", () => {
  const params = options();
  const { result: maintenance, database } = captureCoordinatorDatabase(() =>
    acquireGatewayMaintenanceCoordinator(params),
  );
  const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
    throw new Error("native close incomplete");
  });
  try {
    expect(() => maintenance.release()).toThrow("failed to release gateway-lifecycle");
    expect(() =>
      maintenance.createSchemaFenceDelegate({ ...params, actorId: "after-failed-close" }),
    ).toThrow("closed");
    expect(() => acquireGatewayLifecycleCoordinator(params)).toThrow("cleanup is pending");
    maintenance.release();
    acquireGatewayLifecycleCoordinator(params).release();
  } finally {
    close.mockRestore();
    maintenance.release();
  }
});

it("retains final delegate cleanup after native close failure without reopening admission", () => {
  const params = options();
  const { result: maintenance, database } = captureCoordinatorDatabase(() =>
    acquireGatewayMaintenanceCoordinator(params),
  );
  const delegate = maintenance.createSchemaFenceDelegate({ ...params, actorId: "last" })!;
  const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
    throw new Error("native delegate close incomplete");
  });
  try {
    maintenance.release();
    expect(() => delegate.release()).toThrow("failed to release gateway-lifecycle");
    expect(delegate.closed).toBe(false);
    expect(() =>
      acquireGatewayMaintenanceCoordinator({ ...params, excludeGateway: false }),
    ).toThrow("cleanup is pending");
    expect(() => acquireGatewayLifecycleCoordinator(params)).toThrow("cleanup is pending");
    delegate.release();
    expect(delegate.closed).toBe(true);
    acquireGatewayMaintenanceCoordinator(params).release();
  } finally {
    close.mockRestore();
    delegate.release();
    maintenance.release();
  }
});
