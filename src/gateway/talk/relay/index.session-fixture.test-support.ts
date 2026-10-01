import { resolveRealtimeVoiceProviderCapabilities } from "../../../talk/provider-resolver.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  createTalkRealtimeRelaySession as createTalkRealtimeRelaySessionRaw,
  stopTalkRealtimeRelaySession as stopTalkRealtimeRelaySessionRaw,
} from "./index.js";

export function createRelaySessionFixture(activeRelaySessions: Map<string, string>) {
  type RelaySessionParams = Parameters<typeof createTalkRealtimeRelaySessionRaw>[0];
  type RelayFixtureDefaults = "connId" | "providerConfig" | "instructions" | "tools";

  function createTalkRealtimeRelaySession(
    params: Omit<RelaySessionParams, "sessionTarget" | "controlSource" | RelayFixtureDefaults> &
      Partial<Pick<RelaySessionParams, RelayFixtureDefaults>> & { sessionKey?: string },
  ): ReturnType<typeof createTalkRealtimeRelaySessionRaw> {
    const {
      sessionKey,
      connId = "conn-1",
      providerConfig = {},
      instructions = "brief",
      tools = [],
      ...request
    } = params;
    const cfg = params.cfg ?? { agents: { entries: { main: { default: true } } } };
    const capabilities = resolveRealtimeVoiceProviderCapabilities({
      provider: params.provider,
      providerConfig,
      cfg,
      model: params.model,
      surface: "gateway-relay",
    });
    const session = createTalkRealtimeRelaySessionRaw({
      ...request,
      connId,
      providerConfig,
      instructions,
      tools,
      controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
      capabilities,
      context: {
        ...request.context,
        rpcSources: request.context.rpcSources ?? new Map(),
      },
      cfg,
      sessionTarget: prepareTalkSessionTarget(cfg, sessionKey ?? "agent:main:main"),
    });
    activeRelaySessions.set(session.relaySessionId, connId);
    return session;
  }

  function stopTalkRealtimeRelaySession(
    params: Parameters<typeof stopTalkRealtimeRelaySessionRaw>[0],
  ): void {
    void stopTalkRealtimeRelaySessionRaw(params);
    activeRelaySessions.delete(params.relaySessionId);
  }

  return { createTalkRealtimeRelaySession, stopTalkRealtimeRelaySession };
}
