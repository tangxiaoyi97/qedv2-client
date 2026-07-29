/**
 * Keeps a long-lived installed PWA from getting stranded on an old build.
 *
 * The service worker is registered with `registerType: 'autoUpdate'`, but the
 * browser only looks for a new worker on navigation — and a standalone PWA
 * that is never fully closed may not navigate for weeks. Nothing else in the
 * app polls, so an installed client could sit on a stale build indefinitely.
 *
 * This only asks the browser to re-check. It deliberately does NOT force a
 * reload: the new worker claims the page on activation, and the existing
 * chunk-404 guard in main.ts already recovers the one case that breaks
 * (a lazy route whose old chunk is gone). Reloading under someone mid-answer
 * would be worse than the staleness it cures.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Coming back to the app checks too, but not more often than this. */
const MIN_CHECK_GAP_MS = 15 * 60 * 1000;

export function watchForBuildUpdates(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  let lastCheck = 0;

  const check = (): void => {
    const now = Date.now();
    if (now - lastCheck < MIN_CHECK_GAP_MS) return;
    lastCheck = now;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => undefined); // offline is the normal case, not an error
  };

  window.setInterval(check, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}
