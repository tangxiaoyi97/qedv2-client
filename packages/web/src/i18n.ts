export type Locale = 'de' | 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  de: 'Deutsch',
  en: 'English — coming soon',
};

/** English is stubbed only (the full translation is not written yet) — the
 *  option is shown but disabled so nobody lands on a half-translated UI. */
export const LOCALE_ENABLED: Record<Locale, boolean> = {
  de: true,
  en: false,
};

const messages = {
  de: {
    settingsLanguage: 'Sprache',
    settingsLanguageHint: 'Oberfläche',
    program: 'Programm',
    new: 'Neu',
  },
  en: {
    settingsLanguage: 'Language',
    settingsLanguageHint: 'Interface',
    program: 'Program',
    new: 'New',
  },
} satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof (typeof messages)['de'];

export function translate(locale: Locale, key: MessageKey): string {
  return messages[locale]?.[key] ?? messages.de[key];
}
