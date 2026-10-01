import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";

/** Canonical outbound target produced by plugin, directory, or normalized fallback resolution. */
export type ResolvedMessagingTarget = {
  to: string;
  kind: ChannelDirectoryEntryKind | "channel";
  display?: string;
  source: "normalized" | "directory";
  resolutionSource: "plugin" | "directory" | "normalized";
};

export function stripProviderTargetPrefixes(
  value: string,
  channel?: ChannelId,
  plugin?: ChannelPlugin,
): string {
  const providerPrefixes = [channel, plugin?.id, ...(plugin?.messaging?.targetPrefixes ?? [])]
    .map((prefix) => prefix?.trim().toLowerCase() ?? "")
    .filter(Boolean);
  let target = value.trim();
  while (target) {
    const lowered = target.toLowerCase();
    const prefix = providerPrefixes.find((candidate) => lowered.startsWith(`${candidate}:`));
    if (!prefix) {
      break;
    }
    target = target.slice(prefix.length + 1).trim();
  }
  return target;
}

export function stripTargetPrefixes(
  value: string,
  channel?: ChannelId,
  plugin?: ChannelPlugin,
): string {
  return stripProviderTargetPrefixes(value, channel, plugin)
    .replace(/^(channel|group|user):/i, "")
    .replace(/^[@#]/, "")
    .trim();
}

export function buildNormalizedResolveResult(params: {
  normalized: string;
  kind: ResolvedMessagingTarget["kind"];
}): { ok: true; target: ResolvedMessagingTarget } {
  return {
    ok: true,
    target: {
      to: params.normalized,
      kind: params.kind,
      display: stripTargetPrefixes(params.normalized),
      source: "normalized",
      resolutionSource: "normalized",
    },
  };
}
