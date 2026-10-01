import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";

export function resolveDiscordVoiceEnabled(voice: DiscordAccountConfig["voice"]): boolean {
  if (voice?.enabled !== undefined) {
    return voice.enabled;
  }
  return voice !== undefined;
}

const DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS = [
  "api key missing",
  "incorrect api key",
  "invalid api key",
  "unauthorized",
  "authentication",
  "permission denied",
  "forbidden",
];

export function isDiscordVoiceFatalAutoJoinFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}
