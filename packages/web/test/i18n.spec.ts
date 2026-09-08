import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { computed } from 'vue';
import { setUiLocale, useI18n as useSharedI18n } from '@qed2/ui';
import { useI18n, LOCALE_ENABLED, translate } from '../src/i18n.js';
import { useUiStore } from '../src/stores/ui.js';
import { ports, storage } from '../src/services.js';

const originalShell = ports.shell;

afterEach(() => {
  setUiLocale('de');
  localStorage.removeItem('qed2.locale');
  vi.restoreAllMocks();
  ports.shell = originalShell;
});

describe('UI language', () => {
  it('updates shared and shell translations together without replacing user content', () => {
    const i18n = useI18n();
    const label = computed(() => i18n.t('Sprache'));
    expect(label.value).toBe('Sprache');
    setUiLocale('en');
    expect(LOCALE_ENABLED.en).toBe(true);
    expect(label.value).toBe('Language');
    expect(useSharedI18n().locale.value).toBe('en');
    const userText = 'Tangxiaoyi löst x = {answer}';
    expect(i18n.t(userText)).toBe(userText);
    expect(i18n.t('constructor')).toBe('constructor');
    expect(i18n.t('toString')).toBe('toString');
    expect(translate('en', 'settingsLanguage')).toBe('Language');
    expect(i18n.t('Eine Aufgabengrafik konnte nicht geladen werden ({status}).', { status: 503 }))
      .toBe('Could not load a figure (503).');
    expect(i18n.t('Die Lernempfehlung konnte lokal nicht gespeichert werden.'))
      .toBe('Could not save the learning recommendation.');
    expect(i18n.formatNumber(1234.5)).toBe('1,234.5');
  });

  it('persists a language change and follows another window immediately', () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const ui = useUiStore();
    ui.setLocale('en');
    expect(localStorage.getItem('qed2.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    window.dispatchEvent(new StorageEvent('storage', { key: 'qed2.locale', newValue: 'de' }));
    expect(ui.locale).toBe('de');
    expect(useSharedI18n().locale.value).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    disposePinia(pinia);
    window.dispatchEvent(new StorageEvent('storage', { key: 'qed2.locale', newValue: 'en' }));
    expect(ui.locale).toBe('de');
  });

  it('keeps language switching usable when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const pinia = createPinia();
    setActivePinia(pinia);
    const ui = useUiStore();
    expect(() => ui.setLocale('en')).not.toThrow();
    expect(ui.locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    disposePinia(pinia);
  });

  it('restores native language and serializes rapid changes without replacing a newer selection', async () => {
    ports.shell = { ...originalShell, capabilities: { ...originalShell.capabilities, desktop: true } };
    let finishRead!: (value: unknown) => void;
    vi.spyOn(storage, 'get').mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const writes: unknown[] = [];
    let finishWrite!: () => void;
    vi.spyOn(storage, 'set').mockImplementation((_collection, _key, value) => {
      writes.push(value);
      return new Promise<void>((resolve) => { finishWrite = resolve; });
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const ui = useUiStore();
    const initial = ui.initializeLocale();
    ui.setLocale('en');
    finishRead('de');
    await initial;
    expect(ui.locale).toBe('en');
    ui.setLocale('de');
    await Promise.resolve();
    expect(writes).toEqual(['en']);
    finishWrite();
    await vi.waitFor(() => expect(writes).toEqual(['en', 'de']));
    finishWrite();
    expect(document.documentElement.lang).toBe('de');
    disposePinia(pinia);
  });

  it('uses the profile language on a new desktop origin and resets deleted preferences', async () => {
    ports.shell = { ...originalShell, capabilities: { ...originalShell.capabilities, desktop: true } };
    const read = vi.spyOn(storage, 'get').mockResolvedValue('en');
    const pinia = createPinia();
    setActivePinia(pinia);
    const ui = useUiStore();
    await ui.initializeLocale();
    expect(ui.locale).toBe('en');
    expect(localStorage.getItem('qed2.locale')).toBe('en');
    read.mockResolvedValue(undefined);
    await ui.initializeLocale(true);
    expect(ui.locale).toBe('de');
    disposePinia(pinia);
  });
});
