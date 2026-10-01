import { parseAgentSessionKey } from "../routing/session-key.js";

/** Captured logical/store identity. Incarnation is evidence, never live authorization. */
export type SessionTarget = Readonly<{
  storeScope: string;
  sessionKey: string;
  aliases: readonly string[];
  agentId: string | undefined;
  incarnation: string | undefined;
}>;

export function captureSessionTarget(params: {
  storeScope: string;
  sessionKey: string;
  aliases?: Iterable<string | undefined>;
  agentId?: string;
  incarnation?: string;
}): SessionTarget {
  const storeScope = params.storeScope.trim();
  const sessionKey = params.sessionKey.trim();
  if (!storeScope || !sessionKey) {
    throw new Error("Session target requires store scope and canonical key");
  }
  return Object.freeze({
    storeScope,
    sessionKey,
    aliases: Object.freeze(
      [
        ...new Set(
          [sessionKey, ...(params.aliases ?? []), params.incarnation].flatMap((value) =>
            value?.trim() ? [value.trim()] : [],
          ),
        ),
      ].toSorted(),
    ),
    agentId: params.agentId ?? parseAgentSessionKey(sessionKey)?.agentId,
    incarnation: params.incarnation,
  });
}

/** Adapter input for physical owners that already captured their complete identity set. */
export type IdentityTarget = { scope: string; identities: Iterable<string | undefined> };
export type TargetInput = { target: SessionTarget } | IdentityTarget;
export function targetFrom(input: TargetInput): SessionTarget {
  if ("target" in input) {
    return input.target;
  }
  const aliases = [...input.identities].flatMap((value) => (value?.trim() ? [value.trim()] : []));
  const sessionKey = aliases.find((key) => key.startsWith("agent:")) ?? aliases[0];
  if (!sessionKey) {
    throw new Error("Session target requires an identity");
  }
  return captureSessionTarget({ storeScope: input.scope, sessionKey, aliases });
}
