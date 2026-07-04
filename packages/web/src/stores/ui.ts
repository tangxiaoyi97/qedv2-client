/**
 * UI-chrome store: cross-page interface state (login/register modal —
 * grading supplement §10: authentication is a modal, not a page).
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { translate, type Locale, type MessageKey } from '../i18n.js';

const LOCALE_KEY = 'qed2.locale';

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

  return { authModalOpen, authModalMode, locale, t, setLocale, openAuthModal, closeAuthModal };
});
