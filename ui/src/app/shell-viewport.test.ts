/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectShellViewport } from "./shell-viewport.ts";

let host: HTMLElement;
let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
let disconnect: (() => void) | undefined;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
const height = () => host.style.getPropertyValue("--shell-viewport-height");
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) {
    callback(0);
  }
}
function resize(values: Partial<typeof viewport>, event = "resize") {
  Object.assign(viewport, values);
  viewport.dispatchEvent(new Event(event));
  flush();
}

beforeEach(() => {
  host = document.createElement("div");
  viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  frames = new Map();
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  document.body.style.paddingTop = "";
  document.body.style.paddingBottom = "";
  vi.unstubAllGlobals();
});

describe("shell visual viewport", () => {
  it("tracks keyboard open/close, viewport pan, rotation, and content-resizing browsers", () => {
    disconnect = connectShellViewport(host);
    expect(height()).toBe("844px");
    resize({ height: 480 });
    expect(height()).toBe("480px");
    resize({ height: 440, offsetTop: 70 }, "scroll");
    expect(height()).toBe("510px");
    resize({ height: 844, offsetTop: 0 });
    expect(height()).toBe("844px");
    Object.assign(viewport, { height: 250 });
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(height()).toBe("250px");
    resize({ height: 390 });
    expect(height()).toBe("390px");
  });

  it("leaves pinch zoom to the browser and resumes at native scale", () => {
    disconnect = connectShellViewport(host);
    resize({ height: 422, scale: 2, offsetTop: 50 });
    expect(height()).toBe("844px");
    resize({ height: 480, scale: 1, offsetTop: 0 });
    expect(height()).toBe("480px");
  });

  it("accounts for standalone safe-area padding without a focus heuristic", () => {
    document.body.style.paddingTop = "47px";
    document.body.style.paddingBottom = "34px";
    disconnect = connectShellViewport(host);
    expect(height()).toBe("763px");
    resize({ height: 480 });
    expect(height()).toBe("399px");
    resize({ height: 844 });
    resize({ height: 422, scale: 2, offsetTop: 50 });
    expect(height()).toBe("763px");
  });

  it("coalesces events and cancels queued updates and listeners on disconnect", () => {
    disconnect = connectShellViewport(host);
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    disconnect();
    expect(frames.size).toBe(0);
    expect(height()).toBe("");
    resize({ height: 480 });
    expect(height()).toBe("");
    disconnect = connectShellViewport(host);
    expect(height()).toBe("480px");
  });

  it("retains the CSS fallback when VisualViewport is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    disconnect = connectShellViewport(host);
    window.dispatchEvent(new Event("resize"));
    expect(height()).toBe("");
    expect(frames.size).toBe(0);
  });
});
