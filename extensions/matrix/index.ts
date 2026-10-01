// Matrix plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { registerMatrixCliMetadata } from "./cli-metadata.js";
import { setMatrixRuntimeLifecycle, setMatrixServiceScheduler } from "./runtime-setter-api.js";
import { registerMatrixSubagentHooks } from "./subagent-hooks-api.js";

const loadMatrixHandlersRuntimeModule = createLazyRuntimeModule(
  () => import("./plugin-entry.handlers.runtime.js"),
);
const loadMatrixSharedClientRuntime = createLazyRuntimeModule(
  () => import("./src/matrix/client/shared.js"),
);

export function registerMatrixFullRuntime(api: OpenClawPluginApi): void {
  setMatrixRuntimeLifecycle(api.runtime, api.lifecycle);
  api.registerService({
    id: "matrix-clients",
    apiVersion: 2,
    start: async ({ scheduler }) => {
      const lifecycle = setMatrixServiceScheduler(api.runtime, scheduler);
      const { adoptSharedMatrixClientScheduler } = await loadMatrixSharedClientRuntime();
      await adoptSharedMatrixClientScheduler(lifecycle, scheduler);
    },
    stop: () => {
      setMatrixServiceScheduler(api.runtime, undefined);
    },
  });
  api.registerGatewayMethod("matrix.verify.recoveryKey", async (ctx) => {
    const { handleVerifyRecoveryKey } = await loadMatrixHandlersRuntimeModule();
    await handleVerifyRecoveryKey(ctx);
  });

  api.registerGatewayMethod("matrix.verify.bootstrap", async (ctx) => {
    const { handleVerificationBootstrap } = await loadMatrixHandlersRuntimeModule();
    await handleVerificationBootstrap(ctx);
  });

  api.registerGatewayMethod("matrix.verify.status", async (ctx) => {
    const { handleVerificationStatus } = await loadMatrixHandlersRuntimeModule();
    await handleVerificationStatus(ctx);
  });

  registerMatrixSubagentHooks(api);
}

export default defineBundledChannelEntry({
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "matrixPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setMatrixRuntime",
  },
  registerCliMetadata: registerMatrixCliMetadata,
  registerFull: registerMatrixFullRuntime,
});
