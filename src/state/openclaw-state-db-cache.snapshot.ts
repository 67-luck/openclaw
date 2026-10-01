import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";

type RemovalAdmission = { assertCurrent(): void; release(): void };

export function createStateDatabaseSnapshotPreparation(params: {
  holdExclusion: (pathname: string) => () => void;
  closeByPath: (pathname: string) => Promise<boolean>;
  prepareRemoval: (pathname: string, assertOwnerCurrent: () => void) => Promise<RemovalAdmission>;
}) {
  /** Settle native WAL state before recording an offline snapshot's write generation. */
  return async function prepareOpenClawStateDatabaseSnapshot(
    pathname: string,
    assertOwnerCurrent: () => void,
  ) {
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (!maintenance?.ownsSchemaMaintenance) {
      throw new Error("State snapshot settlement requires the installation's maintenance owner");
    }
    maintenance.assertAdmission();
    const releaseAdmission = params.holdExclusion(pathname);
    const settlement = createOpenClawDatabaseMaintenanceScope();
    settlement.own({}, "shared-resources", async () => {
      await params.closeByPath(pathname);
    });
    const admission: { removal?: RemovalAdmission } = {};
    const release = () => {
      admission.removal?.release();
      releaseAdmission();
    };
    maintenance.own(settlement, "shared-handles", async () => {
      await settlement.close();
      release();
    });
    admission.removal = await settlement.run(() =>
      params.prepareRemoval(pathname, assertOwnerCurrent),
    );
    // Finish the native probe on every platform before a snapshot reader opens.
    // The parent retains the local seal if native cleanup cannot be confirmed.
    await settlement.close();
    assertOwnerCurrent();
    return release;
  };
}
