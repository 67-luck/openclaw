import { describe, expect, it } from "vitest";
import { resolveModelCatalogConnect } from "./model-catalog-connect.js";

const serverCapabilities = ["model-catalog-snapshot", "node-protocol-features-v1"];

describe("resolveModelCatalogConnect", () => {
  it("publishes advertised optional connect features", () => {
    expect(
      resolveModelCatalogConnect({
        features: {
          modelCatalog: { agentId: "main" },
          protocolFeatures: ["system-run-result-first-v1"],
        },
        caps: [],
        serverCapabilities,
      }),
    ).toEqual({
      modelCatalog: { agentId: "main" },
      protocolFeatures: ["system-run-result-first-v1"],
      caps: ["model-catalog-snapshot"],
    });
  });

  it("omits all optional connect features for the legacy node envelope", () => {
    expect(
      resolveModelCatalogConnect({
        features: undefined,
        caps: [],
        serverCapabilities,
      }),
    ).toEqual({ caps: [], protocolFeatures: undefined });
  });
});
