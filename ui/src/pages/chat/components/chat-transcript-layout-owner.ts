import { nothing } from "lit";
import { Directive, directive, type ElementPart } from "lit/directive.js";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";

/** The native scroll range changes only at these viewport and content writes. */
export class TranscriptLayoutOwner {
  private viewport: HTMLDivElement | null = null;
  private observer: ResizeObserver | null = null;
  private readonly rangeHeights = new WeakMap<HTMLElement, number>();

  constructor(private readonly onClamp: (before: number, after: number) => void) {}

  get viewportResizePending(): boolean {
    const viewport = this.viewport;
    const height = viewport?.parentElement?.clientHeight;
    return Boolean(height && height !== viewport?.clientHeight);
  }

  connect(viewport: HTMLDivElement | null): void {
    if (viewport === this.viewport) {
      return;
    }
    this.disconnect();
    this.viewport = viewport;
    const slot = viewport?.parentElement;
    if (!viewport || !slot) {
      return;
    }
    this.observer = new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === slot);
      const size = entry?.borderBoxSize[0];
      if (
        this.viewport !== viewport ||
        !viewport.isConnected ||
        !size?.inlineSize ||
        !size.blockSize
      ) {
        return;
      }
      const style = getComputedStyle(slot);
      const before = viewport.style.height === "" ? null : viewport.scrollTop;
      viewport.style.width = `${size.inlineSize}px`;
      viewport.style.height = `${size.blockSize}px`;
      viewport.style.paddingTop = style.paddingTop;
      viewport.style.paddingBottom = style.paddingBottom;
      if (before !== null) {
        this.publishResize(before);
      }
    });
    this.observer.observe(slot, { box: "border-box" });
  }

  commitRange(element: HTMLElement, height: number): void {
    const previous = this.rangeHeights.get(element);
    if (previous === height) {
      return;
    }
    const shrinking =
      element.parentElement === this.viewport && previous !== undefined && height < previous;
    const before = shrinking ? this.viewport?.scrollTop : undefined;
    this.rangeHeights.set(element, height);
    element.style.height = `${height}px`;
    if (before !== undefined) {
      this.publishResize(before);
    }
  }

  private publishResize(before: number): void {
    const viewport = this.viewport;
    if (!viewport) {
      return;
    }
    const after = viewport.scrollTop;
    if (before !== after) {
      this.onClamp(before, after);
    }
    publishTranscriptScroll(viewport, {
      type: "resize",
      ...(before !== after ? { scrollCorrection: { before, after } } : {}),
    });
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.viewport = null;
  }
}

class TranscriptRangeSize extends Directive {
  render(_owner: TranscriptLayoutOwner, _height: number) {
    return nothing;
  }

  override update(part: ElementPart, [owner, height]: [TranscriptLayoutOwner, number]) {
    if (part.element instanceof HTMLElement) {
      owner.commitRange(part.element, height);
    }
    return nothing;
  }
}

export const transcriptRangeSize = directive(TranscriptRangeSize);
