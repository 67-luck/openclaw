import "./template.js";

type UsageBarTemplateTestApi = {
  clearUsageBarTemplateCacheForTest(): Promise<void>;
  reconcileUsageBarTemplateCacheForTest(): Promise<void>;
};

function getTestApi(): UsageBarTemplateTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.usageBarTemplateTestApi")
  ];
  if (!api) {
    throw new Error("usage bar template test API is unavailable");
  }
  return api as UsageBarTemplateTestApi;
}

export const clearUsageBarTemplateCacheForTest = () =>
  getTestApi().clearUsageBarTemplateCacheForTest();
export const reconcileUsageBarTemplateCacheForTest = () =>
  getTestApi().reconcileUsageBarTemplateCacheForTest();
