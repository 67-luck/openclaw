import path from "node:path";
import { fileURLToPath } from "node:url";

export const databaseVerifyHostRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: path.basename(
    fileURLToPath(new URL("./openclaw-database-verify-host.test-support.ts", import.meta.url)),
    ".ts",
  ),
  distWorkerPath: "state/openclaw-database-verify-host.test-support.js",
} as const;
