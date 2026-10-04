import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserRequest } from "./routes/types.js";

type BrowserRequestScope = {
  managedOnly?: true;
  /** Host-prepared capability, never accepted from model arguments or remote transports. */
  allowLocalLoopback?: boolean;
  assertCurrent?: NonNullable<BrowserRequest["assertCurrent"]>;
};
const requestScope = new AsyncLocalStorage<{ scope: BrowserRequestScope; active: boolean }>();

/** Carry host-prepared request policy through the in-process Browser client. */
export async function withBrowserRequestScope<T>(
  scope: BrowserRequestScope,
  run: () => Promise<T>,
): Promise<T> {
  const entry = { scope, active: true };
  try {
    return await requestScope.run(entry, run);
  } finally {
    // Background callbacks may inherit ALS, but cannot retain a completed request's grant.
    entry.active = false;
  }
}

export function getBrowserRequestScope(): BrowserRequestScope | undefined {
  const entry = requestScope.getStore();
  return entry?.active ? entry.scope : undefined;
}
