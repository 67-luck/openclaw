import type { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";
import type { GATEWAY_SERVER_CAPS, ConnectParams } from "@openclaw/gateway-protocol/frame-guards";

const MODEL_CATALOG_SNAPSHOT: typeof GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT =
  "model-catalog-snapshot" satisfies typeof GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT;
const NODE_PROTOCOL_FEATURES =
  "node-protocol-features-v1" satisfies typeof GATEWAY_SERVER_CAPS.NODE_PROTOCOL_FEATURES;

export type ConnectFeatures = {
  modelCatalog?: ConnectParams["modelCatalog"];
  protocolFeatures?: ConnectParams["protocolFeatures"];
};

/** A requested snapshot opts in only after the server advertises its connect field. */
export function resolveModelCatalogConnect(
  params: ConnectFeatures & {
    features?: ConnectFeatures;
    caps?: readonly string[];
    serverCapabilities: readonly string[];
  },
): Pick<ConnectParams, "modelCatalog" | "protocolFeatures" | "caps"> {
  const features = params.features ?? params;
  const modelCatalog = params.serverCapabilities.includes(MODEL_CATALOG_SNAPSHOT)
    ? features.modelCatalog
    : undefined;
  const protocolFeatures = params.serverCapabilities.includes(NODE_PROTOCOL_FEATURES)
    ? features.protocolFeatures
    : undefined;
  const caps = params.caps?.filter((cap) => cap !== MODEL_CATALOG_SNAPSHOT);
  if (modelCatalog === undefined) {
    return { caps, protocolFeatures };
  }
  return { modelCatalog, protocolFeatures, caps: [...(caps ?? []), MODEL_CATALOG_SNAPSHOT] };
}
