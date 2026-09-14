// Kimi Coding setup module handles plugin onboarding behavior.
import { findNormalizedProviderValue } from "openclaw/plugin-sdk/provider-auth";
import {
  createDefaultModelsPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildKimiCodingProvider,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const KIMI_MODEL_REF = `kimi/${KIMI_CODING_DEFAULT_MODEL_ID}`;
export const KIMI_CODING_MODEL_REF = KIMI_MODEL_REF;

const kimiCodingPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: KIMI_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const defaultModel = buildKimiCodingProvider().models.find(
      ({ id }) => id === KIMI_CODING_DEFAULT_MODEL_ID,
    );
    if (!defaultModel) {
      return null;
    }
    return {
      providerId: "kimi",
      api: "anthropic-messages",
      baseUrl: KIMI_CODING_BASE_URL,
      defaultModels: cfg.models?.mode === "replace" ? [defaultModel] : [],
      defaultModelId: KIMI_CODING_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: KIMI_MODEL_REF, alias: "Kimi" }],
    };
  },
});

export const applyKimiCodeConfig = kimiCodingPresetAppliers.applyConfig;

export function applyKimiProviderConnectionConfig(cfg: OpenClawConfig): OpenClawConfig {
  const existing = findNormalizedProviderValue(cfg.models?.providers, "kimi");
  const next = kimiCodingPresetAppliers.applyProviderConfig(cfg);
  const connection = next.models?.providers?.kimi;
  if (existing && connection) {
    connection.baseUrl = existing.baseUrl;
    connection.api = existing.api ?? connection.api;
  }
  return next;
}
