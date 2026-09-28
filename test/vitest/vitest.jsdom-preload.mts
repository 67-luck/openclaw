import { isAbsolute } from "node:path";
import { installJsdomEnvironmentAdapter } from "../jsdom-compat.mts";

function installWorkerJsdomAdapter() {
  // Native children inherit this preload but may not run inside a Vitest package.
  const entrypoint = process.argv[1];
  if (!entrypoint || !isAbsolute(entrypoint)) {
    return;
  }

  // Match the worker's Vitest instance, including package-local pnpm peer graphs.
  const require = process.getBuiltinModule("module").createRequire(entrypoint);
  try {
    require.resolve("vitest/package.json");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return;
    }
    throw error;
  }

  // Do not hide a broken runtime when the entrypoint has an installed Vitest.
  const { builtinEnvironments }: typeof import("vitest/runtime") = require("vitest/runtime");
  installJsdomEnvironmentAdapter(builtinEnvironments.jsdom);
}

installWorkerJsdomAdapter();
