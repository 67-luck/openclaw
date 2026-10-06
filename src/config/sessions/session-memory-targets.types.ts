import type { SessionParticipantIdentity } from "./session-participant-identity.js";

export type MemorySessionMetadataScope = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

export type MemorySessionTarget = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  resolution: "live" | "archived" | "unresolved";
  hookExternalContentSource: string | null;
  channel: string | null;
  accountId: string | null;
  chatType: string | null;
  createdAt?: number;
  participants: SessionParticipantIdentity[];
};

export type MemorySessionSelectors = {
  agentId: string;
  storePath?: string;
  sessionIds?: readonly string[];
  hookSources?: readonly string[];
  participants?: readonly string[];
  since?: string | number;
};
