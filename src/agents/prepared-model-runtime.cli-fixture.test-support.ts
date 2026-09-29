import path from "node:path";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCliBackendModelIdentitiesWithSource } from "./cli-backends.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

export async function prepareFixtureCliBackendModelIdentities(
  params: Parameters<typeof prepareCliBackendModelIdentitiesWithSource>[0],
) {
  return await withPluginRuntimeGenerationScope(
    { metadataSnapshot: params.metadataSnapshot },
    async () => {
      await using resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
      return await prepareCliBackendModelIdentitiesWithSource(params, (read) =>
        resources.prepareSetup(read, () => {}),
      );
    },
  );
}

export const backendId = "setup-identity-cli";

export async function writeSetupFixture(
  state: OpenClawTestState,
  pluginId: string,
  modelProvider: string | undefined,
  fails = false,
  runtimeModelProvider?: string,
  requiresRuntime = true,
) {
  const relativeRoot = path.join("cli-identity-plugins", pluginId);
  await state.writeText(
    path.join(relativeRoot, "package.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await state.writeText(
    path.join(relativeRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      cliBackends: [backendId],
      setup: { requiresRuntime, cliBackends: [backendId] },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  const backend = { id: backendId, modelProvider, config: { command: "unused-fixture-command" } };
  await state.writeText(
    path.join(relativeRoot, "index.cjs"),
    runtimeModelProvider
      ? `module.exports = { register(api) { api.registerCliBackend(${JSON.stringify({ ...backend, modelProvider: runtimeModelProvider })}); } };\n`
      : 'throw new Error("Full runtime entry must remain unloaded for this read");\n',
  );
  await state.writeText(
    path.join(relativeRoot, "setup-api.cjs"),
    `module.exports = { register(api) { ${fails ? 'throw new Error("Setup fixture refused");' : `api.registerCliBackend(${JSON.stringify(backend)});`} } };\n`,
  );
  return state.statePath(relativeRoot);
}
