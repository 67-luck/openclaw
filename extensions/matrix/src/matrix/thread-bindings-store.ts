import { createHash } from "node:crypto";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";

export function openMatrixThreadBindingStoreOptions(
  env?: NodeJS.ProcessEnv,
): OpenKeyedStoreOptions {
  return { namespace: "thread-bindings", maxEntries: 10_000, env };
}

export function buildThreadBindingStoreKey(record: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string {
  const digest = createHash("sha256")
    .update(record.accountId)
    .update("\0")
    .update(record.parentConversationId ?? "")
    .update("\0")
    .update(record.conversationId)
    .digest("hex");
  return `${record.accountId}:${digest}`;
}
