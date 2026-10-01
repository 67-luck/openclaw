import { logVerbose } from "../../globals.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import { isAudioPayload } from "./agent-runner-helpers.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import {
  type CompactionNoticePhase,
  createCompactionNoticePayload,
  shouldNotifyUserAboutCompaction,
} from "./compaction-notice.js";
import type { createReplyToModeFilterForChannel } from "./reply-threading.js";

export function prepareReplyStreamingDelivery(
  params: Pick<
    RunReplyAgentParams,
    "opts" | "sessionCtx" | "blockStreamingEnabled" | "blockReplyChunking"
  > & {
    cfg: RunReplyAgentParams["followupRun"]["run"]["config"];
    blockReplyTimeoutMs: number;
    applyReplyToMode: ReturnType<typeof createReplyToModeFilterForChannel>;
  },
) {
  const { opts, sessionCtx, cfg, applyReplyToMode, blockStreamingEnabled, blockReplyChunking } =
    params;
  const { blockReplyTimeoutMs } = params;
  const compactionNoticeMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  const sendDirectCompactionNotice = shouldNotifyUserAboutCompaction(cfg)
    ? async (phase: CompactionNoticePhase, text?: string) => {
        if (!opts?.onBlockReply) {
          return;
        }
        const noticePayload = createCompactionNoticePayload({
          phase,
          text,
          currentMessageId: compactionNoticeMessageId,
          applyReplyToMode,
        });
        try {
          await opts.onBlockReply(noticePayload);
        } catch (err) {
          logVerbose(`context maintenance notice delivery failed: ${String(err)}`);
        }
      }
    : undefined;
  const blockReplyCoalescing =
    blockStreamingEnabled && (opts?.onPreparedBlockReply || opts?.onBlockReply)
      ? resolveEffectiveBlockStreamingConfig({
          cfg,
          provider: sessionCtx.Provider,
          accountId: sessionCtx.AccountId,
          chunking: blockReplyChunking,
        }).coalescing
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && (opts?.onPreparedBlockReply || opts?.onBlockReply)
      ? createBlockReplyPipeline({
          onBlockReply: async (payload, context) => {
            if (opts.onPreparedBlockReply) {
              for (const plan of createStructuredOutboundPayloadPlan([payload])) {
                await opts.onPreparedBlockReply(plan, context);
              }
              return;
            }
            await opts.onBlockReply?.(payload, context);
          },
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  return { sendDirectCompactionNotice, blockReplyPipeline };
}
