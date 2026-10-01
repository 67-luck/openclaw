import { createChannelIngressError } from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const NOSTR_INGRESS_PAYLOAD_VERSION = 1;

export type NostrIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEvent: string;
};

export const NostrIngressPermanentError = createChannelIngressError<string>(
  "NostrIngressPermanentError",
  { withReason: true },
);

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new NostrIngressPermanentError("invalid-event", `Nostr event is missing ${field}.`);
}

export function inspectNostrIngressEvent(event: unknown): { eventId: string; laneKey: string } {
  if (!isRecord(event)) {
    throw new NostrIngressPermanentError("invalid-event", "Nostr event must be an object.");
  }
  return {
    eventId: requiredString(event.id, "id"),
    laneKey: `direct:${requiredString(event.pubkey, "pubkey")}`,
  };
}
