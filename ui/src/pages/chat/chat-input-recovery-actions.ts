import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatMessageGetResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { dismissChatInputRecoveryKey } from "../../app/settings-input-recovery.ts";
import { t } from "../../i18n/index.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { observeOutboxRecoveryOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { readChatRecoveryPayload } from "./chat-input-recovery-payload.ts";
import { resolveSourceMessageId, sameSavedInputSource } from "./chat-message-recovery.ts";
import type { SavedChatInput } from "./chat-saved-inputs.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";

// Same-client panes share action guards, not inspection payloads or queues.
// Other tabs remain independent until an explicit discard or qualified ACK persists.
type Actions = { busy: Set<string>; dismissed: Set<string>; error?: string };
const actions = new WeakMap<object, Map<string, Actions>>();

export type SavedInputActionSource = {
  items: SavedChatInput[];
  /** Confirmed retained page, including rows whose native outbox owns presentation. */
  pageItems: readonly SavedChatInput[];
  current: () => boolean;
  canSend: () => boolean;
  find: (id: string) => SavedChatInput | undefined;
  retireInspection: (id: string) => void;
  requestUpdate: () => void;
};

function currentViewer(host: ChatHost) {
  const viewer = resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser);
  return viewer?.identity ? senderIdentityKey(viewer) : viewer?.id;
}
function localOwner(host: ChatHost, input: SavedChatInput) {
  return input.runId
    ? host.chatQueue.find(
        (item) =>
          item.sendRunId === input.runId &&
          (!item.sessionId || item.sessionId === host.currentSessionId) &&
          visibleSessionMatches(host, item.sessionKey ?? host.sessionKey, item.agentId),
      )
    : undefined;
}

/** Extends the saved-input reader's scope; no independent read cache or custody owner. */
export function createSavedInputActions(host: ChatHost, source: SavedInputActionSource) {
  const client = host.client;
  const recoveryOwner = observeOutboxRecoveryOwner(host);
  const gatewayUrl = host.settings.gatewayUrl ?? "";
  const incognito = host.selectedChatSessionIncognito === true;
  const viewer = currentViewer(host);
  const agentId = resolveUiSelectedSessionAgentId(host);
  const key = JSON.stringify([
    gatewayOriginScope(gatewayUrl),
    recoveryOwner,
    viewer,
    agentId,
    host.sessionKey,
    host.currentSessionId,
    incognito,
  ]);
  if (!client || !recoveryOwner || !host.currentSessionId) {
    return undefined;
  }
  let scopes = actions.get(client);
  if (!scopes) {
    scopes = new Map();
    actions.set(client, scopes);
  }
  let view = scopes.get(key);
  if (!view) {
    view = { busy: new Set(), dismissed: new Set() };
    scopes.set(key, view);
  }
  const state = view;
  const dismissalKey = (id: string) => JSON.stringify([key, id]);
  const hidden = (id: string) =>
    state.dismissed.has(id) ||
    (!incognito && host.settings.chatInputRecoveryDismissed?.includes(dismissalKey(id)) === true);
  const current = () =>
    source.current() &&
    host.canRestoreComposer?.() !== false &&
    host.client === client &&
    host.settings.gatewayUrl === gatewayUrl &&
    (host.selectedChatSessionIncognito === true) === incognito &&
    currentViewer(host) === viewer &&
    observeOutboxRecoveryOwner(host) === recoveryOwner;
  const canSend = () =>
    current() && host.connected && source.canSend() && client.recoveryScopeReady;
  const dismiss = (id: string, persist: boolean) => {
    state.dismissed.add(id);
    source.retireInspection(id);
    if (persist && !incognito && !dismissChatInputRecoveryKey(gatewayUrl, dismissalKey(id))) {
      state.error = t("chat.savedInputs.dismissedStorageFailed");
    }
    source.requestUpdate();
  };
  // Native Retry may rotate its run ID. Retire only this client's duplicate
  // presentation now; a sessionStorage outbox is not another tab's replacement.
  if (current()) {
    for (const input of source.pageItems) {
      if (input.state !== "interrupted" && input.state !== "cancelled") {
        continue;
      }
      const owned = localOwner(host, input);
      if (owned && (owned.sendState === "held" || owned.sendState === "failed")) {
        state.dismissed.add(input.id);
        source.retireInspection(input.id);
      }
    }
  }
  return {
    items: source.items.filter((input) => !hidden(input.id)),
    busyIds: state.busy,
    get error() {
      return state.error;
    },
    canSend: canSend(),
    onDiscard: (input: SavedChatInput) => {
      if (
        current() &&
        !hidden(input.id) &&
        !state.busy.has(input.id) &&
        sameSavedInputSource(source.find(input.id), input)
      ) {
        dismiss(input.id, true);
      }
    },
    onSend: async (input: SavedChatInput) => {
      const id = input.id;
      if (
        !canSend() ||
        hidden(id) ||
        state.busy.has(id) ||
        !sameSavedInputSource(source.find(id), input)
      ) {
        return;
      }
      // A refreshed display can omit metadata already visible in the preview.
      // Validate both; only the fresh, complete read below supplies send bytes.
      if (
        !readChatRecoveryPayload(source.find(id)?.message, "preview") ||
        localOwner(host, input)
      ) {
        state.error = t("chat.savedInputs.cannotSend");
        source.requestUpdate();
        return;
      }
      state.error = undefined;
      state.busy.add(id);
      source.requestUpdate();
      let admitted = false;
      const currentSource = () =>
        canSend() &&
        sameSavedInputSource(source.find(id), input) &&
        Boolean(readChatRecoveryPayload(source.find(id)?.message, "preview"));
      try {
        const messageId = CHAT_PENDING_INPUT_MESSAGE_PREFIX + id;
        const result = await client.request<ChatMessageGetResult>("chat.message.get", {
          sessionKey: host.sessionKey,
          agentId,
          messageId,
          maxChars: 2_000_000,
        });
        if (!currentSource() || hidden(id)) {
          return;
        }
        const payload =
          result.ok && resolveSourceMessageId(result.message) === messageId
            ? readChatRecoveryPayload(result.message)
            : null;
        if (!payload || localOwner(host, input)) {
          state.error = t("chat.savedInputs.cannotSend");
          return;
        }
        await handleSendChat(host, payload, {
          attachmentsOverride: [],
          replyTargetOverride: null,
          onOutboxAdmitted: () => {
            admitted = true;
            dismiss(id, false);
          },
          // Initial delivery only: queued/retry drains deliberately do not retain
          // this callback. Without its ACK, another tab can still recover the source.
          onGatewayAccepted: () => {
            if (currentSource()) {
              dismiss(id, true);
            }
          },
        });
        if (!admitted && currentSource()) {
          state.error = host.chatError ?? host.lastError ?? t("chat.savedInputs.cannotSend");
        }
      } catch {
        if (currentSource() && !admitted) {
          state.error = t("chat.savedInputs.readFailed");
        }
      } finally {
        state.busy.delete(id);
        if (current()) {
          source.requestUpdate();
        }
      }
    },
  };
}
