/** Preserve the beta updater's worker-operation module after package replacement. */
export async function prepareOpenClawStateLeaseWorkerRuntime(): Promise<void> {
  await Promise.all([
    import("./openclaw-state-worker-store.js"),
    import("../infra/sqlite-worker-identity.js"),
    import("../infra/sqlite-worker-store.js"),
  ]);
}

export { runWithOpenClawStateLeaseWorker } from "./openclaw-state-lease-worker-storage.js";
