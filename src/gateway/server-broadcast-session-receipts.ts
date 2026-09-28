import type { GatewayWsClient } from "./server/ws-types.js";

const BURST_MS = 25;
const MAX_RECEIPTS = 32;

export type SessionReceipt = {
  fragment: string;
  bytes: number;
  isCurrent: () => boolean;
  dropIfSlow: boolean;
  delivered?: () => void;
};

type PendingReceipts = {
  client: GatewayWsClient;
  socket: GatewayWsClient["socket"];
  sessionKey: string;
  agentId?: string;
  recipientProfileId?: string;
  receipts: SessionReceipt[];
  bytes: number;
  close: () => void;
};

/** Only adjacent receipts share a frame; other publications are ordering barriers. */
export function createGatewaySessionReceiptDelivery(params: {
  maxBytes: number;
  send: (
    pending: PendingReceipts,
    payloadFragment: string,
    dropIfSlow: boolean,
    delivered: () => void,
  ) => void;
}) {
  const pending = new Map<GatewayWsClient, PendingReceipts>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const take = (entry: PendingReceipts) => {
    if (pending.get(entry.client) !== entry) {
      return;
    }
    pending.delete(entry.client);
    entry.socket.off("close", entry.close);
    if (pending.size === 0) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const current = (client: GatewayWsClient) => {
    const entry = pending.get(client);
    if (
      entry &&
      (client.socket !== entry.socket ||
        client.preparedRecipientProfileId !== entry.recipientProfileId)
    ) {
      take(entry);
      return undefined;
    }
    return entry;
  };
  const flush = (client: GatewayWsClient) => {
    const entry = current(client);
    if (!entry) {
      return;
    }
    take(entry);
    const receipts = entry.receipts.filter((receipt) => receipt.isCurrent());
    if (receipts.length === 0) {
      return;
    }
    const target = JSON.stringify({ sessionKey: entry.sessionKey, agentId: entry.agentId });
    params.send(
      entry,
      `,"payload":${target.slice(0, -1)},"receipts":[${receipts.map((receipt) => receipt.fragment).join(",")}]}`,
      receipts.every((receipt) => receipt.dropIfSlow),
      () => {
        for (const receipt of receipts) {
          receipt.delivered?.();
        }
      },
    );
  };
  return {
    bufferedBytes: (client: GatewayWsClient) => current(client)?.bytes ?? 0,
    before: (client: GatewayWsClient, sessionKey?: string, agentId?: string) => {
      const entry = current(client);
      if (entry && (entry.sessionKey !== sessionKey || entry.agentId !== agentId)) {
        flush(client);
      }
    },
    enqueue: (
      client: GatewayWsClient,
      sessionKey: string,
      agentId: string | undefined,
      receipt: SessionReceipt,
    ) => {
      if (receipt.bytes > params.maxBytes) {
        flush(client);
        return false;
      }
      let entry = current(client);
      if (
        entry &&
        (entry.receipts.length === MAX_RECEIPTS || entry.bytes + receipt.bytes > params.maxBytes)
      ) {
        flush(client);
        entry = undefined;
      }
      if (!entry) {
        const socket = client.socket;
        entry = {
          client,
          socket,
          sessionKey,
          agentId,
          recipientProfileId: client.preparedRecipientProfileId,
          receipts: [],
          bytes: 0,
          close: () => {
            const current = pending.get(client);
            if (current?.socket === socket) {
              take(current);
            }
          },
        };
        pending.set(client, entry);
        socket.once("close", entry.close);
      }
      entry.receipts.push(receipt);
      entry.bytes += receipt.bytes;
      timer ??= setTimeout(() => {
        timer = undefined;
        for (const client of [...pending.keys()]) {
          flush(client);
        }
      }, BURST_MS);
      timer.unref?.();
      return true;
    },
  };
}
