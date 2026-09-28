import type { Virtualizer } from "@tanstack/virtual-core";
import {
  captureChatSessionScrollPosition,
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  type ChatSessionScrollPosition,
} from "../scroll.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import { activeTranscriptMessageId } from "./chat-transcript-position.ts";
import { captureTranscriptMessageAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES,
  CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES,
  type ChatTranscriptPendingScrollOffset,
  type TranscriptCallbacks,
} from "./chat-transcript-session.ts";

type TranscriptScrollRestoreHost = {
  readonly offsetState: { pendingScrollOffset: ChatTranscriptPendingScrollOffset | null };
  getScrollElement(): HTMLDivElement | null;
  isContentReady(): boolean;
  getRowCount(): number;
  readonly virtualizer: Pick<
    Virtualizer<HTMLDivElement, HTMLElement>,
    "scrollToOffset" | "scrollToIndex" | "getVirtualItemForOffset"
  >;
  getMessageRowIndex(messageKey: string): number | undefined;
  measureRows(): boolean;
  isConnected(): boolean;
  pendingFrame: number | null;
  requestUpdate(): void;
  onRestored(position: ChatSessionScrollPosition): void;
};

type TranscriptScrollRestoreOwner = Omit<
  TranscriptScrollRestoreHost,
  "getMessageRowIndex" | "pendingFrame" | "onRestored"
> & {
  getMessageRows(): ReadonlyMap<string, string>;
  getRowIndexes(): ReadonlyMap<string, number>;
  getMessageRowKeysById(): ReadonlyMap<string, string>;
  isMaintenanceScroll(): boolean;
  cancelScroll(): void;
  onRestoreStarted(): void;
};

/** One lifecycle for cached bookmarks, hidden suspension, and measurable restoration. */
export class TranscriptScrollRestoration {
  private presented: boolean;
  private readonly restoreHost: TranscriptScrollRestoreHost;

  constructor(
    private readonly owner: TranscriptScrollRestoreOwner,
    initialPosition: ChatSessionScrollPosition | undefined,
    private readonly onPositionSaved: ((position: ChatSessionScrollPosition) => void) | undefined,
    private readonly callbacks: TranscriptCallbacks,
  ) {
    this.presented = this.isPresented;
    this.restoreHost = {
      ...owner,
      getMessageRowIndex: (key) => {
        const rowKey = owner.getMessageRows().get(key);
        return rowKey === undefined ? undefined : owner.getRowIndexes().get(rowKey);
      },
      pendingFrame: null,
      onRestored: (position) => callbacks.onPositionRestored?.(position),
    };
    if (initialPosition && !initialPosition.anchorToEnd) {
      this.restore(initialPosition, onPositionSaved);
    }
  }

  get isPresented(): boolean {
    return this.callbacks.visuallyPresented?.() ?? true;
  }

  get rowKey(): string | null {
    const key = this.owner.offsetState.pendingScrollOffset?.messageAnchor?.messageKey;
    return key ? (this.owner.getMessageRows().get(key) ?? null) : null;
  }

  activeMessageId(messageIds: readonly string[]): string | null {
    return activeTranscriptMessageId(
      this.owner.getScrollElement(),
      this.owner.virtualizer,
      messageIds,
      this.owner.getMessageRowKeysById(),
      this.owner.getRowIndexes(),
    );
  }

  private capture(departing: boolean): ChatSessionScrollPosition | undefined {
    const element = this.owner.getScrollElement();
    if (!element?.clientHeight) {
      return undefined;
    }
    const position = captureChatSessionScrollPosition(element);
    position.anchorToEnd &&= this.callbacks.canFollowEnd?.() ?? true;
    // Native scroll bookkeeping is constant work. A large grouped run can have
    // many bubbles inside one virtual row; scan them only at departure.
    const anchor =
      departing && !position.anchorToEnd
        ? captureTranscriptMessageAnchor(element, this.owner.getMessageRows())
        : null;
    if (anchor) {
      position.messageAnchor = {
        messageKey: anchor.messageKey,
        offset: anchor.top - element.getBoundingClientRect().top,
      };
    }
    return position;
  }

