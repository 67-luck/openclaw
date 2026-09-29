import { onTestFinished } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { createChatSavedInputs, type SavedChatInput } from "./chat-saved-inputs.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";

export const savedInput: SavedChatInput = {
  id: "saved",
  runId: "original-run",
  acceptedAt: Date.parse("2026-09-28T18:00:00Z"),
  state: "interrupted",
  message: { role: "user", content: "Saved preview", __openclaw: { id: "pending:saved" } },
};
export const fullInput = {
  ok: true,
  message: {
    role: "user",
    content: "Recovered complete prompt",
    __openclaw: { id: "pending:saved", senderId: "original-author" },
  },
};
export function recoveryFixture(handlers: Record<string, unknown> = {}) {
  const host = makeChatHost({
    sessionKey: "agent:main:recovery",
    currentSessionId: "recovery-physical",
    selfUser: { id: "viewer", name: "Current viewer" },
    settings: loadSettings("ws://recovery.test"),
    chatMessage: "Keep my draft",
    chatAttachments: [
      { id: "draft-file", mimeType: "text/plain", dataUrl: "data:text/plain;base64,ZA==" },
    ],
    chatReplyTarget: {
      messageId: "draft-reply",
      sourceMessageId: "canonical-reply",
      text: "Draft reply",
    },
    requestHandlers: {
      "chat.message.get": fullInput,
      "chat.send": { status: "started", runId: "replacement" },
      ...handlers,
    },
  });
  const abort = new AbortController();
  const props = createChatProps({
    historyState: host,
    savedInputHost: host,
    sessionKey: host.sessionKey,
    readSignal: abort.signal,
    canSend: true,
  });
  const publish = (items: SavedChatInput[]) =>
    applyChatPendingInputs(host, { items, total: items.length });
  publish([savedInput]);
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  onTestFinished(unsubscribe);
  const view = () => createChatSavedInputs(props);
  const send = () => view()?.actions?.onSend(savedInput);
  return { host, props, abort, publish, view, send };
}
