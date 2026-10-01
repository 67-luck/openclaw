import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import { stripTargetProviderPrefix } from "./channel-target-prefix.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

/** Compare the plugin-owned conversation grammar; do not create a parallel target parser. */
export function heartbeatExecRouteKey(
  route: DeliveryContext,
  plugin?: ChannelPlugin,
): string | undefined {
  const isGroup = plugin?.messaging?.inferTargetChatType?.({ to: route.to ?? "" }) !== "direct";
  const scopedConversation =
    route.threadId == null
      ? undefined
      : plugin?.messaging?.resolveInboundConversation?.({ to: String(route.threadId), isGroup });
  const scopedTarget = scopedConversation?.conversationId
    ? plugin?.messaging?.resolveDeliveryTarget?.({
        conversationId: scopedConversation.conversationId,
        parentConversationId: scopedConversation.parentConversationId,
      })
    : undefined;
  const normalizedThread = scopedTarget?.threadId ?? route.threadId;
  const conversation = plugin?.messaging?.resolveInboundConversation?.({
    to: route.to,
    threadId: normalizedThread,
    isGroup,
  });
  const target = conversation?.conversationId
    ? plugin?.messaging?.resolveDeliveryTarget?.({
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
      })
    : undefined;
  if (
    scopedTarget?.threadId != null &&
    scopedConversation?.conversationId !== conversation?.conversationId
  ) {
    return undefined;
  }
  const explicitThread = normalizedThread == null ? undefined : String(normalizedThread);
  if (target?.threadId != null && explicitThread != null && target.threadId !== explicitThread) {
    return undefined;
  }
  return channelRouteDedupeKey({
    channel: route.channel,
    accountId: route.accountId,
    to:
      conversation?.conversationId ??
      normalizeTargetForProvider(route.channel ?? "", route.to, plugin),
    threadId: target?.threadId ?? route.threadId,
  });
}

export function hasDeliverableHeartbeatTurnSource(
  turnSource: DeliveryContext | undefined,
): boolean {
  return Boolean(
    turnSource?.channel && isDeliverableMessageChannel(turnSource.channel) && turnSource.to?.trim(),
  );
}

export function isPositivelyDirectHeartbeatOwnerTarget(params: {
  plugin?: ChannelPlugin;
  to: string;
  chatType?: ChatType;
}): boolean {
  const to = params.plugin
    ? stripTargetProviderPrefix(
        params.to,
        params.plugin.id,
        ...(params.plugin.messaging?.targetPrefixes ?? []),
      )
    : params.to.trim();
  const chatType =
    normalizeChatType(params.chatType) ?? params.plugin?.messaging?.inferTargetChatType?.({ to });
  // Implicit delivery must prove a direct destination via the channel's own
  // classifier; syntax alone (even `user:`) never admits, so unclassified
  // shapes fail closed and operator alerts cannot escape into a shared chat.
  return chatType === "direct";
}
