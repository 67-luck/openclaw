import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";

export async function writeAbortSessionStore(
  storePath: string,
  sessionIdsByKey: Record<string, string>,
  nowMs = Date.now(),
): Promise<void> {
  await Promise.all(
    Object.entries(sessionIdsByKey).map(([sessionKey, sessionId]) =>
      replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: nowMs }),
    ),
  );
}
