import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/public-sans/800.css';
import '@qed2/ui/styles';
import './styles/app.css';
import App from './App.vue';
import { router } from './router.js';
import { prepareThemeBeforeMount } from './platform/theme.js';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useProgressStore } from './stores/progress.js';
import { useUiStore } from './stores/ui.js';

/** Drive the boot splash (index.html #boot-bar / #boot-label). */
function bootProgress(pct: number, text: string): void {
  const bar = document.getElementById('boot-bar');
  const label = document.getElementById('boot-label');
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = text;
}

async function boot(): Promise<void> {
  // Revalidate/move the CSS theme extension before ANY UI paints.
  await prepareThemeBeforeMount();
  bootProgress(12, 'Thema wird angewendet …');

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);

  // Ports/config first, then local archive, then token validation — the app
  // is fully usable as a guest even if the network never comes up.
  bootProgress(30, 'Einstellungen werden geladen …');
  const appStore = useAppStore();
  await appStore.init();
  bootProgress(55, 'Fortschritt wird gelesen …');
  const progress = useProgressStore();
  await progress.init();
  bootProgress(78, 'Konto wird geprüft …');
  const auth = useAuthStore();
  await auth.init();
  if (auth.isLoggedIn) {
    void progress.flushAttemptOutbox();
    void progress.syncNow({ quiet: true, compareChecksum: true });
  }

  // After a deploy, long-lived sessions can hold a router that still points
  // at the OLD hashed chunks (now replaced) — a lazy route import then 404s
  // and the app dies on a blank screen. Reload once to fetch the new build.
  router.onError((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    if (/fetch dynamically imported module|Failed to fetch|dynamically imported/i.test(msg)) {
      window.location.reload();
    }
  });

  bootProgress(100, 'Bereit');
  app.mount('#app');

  // After mount: announce what changed if this is a new build (non-blocking).
  void useUiStore().checkForChangelog();
}

function showBootError(err: unknown): void {
  console.error('[qed2] boot failed', err);
  const root = document.getElementById('app');
  if (!root) return;
  // Replace the infinite spinner with an actionable error — a wedged
  // IndexedDB or a broken port must never leave the user staring at a
  // loading animation forever.
  root.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'min-height:100vh;min-height:100dvh;gap:12px;padding:24px;text-align:center;' +
    'font-family:system-ui,sans-serif;color:var(--q-mut);background:var(--q-page)';
  const msg = document.createElement('p');
  msg.style.cssText = 'margin:0;font-size:15px;font-weight:600;color:var(--q-ink)';
  msg.textContent = 'QED2 konnte nicht gestartet werden.';
  const detail = document.createElement('p');
  detail.style.cssText = 'margin:0;font-size:13px;max-width:40ch';
  detail.textContent =
    'Beim Laden der lokalen Daten ist ein Fehler aufgetreten. Ein Neuladen behebt das Problem meist.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Neu laden';
  btn.style.cssText =
    'padding:10px 22px;border-radius:9px;border:none;' +
    'background:var(--q-accent-strong);color:var(--q-on-accent);' +
    'font:600 13.5px system-ui,sans-serif;cursor:pointer';
  btn.addEventListener('click', () => location.reload());
  box.append(msg, detail, btn);
  root.append(box);
}

void boot().catch(showBootError);
