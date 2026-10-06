const RECOVERY_STORAGE_PREFIX = "openclaw.new-session.session-placement-recovery.v1:";
const REQUIRED_RECOVERY_STORAGE_PREFIX =
  "openclaw.new-session.required-session-placement-recovery.v1:";

function recoveryScopeStoragePrefix(
  storagePrefix: string,
  gatewayUrl: string,
  recoveryScope: string,
): string {
  return `${storagePrefix}${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}:`;
}

// Web Storage keys are JS strings, so frame UTF-16 code units directly.
// This keeps every component unambiguous without rejecting lone surrogates.
export function sessionPlacementRecoveryScopeStoragePrefix(
  gatewayUrl: string,
  recoveryScope: string,
): string {
  return recoveryScopeStoragePrefix(RECOVERY_STORAGE_PREFIX, gatewayUrl, recoveryScope);
}

export function requiredSessionPlacementRecoveryScopeStoragePrefix(
  gatewayUrl: string,
  recoveryScope: string,
): string {
  return recoveryScopeStoragePrefix(REQUIRED_RECOVERY_STORAGE_PREFIX, gatewayUrl, recoveryScope);
}

export function sessionPlacementRecoveryExactStorageKey(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): string {
  return `${sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope)}${sessionKey.length}:${sessionKey}`;
}

export function requiredSessionPlacementRecoveryExactStorageKey(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): string {
  return `${requiredSessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope)}${sessionKey.length}:${sessionKey}`;
}

export function sessionPlacementRecoveryExactStorageKeys(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): readonly string[] {
  return [
    requiredSessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey),
    sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey),
  ];
}

// Enumerate scope ownership without loading payload validators into the startup graph.
export function listSessionPlacementRecoveryStorageKeys(
  gatewayUrl: string,
  recoveryScope: string,
): string[] {
  try {
    const storage = globalThis.sessionStorage;
    const prefixes = [
      sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope),
      requiredSessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope),
    ];
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        keys.push(key);
      }
    }
    return keys.toSorted();
  } catch {
    return [];
  }
}
