import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Temporary projection for the hosted native typing investigation.
const events = new Set([
  "editor-created",
  "editor-window",
  "environment-changed",
  "composer-readiness",
  "owner-sync",
  "owner-replaced",
  "focus-request",
  "focus-result",
  "blur-request",
  "blur-result",
  "editing-began",
  "editing-ended",
  "interaction-before",
  "interaction-after",
  "text-changed",
  "update-before",
  "update-value",
  "keyboard-will-show",
  "keyboard-did-show",
  "keyboard-will-hide",
  "keyboard-did-hide",
  "before-input-lookup",
  "after-input-lookup",
  "before-input-wait",
  "after-input-wait",
  "before-tap",
  "after-tap",
  "before-type",
  "after-type",
  "issue",
]);
const stages = new Set(["setup", "seed-0", "seed-1", "seed-2", "final"]);
const categories = new Set([
  "keyboard-focus",
  "keyboard-snapshot",
  "event-synthesis",
  "app-not-running",
  "app-crash",
  "accessibility",
  "timeout",
  "other",
]);
const flags = [
  "attached",
  "firstResponder",
  "editable",
  "selectable",
  "enabled",
  "environmentEnabled",
  "pickerRequest",
  "pendingHandoff",
  "ownerMismatch",
  "gatewayConnected",
  "canQueueOffline",
  "ownerChanged",
  "authorityChanged",
  "sessionChanged",
  "agentChanged",
  "contractChanged",
  "presentationPreserved",
  "storedAuthAllowedBefore",
  "storedAuthAllowedAfter",
  "result",
] as const;
const counts = [
  "sequence",
  "process",
  "editorId",
  "issueType",
  "sourceLine",
  "textLength",
  "modelLength",
  "selectionLength",
] as const;

export function projectTypingDiagnostics(
  output: string,
): Record<string, string | number | boolean>[] {
  const projected: Record<string, string | number | boolean>[] = [];
  for (const line of output.split("\n")) {
    const offset = line.indexOf("IOS_TYPING_PROBE ");
    if (offset < 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line.slice(offset + "IOS_TYPING_PROBE ".length));
    } catch {
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    const record = value;
    if (
      (record.source !== "app" && record.source !== "test") ||
      typeof record.event !== "string" ||
      !events.has(record.event)
    ) {
      continue;
    }
    const fact: Record<string, string | number | boolean> = {
      source: record.source,
      event: record.event,
    };
    for (const key of flags) {
      if (typeof record[key] === "boolean") {
        fact[key] = record[key];
      }
    }
    for (const key of counts) {
      const number = record[key];
      if (
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number >= 0 &&
        number <= (key === "sequence" ? 4096 : 1_000_000)
      ) {
        fact[key] = number;
      }
    }
    for (const key of ["uptimeMs", "keyboardHeight"] as const) {
      const number = record[key];
      if (
        typeof number === "number" &&
        Number.isFinite(number) &&
        number >= 0 &&
        number <= (key === "keyboardHeight" ? 10_000 : 1e15)
      ) {
        fact[key] = number;
      }
    }
    if (
      typeof record.errorCode === "number" &&
      Number.isSafeInteger(record.errorCode) &&
      Math.abs(record.errorCode) <= 1_000_000_000
    ) {
      fact.errorCode = record.errorCode;
    }
    if (typeof record.stage === "string" && stages.has(record.stage)) {
      fact.stage = record.stage;
    }
    if (typeof record.category === "string" && categories.has(record.category)) {
      fact.category = record.category;
    }
    projected.push(fact);
  }
  return projected.slice(-4096);
}
