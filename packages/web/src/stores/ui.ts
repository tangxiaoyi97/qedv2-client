/**
 * UI-chrome store: cross-page interface state (login/register modal —
 * grading supplement §10: authentication is a modal, not a page).
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { translate, type Locale, type MessageKey } from '../i18n.js';

const LOCALE_KEY = 'qed2.locale';
const LAST_SEEN_COMMIT_KEY = 'qed2.lastSeenCommit';

/** Build commit baked in by vite (define). 'dev' when built without git. */
const APP_COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'de';
  return window.localStorage.getItem(LOCALE_KEY) === 'en' ? 'en' : 'de';
}

export const useUiStore = defineStore('ui', () => {
  const authModalOpen = ref(false);
  /** Which face of the modal is showing (switches in place, §10). */
  const authModalMode = ref<'login' | 'register'>('login');
  const locale = ref<Locale>(initialLocale());
  const t = computed(() => (key: MessageKey) => translate(locale.value, key));

  function setLocale(next: Locale): void {
    locale.value = next;
    if (typeof window !== 'undefined') window.localStorage.setItem(LOCALE_KEY, next);
  }

  function openAuthModal(mode: 'login' | 'register' = 'login'): void {
    authModalMode.value = mode;
    authModalOpen.value = true;
  }

  function closeAuthModal(): void {
    authModalOpen.value = false;
  }

  /* ---- changelog-on-update dialog ---- */
  const changelogMarkdown = ref<string | null>(null);
  const changelogOpen = computed(() => changelogMarkdown.value !== null);

  function lastSeenCommit(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(LAST_SEEN_COMMIT_KEY);
  }
  function rememberCommit(): void {
    if (typeof window !== 'undefined') window.localStorage.setItem(LAST_SEEN_COMMIT_KEY, APP_COMMIT);
  }

  /**
   * On first load after an update, fetch this build's changelog and pop the
   * dialog. Skips when the commit is unknown ('dev'), unchanged since last
   * seen, or has no archived changelog (404). A network failure is left
   * un-remembered so the next load retries.
   */
  async function checkForChangelog(): Promise<void> {
    if (APP_COMMIT === 'dev') return;
    // First run ever: adopt the current commit silently, don't announce.
    if (lastSeenCommit() === null) {
      rememberCommit();
      return;
    }
    if (lastSeenCommit() === APP_COMMIT) return;

    const base = import.meta.env.BASE_URL || '/';
    const url = `${base}changelogs/${APP_COMMIT}.md`;
    let res: Response;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch {
      return; // offline — retry next load, stay un-remembered
    }
    if (res.status === 404) {
      rememberCommit(); // this build ships no notes — don't ask again
      return;
    }
    if (!res.ok) return;
    const text = (await res.text()).trim();
    if (text === '') {
      rememberCommit();
      return;
    }
    changelogMarkdown.value = text;
    // remembered only when the user dismisses (closeChangelog)
  }

  function closeChangelog(): void {
    changelogMarkdown.value = null;
    rememberCommit();
  }

  return {
    authModalOpen,
    authModalMode,
    locale,
    t,
    setLocale,
    openAuthModal,
    closeAuthModal,
    appCommit: APP_COMMIT,
    changelogMarkdown,
    changelogOpen,
    checkForChangelog,
    closeChangelog,
  };
});
