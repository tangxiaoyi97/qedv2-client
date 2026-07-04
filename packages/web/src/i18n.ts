export type Locale = 'de' | 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  de: 'Deutsch',
  en: 'English',
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
