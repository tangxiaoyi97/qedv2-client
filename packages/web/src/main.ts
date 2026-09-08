import { createApp } from 'vue';
import { createPinia } from 'pinia';
import {
  accountStorageIdentity,
  canonicalServiceBaseUrl,
} from '@qed2/core-logic';
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
import { applyChannelMarker } from './platform/channel.js';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useProgressStore } from './stores/progress.js';
import { useUiStore } from './stores/ui.js';
import { watchForBuildUpdates } from './platform/sw-update.js';
import { installShellCommandRouter } from './platform/shell-commands.js';
import { authStore as authStorage, localProfileStore, ports } from './services.js';
import { useI18n } from './i18n.js';
import { setUiLocale } from '@qed2/ui';

setUiLocale(document.documentElement.lang === 'en' ? 'en' : 'de');
const { t } = useI18n();

/** Drive the boot splash (index.html #boot-bar / #boot-label). */
function bootProgress(pct: number, text: string): void {
  const bar = document.getElementById('boot-bar');
  const label = document.getElementById('boot-label');
  if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(100, pct)) / 100})`;
  if (label) label.textContent = t(text);
}

async function boot(): Promise<void> {
  // Revalidate/move the CSS theme extension before ANY UI paints.
  // Before anything paints: the banner needs the hook, and a preview build
  // must be recognisable from the very first frame.
  applyChannelMarker();
  await prepareThemeBeforeMount();
  bootProgress(12, 'Thema wird angewendet …');

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  const ui = useUiStore();
  await ui.initializeLocale();
  // Ports/config first, then local archive, then token validation — the app
  // is fully usable as a guest even if the network never comes up.
  bootProgress(30, 'Einstellungen werden geladen …');
  const appStore = useAppStore();
  await appStore.init();
  bootProgress(55, 'Fortschritt wird gelesen …');
  const storedSession = await authStorage.getSession();
  const currentServer = canonicalServiceBaseUrl(appStore.config.serverBaseUrl);
  let storedAccountId: string | undefined;
  if (storedSession) {
    try {
      const storedServer = storedSession.serverBaseUrl
        ? canonicalServiceBaseUrl(storedSession.serverBaseUrl)
        : undefined;
      if (storedServer === currentServer) {
        storedAccountId = accountStorageIdentity(storedServer, storedSession.user.id);
      }
    } catch {
      // Auth init clears a malformed/mismatched persisted session. Boot the
      // isolated guest profile first so no account data becomes visible.
    }
  }
  await localProfileStore.initialize(storedAccountId);
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
  // at old hashed chunks. Keep the existing one-reload recovery behavior.
  router.onError((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch dynamically imported module|Failed to fetch|dynamically imported/i.test(message)) {
      window.location.reload();
    }
  });

  bootProgress(100, 'Bereit');
  app.mount('#app');
  const updateVisibility = () => {
    document.documentElement.toggleAttribute('data-page-hidden', document.hidden);
  };
  const onKeyInput = () => { document.documentElement.dataset.inputModality = 'keyboard'; };
  const onPointerInput = () => { document.documentElement.dataset.inputModality = 'pointer'; };
  document.addEventListener('visibilitychange', updateVisibility);
  document.addEventListener('keydown', onKeyInput, true);
  document.addEventListener('pointerdown', onPointerInput, true);
  updateVisibility();
  const removeShellCommandListener = installShellCommandRouter(router);
  const revalidateAccount = () => {
    if (document.visibilityState === 'hidden') return;
    void auth.refreshFromStorage();
  };
  // Final cross-window safety net for browsers whose privacy policy disables
  // both BroadcastChannel and storage events.
  window.addEventListener('focus', revalidateAccount);
  document.addEventListener('visibilitychange', revalidateAccount);
  window.addEventListener('beforeunload', () => {
    removeShellCommandListener();
    window.removeEventListener('focus', revalidateAccount);
    document.removeEventListener('visibilitychange', revalidateAccount);
    document.removeEventListener('visibilitychange', updateVisibility);
    document.removeEventListener('keydown', onKeyInput, true);
    document.removeEventListener('pointerdown', onPointerInput, true);
  }, { once: true });

  // After mount: announce what changed if this is a new build (non-blocking).
  void useUiStore().checkForChangelog();
  // …and keep looking for newer builds, so an installed PWA that never gets
  // closed does not sit on this one forever. Native shells own their update
  // lifecycle and must never race the PWA service-worker poller.
  if (!ports.shell.capabilities.desktop) watchForBuildUpdates();
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
  msg.textContent = t('QED2 konnte nicht gestartet werden.');
  const detail = document.createElement('p');
  detail.style.cssText = 'margin:0;font-size:13px;max-width:40ch';
  detail.textContent =
    t('Lokale Daten konnten nicht geladen werden. Bitte erneut versuchen.');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('Neu laden');
  btn.style.cssText =
    'padding:10px 22px;border-radius:9px;border:none;' +
    'background:var(--q-accent-strong);color:var(--q-on-accent);' +
    'font:600 13.5px system-ui,sans-serif;cursor:pointer';
  btn.addEventListener('click', () => location.reload());
  box.append(msg, detail, btn);
  root.append(box);
}

void boot().catch(showBootError);