  save(departing = false): void {
    if (
      !this.isPresented ||
      this.owner.offsetState.pendingScrollOffset ||
      this.owner.isMaintenanceScroll()
    ) {
      return;
    }
    const position = this.capture(departing);
    if (position) {
      this.onPositionSaved?.(position);
    }
  }

  /** Called before Lit removes viewport-affecting presentation chrome. */
  prepareUpdate(): void {
    const presented = this.isPresented;
    if (this.presented && !presented && !this.owner.offsetState.pendingScrollOffset) {
      const position = this.capture(true);
      if (position) {
        this.onPositionSaved?.(position);
        this.owner.cancelScroll();
        this.restore(position, this.onPositionSaved);
      }
    }
    this.presented = presented;
  }

  restore(
    position: Omit<ChatSessionScrollPosition, "anchorToEnd"> & { anchorToEnd?: boolean },
    onSettled?: (position: ChatSessionScrollPosition) => void,
  ): void {
    this.owner.onRestoreStarted();
    this.owner.offsetState.pendingScrollOffset = {
      offset: position.scrollTop,
      messageAnchor: position.messageAnchor,
      anchorToEnd: position.anchorToEnd,
      stableFrames: 0,
      zeroMaxFrames: 0,
      onSettled,
    };
    this.owner.requestUpdate();
  }

  update(): void {
    applyPendingScrollOffset(this.restoreHost);
  }

  disconnect(): void {
    if (this.restoreHost.pendingFrame !== null) {
      cancelAnimationFrame(this.restoreHost.pendingFrame);
      this.restoreHost.pendingFrame = null;
    }
  }

  cancel(): void {
    this.owner.offsetState.pendingScrollOffset = null;
    this.disconnect();
  }
}

function applyPendingScrollOffset(owner: TranscriptScrollRestoreHost): void {
  const pending = owner.offsetState.pendingScrollOffset;
  if (!pending || !owner.isConnected()) {
    return;
  }
  if (owner.isContentReady() && owner.getRowCount() === 0) {
    settlePendingScroll(owner, 0);
    return;
  }
  const maxOffset = maxTranscriptScrollOffset(owner.getScrollElement());
  if (maxOffset === null) {
    pending.observedMaxOffset = undefined;
    pending.stableFrames = 0;
    pending.zeroMaxFrames = 0;
    return;
  }
  if (maxOffset === 0 && pending.offset > 0) {
    pending.observedMaxOffset = undefined;
    pending.stableFrames = 0;
    if (owner.isContentReady()) {
      if (pending.zeroMaxFrames >= CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES) {
        settlePendingScroll(owner, 0);
      } else {
        schedulePendingScrollRetry(owner);
      }
    }
    return;
  }
  pending.zeroMaxFrames = 0;
  if (pending.messageAnchor && restoreMessageAnchor(owner, maxOffset)) {
    return;
  }
  const requestedOffset = pending.anchorToEnd ? maxOffset : pending.offset;
  if (maxOffset < requestedOffset) {
    if (pending.observedMaxOffset !== maxOffset) {
      pending.observedMaxOffset = maxOffset;
      pending.stableFrames = 0;
    }
    if (pending.stableFrames <= CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES) {
      schedulePendingScrollRetry(owner);
      return;
    }
  }
  const targetOffset = Math.min(requestedOffset, maxOffset);
  const element = owner.getScrollElement();
  if (element) {
    element.scrollTop = targetOffset;
  }
  owner.virtualizer.scrollToOffset(targetOffset);
  const currentOffset = owner.getScrollElement()?.scrollTop;
  if (currentOffset != null) {
    settlePendingScroll(owner, currentOffset);
  } else {
    schedulePendingScrollRetry(owner);
  }
}

