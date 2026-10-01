import type {
  ChannelAccountSnapshot,
  ChannelRuntimeSurface,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotInfo } from "./bot-info.js";

export type MonitorTelegramOpts = {
  scheduler: PluginServiceSchedulerV1;
  token?: string;
  accountId?: string;
  ownerAgentId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  legacyWebhook?: false | { port: number; host?: string };
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
  webhookCertPath?: string;
  botInfo?: TelegramBotInfo;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
};

export type TelegramMonitorFn = (opts: MonitorTelegramOpts) => Promise<void>;
