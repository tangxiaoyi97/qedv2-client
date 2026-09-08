import { readonly, shallowRef } from 'vue';
import { en } from './locales/en.js';

export type UiLocale = 'de' | 'en';
export type TranslationParams = Readonly<Record<string, string | number>>;
export type TranslationMessages = Readonly<Record<string, string>>;

const activeLocale = shallowRef<UiLocale>('de');
export const uiLocale = readonly(activeLocale);

/** Shells own persistence; shared UI only observes the selected language. */
export function setUiLocale(locale: UiLocale): void {
  activeLocale.value = locale === 'en' ? 'en' : 'de';
}

export function translateUi(
  locale: UiLocale,
  source: string,
  params?: TranslationParams,
  messages: TranslationMessages = {},
): string {
  const ownMessage = (dictionary: TranslationMessages): string | undefined =>
    Object.prototype.hasOwnProperty.call(dictionary, source) ? dictionary[source] : undefined;
  const text = locale === 'en' ? ownMessage(messages) ?? ownMessage(en) ?? source : source;
  // Replace only known placeholders; user content is never treated as a template.
  return text.replace(/\{([a-zA-Z][\w]*)\}/g, (match, key: string) =>
    params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

export function createI18n(messages: TranslationMessages = {}) {
  return {
    locale: uiLocale,
    t: (source: string, params?: TranslationParams): string =>
      translateUi(activeLocale.value, source, params, messages),
    formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions): string => {
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) return '—';
      return new Intl.DateTimeFormat(activeLocale.value === 'en' ? 'en-GB' : 'de-AT', options).format(date);
    },
    formatNumber: (value: number, options?: Intl.NumberFormatOptions): string =>
      new Intl.NumberFormat(activeLocale.value === 'en' ? 'en-GB' : 'de-AT', options).format(value),
  };
}

const sharedI18n = createI18n();
export function useI18n() {
  return sharedI18n;
}
