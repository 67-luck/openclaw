import type { ClientVoiceAppLaunchOrigin } from "../../talk/client-voice-app-launch-policy.js";
import {
  readGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import type { GatewayClient } from "../server-methods/types.js";

/** Only the authenticated ingress can capture this; Talk capability flags carry no authority. */
export function captureTalkVoiceOrigin(params: {
  client?: GatewayClient | null;
  hasCurrentClientAuthority?: () => boolean;
}): ClientVoiceAppLaunchOrigin | undefined {
  const client = params.client;
  const isCurrent = params.hasCurrentClientAuthority;
  const deviceId = client?.connect?.device?.id;
  if (!client || client.isDeviceTokenAuth !== true || !deviceId || !isCurrent || !isCurrent()) {
    return undefined;
  }
  const releaseHold = retainGatewayDeviceRevocation(isCurrent);
  const sourceIsCurrent = readGatewayDeviceSourceAuthority(isCurrent);
  if (!releaseHold || !sourceIsCurrent) {
    releaseHold?.();
    return undefined;
  }
  let holds = 0;
  const retain = (): ClientVoiceAppLaunchOrigin => {
    holds += 1;
    let released = false;
    // Accepted work retains the committed source, not a retired request or tentative transport.
    const current = () => !released && sourceIsCurrent();
    return Object.freeze({
      deviceId,
      isCurrent: current,
      retain: () => {
        if (!current()) {
          throw new Error("Talk originating device authority is no longer current");
        }
        return retain();
      },
      release: () => {
        if (!released) {
          released = true;
          holds -= 1;
          if (holds === 0) {
            releaseHold();
          }
        }
      },
    });
  };
  return retain();
}
