import type { ChannelDmAllowFromMode } from "../../../channels/plugins/dm-access.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";

export type AllowFromMode = ChannelDmAllowFromMode;

/** Return the allowFrom interpretation mode advertised by a channel's doctor metadata. */
export function resolveAllowFromMode(channelName: string): AllowFromMode {
  return getDoctorChannelCapabilities(channelName).dmAllowFromMode;
}