/** Resolve a saved bubble through the current row projection, not old estimated pixels. */
function restoreMessageAnchor(owner: TranscriptScrollRestoreHost, maxOffset: number): boolean {
  const pending = owner.offsetState.pendingScrollOffset;
  const anchor = pending?.messageAnchor;
  const element = owner.getScrollElement();
  if (!pending || !anchor || !element) {
    return false;
  }
  const index = owner.getMessageRowIndex(anchor.messageKey);
  if (index === undefined) {
    // A preload may not contain the bookmarked page yet. Only authoritative
    // content can retire a missing/deleted message and use the numeric fallback.
    if (!owner.isContentReady()) {
      return true;
    }
    pending.messageAnchor = undefined;
    return false;
  }
  if (owner.measureRows()) {
    pending.stableFrames = 0;
    schedulePendingScrollRetry(owner);
    return true;
  }
  const bubble = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].find(
    (candidate) => candidate.dataset.messageId === anchor.messageKey,
  );
  if (!bubble) {
    // The range extractor retains the target row. Folded/deleted bubbles can
    // still be absent inside that row: use the existing bounded settling window.
    if (pending.stableFrames > CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES) {
      pending.messageAnchor = undefined;
      return false;
    }
    owner.virtualizer.scrollToIndex(index, { align: "start", behavior: "instant" });
    schedulePendingScrollRetry(owner);
    return true;
  }
  const delta =
    bubble.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
  const target = Math.max(0, Math.min(maxOffset, element.scrollTop + delta));
  if (Math.abs(target - element.scrollTop) > 1) {
    owner.virtualizer.scrollToOffset(target, { behavior: "instant" });
    schedulePendingScrollRetry(owner);
    return true;
  }
  // A correction needs another committed range to expose and measure the rows
  // it reveals. Once that commit is unchanged, retire restoration completely.
  settlePendingScroll(owner, element.scrollTop);
  return true;
}

function schedulePendingScrollRetry(owner: TranscriptScrollRestoreHost): void {
  if (!owner.isConnected() || owner.pendingFrame !== null) {
    return;
  }
  owner.pendingFrame = requestAnimationFrame(() => {
    owner.pendingFrame = null;
    const pending = owner.offsetState.pendingScrollOffset;
    if (owner.isConnected() && pending) {
      const maxOffset = maxTranscriptScrollOffset(owner.getScrollElement());
      if (pending.messageAnchor) {
        pending.stableFrames += 1;
      }
      if (maxOffset === 0 && pending.offset > 0 && owner.isContentReady()) {
        pending.zeroMaxFrames += 1;
      } else if (
        maxOffset !== null &&
        maxOffset > 0 &&
        maxOffset < pending.offset &&
        maxOffset === pending.observedMaxOffset
      ) {
        pending.stableFrames += 1;
      }
      owner.requestUpdate();
    }
  });
}

function settlePendingScroll(owner: TranscriptScrollRestoreHost, scrollTop: number): void {
  const pending = owner.offsetState.pendingScrollOffset;
  owner.offsetState.pendingScrollOffset = null;
  if (!pending) {
    return;
  }
  const maxScrollTop = maxTranscriptScrollOffset(owner.getScrollElement());
  const position: ChatSessionScrollPosition = {
    scrollTop,
    anchorToEnd: pending.messageAnchor
      ? false
      : (pending.anchorToEnd ??
        (maxScrollTop === null
          ? owner.isContentReady() && owner.getRowCount() === 0
          : maxScrollTop - scrollTop <= CHAT_TRANSCRIPT_END_THRESHOLD_PX)),
    ...(pending.messageAnchor ? { messageAnchor: pending.messageAnchor } : {}),
  };
  pending.onSettled?.(position);
  // Restore explicit intent before queued hydration/resize follow can run.
  owner.onRestored(position);
}
