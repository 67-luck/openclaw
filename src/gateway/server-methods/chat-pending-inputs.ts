import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatPendingInputsPage } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  listSessionPendingInputs,
  type SessionPendingInput,
} from "../../config/sessions/session-accessor.js";
import { prepareActiveSessionPendingInputsInWorker } from "../../config/sessions/session-active-pending-inputs.js";
import { prepareForwardedMessageCronJobNameResolver } from "../chat-display-projection.history.js";
import {
  createCurrentUserProfileMessageProjector,
  projectChatDisplayMessage,
} from "../chat-display-projection.js";
import { isQueuedChatTurnForSession, type QueuedChatTurnMap } from "../chat-queued-turns.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { replaceOversizedChatHistoryMessages } from "./chat-history-budget.js";

const PENDING_INPUT_DISPLAY_MAX_BYTES = 128 * 1024;
// Correlation is useful for browser UUIDs, but arbitrary external run IDs must
// not turn a bounded display page into an unbounded payload. Never truncate IDs.
const PENDING_INPUT_CORRELATION_MAX_CHARS = 256;

export function projectPendingInputMessage(
  input: SessionPendingInput,
  maxChars: number,
  projectProfile = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay),
  resolveCronJobName?: (jobId: string) => string | undefined,
) {
  if (input.state === "cancelled" && input.message.display === false) {
    // Retire retained client copies without returning a withdrawn prompt's content.
    return {
      role: "user",
      content: [],
      display: false,
      timestamp: input.acceptedAt,
      __openclaw: { id: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${input.id}` },
    };
  }
  const projected = projectChatDisplayMessage(input.message, { maxChars, resolveCronJobName });
  const message = projected ? projectProfile(projected) : undefined;
  if (!message) {
    return undefined;
  }
  const metadata = { ...asOptionalRecord(message["__openclaw"]) };
  delete metadata.idempotencyKey;
  delete metadata.runId;
  return {
    ...message,
    timestamp: input.acceptedAt,
    idempotencyKey: undefined,
    __openclaw: { ...metadata, id: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${input.id}` },
  };
}

export async function prepareChatPendingInputs(
  scope: Parameters<typeof listSessionPendingInputs>[0],
  options: {
    before?: number;
    queueBefore?: number;
    limit: number;
    maxChars: number;
    queuedTurns?: QueuedChatTurnMap;
    cronStorePath?: string;
  },
): Promise<() => ChatPendingInputsPage> {
  const page = listSessionPendingInputs(scope, {
    before: options.before,
    limit: Math.min(options.limit, 20),
  });
  const separateQueue =
    page.nextBefore !== undefined ||
    options.before !== undefined ||
    options.queueBefore !== undefined;
  const active = await prepareActiveSessionPendingInputsInWorker(scope, {
    before: options.queueBefore,
    limit: 20,
    ...(!separateQueue ? { page } : {}),
  });
  const queue = separateQueue ? active.page : undefined;
  const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
    [...page.items, ...(queue?.items ?? [])].map((input) => input.message),
    options.cronStorePath,
  );
  const projectProfile = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  const project = (items: SessionPendingInput[]): ChatPendingInputsPage["items"] => {
    const visible = active.selectCurrent(items).flatMap((input) => {
      const message = projectPendingInputMessage(
        input,
        options.maxChars,
        projectProfile,
        resolveCronJobName,
      );
      return message ? [{ input, message }] : [];
    });
    const messages = replaceOversizedChatHistoryMessages({
      messages: visible.map(({ message }) => message),
      maxSingleMessageBytes: Math.floor(
        PENDING_INPUT_DISPLAY_MAX_BYTES / Math.max(items.length, 1),
      ),
    }).messages;
    return visible.map(({ input: item }, index) => {
      const display: ChatPendingInputsPage["items"][number] = {
        id: item.id,
        acceptedAt: item.acceptedAt,
        state: item.state,
        message: messages[index],
      };
      if (item.runId.length <= PENDING_INPUT_CORRELATION_MAX_CHARS) {
        display.runId = item.runId;
        if (
          item.state === "queued" &&
          isQueuedChatTurnForSession(options.queuedTurns, item.runId, scope)
        ) {
          display.queued = true;
        }
      }
      return display;
    });
  };
  return () => {
    let queuedCount = 0;
    for (const runId of options.queuedTurns?.keys() ?? []) {
      if (
        runId.length <= PENDING_INPUT_CORRELATION_MAX_CHARS &&
        isQueuedChatTurnForSession(options.queuedTurns, runId, scope)
      ) {
        queuedCount += 1;
      }
    }
    return {
      ...page,
      ...(options.queuedTurns ? { queuedCount } : {}),
      items: project(page.items),
      ...(queue ? { queue: { ...queue, items: project(queue.items) } } : {}),
    };
  };
}
