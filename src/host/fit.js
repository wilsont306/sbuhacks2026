// The part of the browser viewport that is really on screen, for host.css's frame fit. A window can be taller than the
// screen or run under the taskbar; its viewport then reports more height than anyone sees, and a frame fitted to the
// viewport loses its bottom. This clips the viewport to the screen's work area (screen.avail*, which leaves out the
// taskbar). A fullscreen window (F11, kiosk) covers the taskbar, so it keeps the whole viewport. Pure, for node:test.
export function visibleArea(w, s) {
  const z = w.outerWidth / w.innerWidth || 1; // page zoom: window sizes are screen px, inner sizes page px
  const vw = w.innerWidth * z, vh = w.innerHeight * z; // the viewport in screen px
  const bars = w.outerHeight - vh; // the browser's own bars, above the page
  // Fullscreen: no bars and the whole screen. (A screen-sized page under bars is a window running off the screen.)
  if (bars <= 1 && vw >= s.width && vh >= s.height) return { width: w.innerWidth, height: w.innerHeight };
  const top = w.screenY + bars;
  const height = Math.min(vh, (s.availTop || 0) + s.availHeight - top);
  const width = Math.min(vw, (s.availLeft || 0) + s.availWidth - w.screenX);
  // A window mostly off screen (or odd numbers from the browser) never shrinks the frame below a quarter.
  return { width: Math.max(width, vw / 4) / z, height: Math.max(height, vh / 4) / z };
}

// Publishes the visible area as --vis-w / --vis-h on the root, now and whenever it may change. Moving a window fires
// no event, so a slow poll catches that.
export function trackVisible(root = document.documentElement) {
  const set = () => {
    const a = visibleArea(window, window.screen);
    root.style.setProperty('--vis-w', `${a.width}px`);
    root.style.setProperty('--vis-h', `${a.height}px`);
  };
  set();
  addEventListener('resize', set);
  setInterval(set, 1000);
}
