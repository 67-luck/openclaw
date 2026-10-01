import type { ChannelConversationBindingSupportV2 } from "openclaw/plugin-sdk/channel-contract";
import {
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingIdleTimeoutBySessionKeyAsync,
  setTelegramThreadBindingMaxAgeBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKeyAsync,
} from "./thread-bindings.js";

export const telegramThreadBindingLifecycle: Pick<
  ChannelConversationBindingSupportV2,
  | "createManager"
  | "setIdleTimeoutBySessionKey"
  | "setMaxAgeBySessionKey"
  | "setIdleTimeoutBySessionKeyAsync"
  | "setMaxAgeBySessionKeyAsync"
> = {
  createManager: ({ cfg, accountId, scheduler }) =>
    createTelegramThreadBindingManager({
      scheduler,
      cfg,
      accountId: accountId ?? undefined,
      persist: false,
      enableSweeper: false,
    }),
  setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
    setTelegramThreadBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: accountId ?? undefined,
      idleTimeoutMs,
    }),
  setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
    setTelegramThreadBindingMaxAgeBySessionKey({
      targetSessionKey,
      accountId: accountId ?? undefined,
      maxAgeMs,
    }),
  setIdleTimeoutBySessionKeyAsync: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
    setTelegramThreadBindingIdleTimeoutBySessionKeyAsync({
      targetSessionKey,
      accountId: accountId ?? undefined,
      idleTimeoutMs,
    }),
  setMaxAgeBySessionKeyAsync: ({ targetSessionKey, accountId, maxAgeMs }) =>
    setTelegramThreadBindingMaxAgeBySessionKeyAsync({
      targetSessionKey,
      accountId: accountId ?? undefined,
      maxAgeMs,
    }),
};
