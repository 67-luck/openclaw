import type { DiagnosticBaseEvent } from "./diagnostic-base-event.types.js";

/** Prepared runtime guard facts only; validation does not prove a later session write. */
export type DiagnosticModelRuntimeChoiceEvent = DiagnosticBaseEvent & {
  type: "model.runtime_choice";
  version: 1;
  checks: {
    ownerLookup: "not-reached" | "present" | "absent";
    authStore: "not-reached" | "present" | "absent";
    catalogPresence: "not-reached" | "present" | "absent";
    offCatalogAuth: "not-reached" | "available" | "unavailable";
    offCatalogAuthMode: "not-reached" | "available" | "unavailable";
    offCatalogResolution: "not-reached" | "resolved" | "unresolved";
    runtimeEligibility: "not-reached" | "eligible" | "ineligible";
    commitOwnerFreshness: "not-reached" | "current" | "stale";
    nativeAvailability: "not-reached" | "available" | "unavailable";
  };
} & (
    | { phase: "prepare"; outcome: "ready"; reason: "ready" }
    | {
        phase: "prepare";
        outcome: "unavailable";
        reason:
          | "owner-missing"
          | "auth-store-missing"
          | "off-catalog-auth-unavailable"
          | "off-catalog-auth-mode-unavailable"
          | "off-catalog-resolution-unavailable"
          | "runtime-ineligible";
      }
    | { phase: "validate"; outcome: "ready"; reason: "ready" }
    | {
        phase: "validate";
        outcome: "unavailable";
        reason: "owner-stale" | "native-unavailable";
      }
  );
