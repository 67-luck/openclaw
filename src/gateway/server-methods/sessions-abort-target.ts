import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { inputMatchesSessionId } from "../../sessions/session-controller.lifecycle-projections.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import type { SessionControllerEntry } from "../../sessions/session-controller.state.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import {
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../session-store-key.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "rpcSources">;
  requestedKey: string;
  canonicalKey: string;
  activeRunSessionKey?: string;
  aliasKeys?: string[];
  agentId?: string;
  defaultAgentId?: string;
}): string {
  if (params.activeRunSessionKey) {
    return params.activeRunSessionKey;
  }
  const candidates = new Set([
    params.canonicalKey,
    params.requestedKey,
    ...(params.aliasKeys ?? []),
  ]);
  for (const active of params.context.rpcSources.values()) {
    if (active.adapter.controlUiVisible === false) {
      continue;
    }
    if (candidates.has(active.adapter.sessionKey)) {
      const owner = resolveChatRunOwnerAgentId({
        agentId: active.adapter.agentId,
        sessionKey: active.adapter.sessionKey,
        defaultAgentId: params.defaultAgentId,
      });
      if (!params.agentId || owner === normalizeAgentId(params.agentId)) {
        return active.adapter.sessionKey;
      }
    }
  }
  return params.requestedKey;
}

export function resolveSessionKeyAgentId(
  sessionKey: string | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  return parsed?.agentId ?? tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
}

export function sessionKeyBelongsToAgent(
  sessionKey: string | undefined,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  return resolveSessionKeyAgentId(sessionKey, cfg) === normalizeAgentId(agentId);
}

export function resolveScopedAbortKey(params: {
  cfg: OpenClawConfig;
  key: string | undefined;
  agentId: string | undefined;
}): string | undefined {
  const key = normalizeOptionalString(params.key);
  if (!key) {
    return undefined;
  }
  const requestedAgentId = normalizeOptionalString(params.agentId);
  if (!requestedAgentId) {
    return key;
  }
  const scopedAgentId = normalizeAgentId(requestedAgentId);
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
  if (ownerAgentId && ownerAgentId !== scopedAgentId) {
    return undefined;
  }
  return resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
}

/** Capture exact channel source identities before any earlier RPC cleanup can reenter. */
export function captureAbortChannelSources(params: {
  controllerOwners: readonly SessionControllerEntry[];
  representedInputs: ReadonlySet<SessionControllerInput>;
  requiredSessionId?: string;
}) {
  return new Map(
    params.controllerOwners.flatMap((owner) =>
      (owner.mailbox?.entries ?? [])
        .filter(
          (input) =>
            !params.representedInputs.has(input) &&
            inputMatchesSessionId(input, params.requiredSessionId),
        )
        .map(
          (input) =>
            [
              input,
              {
                source: input.source,
                target: input.target,
                mailbox: input.mailbox,
                sessionId: input.source?.run.sessionId,
              },
            ] as const,
        ),
    ),
  );
}
