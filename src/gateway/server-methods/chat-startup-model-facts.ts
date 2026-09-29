import type { PreparedCliBackendModelIdentity } from "../../plugins/cli-backend.types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ChatStartupProjectionResult } from "./chat-startup-projection-contract.js";

type PreparedChatStartupModelFacts = Readonly<{
  metadataSnapshot: PluginMetadataSnapshot;
  cliBackendModels: readonly PreparedCliBackendModelIdentity[];
}>;
type ModelFactsReader = () => PreparedChatStartupModelFacts | undefined;

// Captured facts stay off the SDK-visible projection and use its original lifetime reader.
const modelFactsReaders = new WeakMap<ChatStartupProjectionResult, ModelFactsReader>();

export function bindChatStartupModelFacts(
  projection: ChatStartupProjectionResult,
  read: ModelFactsReader,
): ChatStartupProjectionResult {
  modelFactsReaders.set(projection, read);
  return projection;
}

export function getChatStartupModelFactsReader(
  projection: ChatStartupProjectionResult | undefined,
): ModelFactsReader | undefined {
  return projection && modelFactsReaders.get(projection);
}
