import { createI18n, translateUi, type TranslationParams, type UiLocale } from '@qed2/ui';
import { webEn } from './locales/web-en.js';
import { settingsEn } from './locales/settings-en.js';
import { statusEn } from './locales/status-en.js';

export type Locale = UiLocale;
export const LOCALE_LABELS: Record<Locale, string> = { de: 'Deutsch', en: 'English' };
export const LOCALE_ENABLED: Record<Locale, boolean> = { de: true, en: true };

const messages = { ...webEn, ...settingsEn, ...statusEn };
const webI18n = createI18n(messages);

/** Explicit text translation keeps questions, answers and user names untouched. */
export function useI18n() {
  return webI18n;
}

export type MessageKey = string;
export function translate(locale: Locale, key: MessageKey, params?: TranslationParams): string {
  return translateUi(locale, key === 'settingsLanguage' ? 'Sprache' : key, params, messages);
}
