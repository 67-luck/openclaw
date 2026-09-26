import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureCoordinatorDatabase } from "./sqlite-coordinator.test-support.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireGatewayMaintenanceCoordinator,
  tryCreateGatewaySchemaFenceDelegate,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function options() {
  const root = tempDirs.make("gateway-restore-fence-");
  return { databasePath: path.join(root, "db"), runtimeDirectory: root, excludeGateway: true };
}

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
    expect(() => acquireGatewayLifecycleCoordinator(params)).toThrow("cleanup is pending");
    maintenance.release();
    acquireGatewayLifecycleCoordinator(params).release();
  } finally {
    close.mockRestore();
    maintenance.release();
  }
});
