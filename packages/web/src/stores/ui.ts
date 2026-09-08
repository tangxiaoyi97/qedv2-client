/**
 * UI-chrome store: cross-page interface state (login/register modal —
 * grading supplement §10: authentication is a modal, not a page).
 */
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { setUiLocale } from '@qed2/ui';
import { translate, type Locale, type MessageKey } from '../i18n.js';
import { entriesToAnnounce, parseChangelogIndex, type ChangelogEntry } from '../changelog.js';
import { APP_VERSION, ports, storage } from '../services.js';

const LOCALE_KEY = 'qed2.locale';
const LAST_SEEN_VERSION_KEY = 'qed2.lastSeenVersion';
/** Pre-2.0 marker. Read once, to tell an upgrader from a fresh install. */
const LEGACY_LAST_SEEN_COMMIT_KEY = 'qed2.lastSeenCommit';

/** Build commit baked in by vite (define). 'dev' when built without git. */
const APP_COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';

function initialLocale(): Locale {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(LOCALE_KEY) === 'en' ? 'en' : 'de';
  } catch {
    return 'de';
  }
}

export const useUiStore = defineStore('ui', () => {
  const authModalOpen = ref(false);
  /** Which face of the modal is showing (switches in place, §10). */
  const authModalMode = ref<'login' | 'register'>('login');
  const locale = ref<Locale>(initialLocale());
  const t = computed(() => (key: MessageKey) => translate(locale.value, key));
  let localeWriteTail = Promise.resolve();
  let localeChange = 0;

  function applyLocale(next: Locale): void {
    locale.value = next;
    setUiLocale(next);
    if (typeof document !== 'undefined') document.documentElement.lang = next;
    try { window.localStorage.setItem(LOCALE_KEY, next); } catch { /* Session language still works. */ }
  }

  watch(locale, (next) => {
    setUiLocale(next);
    if (typeof document !== 'undefined') document.documentElement.lang = next;
  }, { immediate: true, flush: 'sync' });

  function setLocale(next: Locale): void {
    if (next !== 'de' && next !== 'en') return;
    localeChange += 1;
    applyLocale(next);
    if (ports.shell.capabilities.desktop) {
      // Persist in the native profile too: UI port changes must not reset language.
      localeWriteTail = localeWriteTail.catch(() => {}).then(() => storage.set('config', 'locale', next));
      void localeWriteTail.catch(() => {});
    }
  }

  async function initializeLocale(resetMissing = false): Promise<void> {
    if (!ports.shell.capabilities.desktop) return;
    const revision = localeChange;
    try {
      const saved = await storage.get<unknown>('config', 'locale');
      if (revision === localeChange) {
        if (saved === 'en' || saved === 'de') applyLocale(saved);
        else if (resetMissing) applyLocale('de');
      }
    } catch { /* Retain the last browser-side selection if native storage is unavailable. */ }
  }

  if (typeof window !== 'undefined') {
    const onLanguageChange = (event: StorageEvent): void => {
      if (event.key === LOCALE_KEY || event.key === null) {
        localeChange += 1;
        const next = event.key === null ? 'de' : event.newValue === 'en' ? 'en' : 'de';
        locale.value = next;
      }
    };
    window.addEventListener('storage', onLanguageChange);
    onScopeDispose(() => window.removeEventListener('storage', onLanguageChange));
  }
  if (ports.shell.capabilities.desktop && storage.onChange) {
    const unsubscribe = storage.onChange((change) => {
      if (change.collection === 'config' && (change.key === 'locale' || change.operation === 'clear')) {
        void initializeLocale(change.operation === 'delete' || change.operation === 'clear');
      }
    });
    onScopeDispose(unsubscribe);
  }

  function openAuthModal(mode: 'login' | 'register' = 'login'): void {
    authModalMode.value = mode;
    authModalOpen.value = true;
  }

  function closeAuthModal(): void {
    authModalOpen.value = false;
  }

  /* ---- changelog ---- */

  /** All released notes, newest first. Fetched once, then reused. */
  const changelogIndex = ref<ChangelogEntry[] | null>(null);
  /** What the dialog is currently showing; empty means closed. */
  const changelogShown = ref<ChangelogEntry[]>([]);
  const changelogOpen = computed(() => changelogShown.value.length > 0);

  function lastSeenVersion(): string | null {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(LAST_SEEN_VERSION_KEY);
    if (stored !== null) return stored;
    /*
     * Migration off the commit-keyed marker. A commit cannot be mapped to a
     * version, but its presence proves this browser ran an older build — so
     * treat it as "seen something unknown", which announces this version only.
     * A fresh install has neither key and is adopted silently.
     */
    return window.localStorage.getItem(LEGACY_LAST_SEEN_COMMIT_KEY) === null ? null : '';
  }

  function rememberVersion(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION);
    window.localStorage.removeItem(LEGACY_LAST_SEEN_COMMIT_KEY);
  }

  /**
   * Load the index. Cached in memory; a network failure returns null and is
   * NOT remembered, so the next load retries rather than losing the notes.
   */
  async function loadChangelogIndex(): Promise<ChangelogEntry[] | null> {
    if (changelogIndex.value !== null) return changelogIndex.value;
    const base = import.meta.env.BASE_URL || '/';
    try {
      const res = await fetch(`${base}changelogs/index.json`, {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) return null;
      const parsed = parseChangelogIndex(await res.text());
      if (parsed === null) return null;
      changelogIndex.value = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * On first load after an update, announce the running version — and only it.
   *
   * Older notes are not lost the way they used to be; they are in the settings
   * page, which now has the whole history because every deploy ships it.
   */
  async function checkForChangelog(): Promise<void> {
    const seen = lastSeenVersion();
    if (seen === APP_VERSION) return;

    const entries = await loadChangelogIndex();
    if (entries === null) return; // offline — retry next load, stay un-remembered

    const announce = entriesToAnnounce(entries, APP_VERSION, seen);
    if (announce.length === 0) {
      rememberVersion(); // nothing to say for this build — don't ask again
      return;
    }
    changelogShown.value = announce;
    // remembered only when the user dismisses (closeChangelog)
  }

  function closeChangelog(): void {
    changelogShown.value = [];
    rememberVersion();
  }

  /**
   * Settings button: the full history, every version the app has ever shipped.
   *
   * Now possible at all because the whole file ships on every deploy. Returns
   * false only when the index cannot be reached.
   */
  async function showChangelogHistory(): Promise<boolean> {
    const entries = await loadChangelogIndex();
    if (entries === null || entries.length === 0) return false;
    changelogShown.value = entries;
    return true;
  }

  return {
    authModalOpen,
    authModalMode,
    locale,
    t,
    setLocale,
    initializeLocale,
    openAuthModal,
    closeAuthModal,
    appCommit: APP_COMMIT,
    changelogShown,
    changelogOpen,
    checkForChangelog,
    closeChangelog,
    showChangelogHistory,
  };
});
