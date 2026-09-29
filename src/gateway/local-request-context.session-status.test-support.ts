import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import { createModelRuntimeChoiceOwnerFixture } from "../agents/model-runtime-choice.test-support.js";
import { readPreparedModelRuntimeCliBackendModels } from "../agents/prepared-model-runtime-auth.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import * as providerUsage from "../infra/provider-usage.load.js";

/** Keep unrelated catalog and external usage acquisition outside session authorization proof. */
export function mockSessionStatusModelDependencies() {
  const usage = vi
    .spyOn(providerUsage, "loadProviderUsageSummary")
    .mockResolvedValue({ updatedAt: 0, providers: [] });
  onTestFinished(() => usage.mockRestore());
  const prepareModel = vi
    .spyOn(preparedModelRuntime, "acquireReadOnlyPreparedModelRuntime")
    .mockImplementation(async (input) => {
      const snapshot = createModelRuntimeChoiceOwnerFixture(input.config, () => true, {}, input);
      return {
        snapshot,
        pluginGeneration: {
          pluginMetadataSnapshot: snapshot.metadataSnapshot,
          cliBackendModels: expectDefined(
            readPreparedModelRuntimeCliBackendModels(snapshot),
            "Expected CLI identities from the prepared session-status fixture",
          ),
          inlineProviderModels: snapshot.inlineProviderModels,
          configuredCatalogEntries: snapshot.modelCatalog.entries,
        },
        async [Symbol.asyncDispose]() {},
      };
    });
  onTestFinished(() => prepareModel.mockRestore());
}
