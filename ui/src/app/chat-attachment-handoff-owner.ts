import type { ApplicationChatAttachmentHandoff, ChatAttachmentHandoff } from "./context.ts";
import type { ApplicationGateway } from "./gateway.ts";

/** Keep empty startup state cheap; loaded routes synchronously supply the single handoff owner. */
export function createApplicationChatAttachmentHandoff(
  gateway: ApplicationGateway,
): ApplicationChatAttachmentHandoff {
  let owner: ChatAttachmentHandoff | undefined;
  let disposed = false;
  return {
    prepare(handoff, create) {
      if (!owner) {
        owner = create(gateway);
        if (disposed) {
          owner.dispose();
        }
      }
      // No import or await can lose an unmount handoff or need a deleted post-update chunk.
      owner.prepare(handoff);
    },
    consume: (handoff) => owner?.consume(handoff) ?? null,
    retainedAttachmentIds: (attachments) => owner?.retainedAttachmentIds(attachments) ?? new Set(),
    retireScope: (scopeKey, beforeRevision) => owner?.retireScope(scopeKey, beforeRevision),
    clearPane: (paneId) => owner?.clearPane(paneId),
    dispose() {
      disposed = true;
      owner?.dispose();
    },
  };
}
