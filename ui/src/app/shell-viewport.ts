/** Keep the shell's bottom inside the visible viewport without moving fixed menus. */
export function connectShellViewport(host: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) {
    return () => {};
  }
  const events = new AbortController();
  let frame: number | null = null;
  const update = () => {
    frame = null;
    // Pinch zoom is magnification/panning, not a smaller layout. Keep the
    // layout viewport budget (including body insets) instead of resizing to it.
    // Safari's keyboard changes height/offsetTop without changing scale.
    const viewportBottom =
      viewport.scale === 1
        ? viewport.height + viewport.offsetTop
        : document.documentElement.clientHeight || window.innerHeight;
    // offsetTop is in layout-viewport coordinates. Using height alone lifts
    // the footer twice when Safari pans the viewport to reveal the caret.
    // Standalone mode gives body the notch/home-bar insets and removes the
    // composer's duplicate gap. Neither body inset is available to the shell.
    const bodyStyle = getComputedStyle(document.body);
    const bodyInsets =
      (Number.parseFloat(bodyStyle.paddingTop) || 0) +
      (Number.parseFloat(bodyStyle.paddingBottom) || 0);
    host.style.setProperty(
      "--shell-viewport-height",
      `${Math.max(0, viewportBottom - bodyInsets)}px`,
    );
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(update);
  };
  const options = { signal: events.signal };
  viewport.addEventListener("resize", schedule, options);
  viewport.addEventListener("scroll", schedule, options);
  window.addEventListener("resize", schedule, options);
  update();
  return () => {
    events.abort();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    host.style.removeProperty("--shell-viewport-height");
  };
}
