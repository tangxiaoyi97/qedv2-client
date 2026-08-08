import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, reactive, type App } from 'vue';
import AiSettings from '../src/routes/settings/AiSettings.vue';
import aiSettingsSource from '../src/routes/settings/AiSettings.vue?raw';

interface TestAiStatus {
  byo: {
    configured: boolean;
    provider?: 'openai' | 'gemini';
    model?: string;
    last4?: string;
  };
  pool: {
    eligible: boolean;
    provider?: 'openai' | 'gemini';
    model?: string;
    remaining?: { tokens?: number };
  };
  active: 'none' | 'pool' | 'byo';
  features: { explain: boolean; assess: boolean };
}

interface TestAiStore {
  available: boolean;
  status: TestAiStatus | null;
  statusError: string | null;
  capabilities: { explain: boolean; assess: boolean } | null;
  mode: 'pool' | 'byo';
  poolAllowed: boolean;
  poolOffered: boolean;
  byoOffered: boolean;
  setMode: ReturnType<typeof vi.fn>;
  refreshStatus: ReturnType<typeof vi.fn>;
  saveCredential: ReturnType<typeof vi.fn>;
  deleteCredential: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
}

interface TestAppStore {
  config: {
    aiLanguage?: string;
    aiCustomInstructions?: string;
  };
  updateConfig: ReturnType<typeof vi.fn>;
}

let aiStore: TestAiStore;
let appStore: TestAppStore;
let mounted: { app: App; host: HTMLElement } | undefined;

vi.mock('../src/stores/ai.js', () => ({
  useAiStore: () => aiStore,
}));

vi.mock('../src/stores/app.js', () => ({
  useAppStore: () => appStore,
}));

function readyStatus(overrides: Partial<TestAiStatus> = {}): TestAiStatus {
  return {
    byo: {
      configured: true,
      provider: 'openai',
      model: 'gpt-test',
      last4: '1234',
    },
    pool: {
      eligible: true,
      provider: 'openai',
      model: 'gpt-pool',
      remaining: { tokens: 1_000 },
    },
    active: 'byo',
    features: { explain: true, assess: true },
    ...overrides,
  };
}

function mountSettings(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(AiSettings);
  app.mount(host);
  mounted = { app, host };
  return host;
}

function getElement<T extends Element>(host: HTMLElement, selector: string): T {
  const element = host.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

function buttonWithText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button as HTMLButtonElement;
}

function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe('AI settings view', () => {
  beforeEach(() => {
    aiStore = reactive({
      available: true,
      status: readyStatus(),
      statusError: null,
      capabilities: { explain: true, assess: true },
      mode: 'byo',
      poolAllowed: true,
      poolOffered: true,
      byoOffered: true,
      setMode: vi.fn((next: 'pool' | 'byo') => {
        aiStore.mode = next;
      }),
      refreshStatus: vi.fn(async () => undefined),
      saveCredential: vi.fn(async () => undefined),
      deleteCredential: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
    }) as TestAiStore;
    appStore = reactive({
      config: {
        aiLanguage: 'Deutsch',
        aiCustomInstructions: '',
      },
      updateConfig: vi.fn(async () => undefined),
    }) as TestAppStore;
  });

  afterEach(() => {
    mounted?.app.unmount();
    mounted = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows a compact readiness summary and an exclusive source control only when both sources work', async () => {
    const host = mountSettings();

    const card = getElement(host, 'section.q-settings-card');
    expect(card.getAttribute('aria-labelledby')).toBeTruthy();
    expect(getElement(host, 'h2').textContent).toBe('KI-Erklärungen');
    expect(host.textContent).toContain('Einsatzbereit');
    expect(host.textContent).toContain('Erklären · Bewerten');
    expect(host.textContent).toContain('OpenAI · gpt-test · •••• 1234');

    const sourceControl = getElement(host, '[role="radiogroup"][aria-labelledby]');
    const labelledBy = sourceControl.getAttribute('aria-labelledby');
    expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe('Quelle');
    const ownKey = getElement<HTMLInputElement>(host, 'input[name="ai-source"][value="byo"]');
    const serverPool = getElement<HTMLInputElement>(host, 'input[name="ai-source"][value="pool"]');
    expect(ownKey.type).toBe('radio');
    expect(serverPool.name).toBe(ownKey.name);
    expect(ownKey.labels?.[0]?.textContent).toContain('Eigener Schlüssel');
    expect(ownKey.checked).toBe(true);
    expect(serverPool.checked).toBe(false);
    ownKey.focus();
    expect(document.activeElement).toBe(ownKey);

    serverPool.click();
    await nextTick();

    expect(aiStore.setMode).toHaveBeenCalledWith('pool');
    expect(serverPool.checked).toBe(true);
    expect(host.textContent).toMatch(/1\s000 Token/);
  });

  it('hides unavailable server pooling and never leaves a saved secret in the form', async () => {
    aiStore.status = readyStatus({
      byo: { configured: false },
      pool: { eligible: false },
      active: 'none',
    });
    aiStore.poolAllowed = false;
    aiStore.poolOffered = false;
    const host = mountSettings();

    expect(host.textContent).toContain('Einrichtung nötig');
    expect(getElement(host, '#ai-credential-editor')).toBeTruthy();
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Server')).toBe(false);

    buttonWithText(host, 'Schließen').click();
    await nextTick();
    expect(host.querySelector('#ai-credential-editor')).toBeNull();
    buttonWithText(host, 'Einrichten').click();
    await nextTick();

    const provider = getElement<HTMLSelectElement>(host, 'select[aria-labelledby]');
    provider.value = 'gemini';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    inputValue(getElement<HTMLInputElement>(host, '#ai-key'), '  test-secret  ');
    inputValue(getElement<HTMLInputElement>(host, '#ai-model'), '  model-test  ');
    getElement<HTMLFormElement>(host, 'form[aria-label="Eigenen KI-Schlüssel einrichten"]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(aiStore.saveCredential).toHaveBeenCalledWith({
      provider: 'gemini',
      apiKey: 'test-secret',
      model: 'model-test',
    });
    expect(getElement<HTMLInputElement>(host, '#ai-key').value).toBe('');
    expect(host.textContent).toContain('Schlüssel gespeichert');
  });

  it('does not auto-open the own-key editor while the entitled server source is selected', async () => {
    aiStore.status = readyStatus({
      byo: { configured: false },
      active: 'pool',
    });
    aiStore.mode = 'pool';
    const host = mountSettings();

    expect(host.querySelector('#ai-credential-editor')).toBeNull();
    buttonWithText(host, 'Einrichten').click();
    await nextTick();
    expect(getElement(host, '#ai-credential-editor')).toBeTruthy();
  });

  it('announces loading and failed status without rendering unusable source choices', async () => {
    aiStore.status = null;
    const loadingHost = mountSettings();

    expect(getElement(loadingHost, '[role="status"]').textContent).toContain('Wird geladen');
    expect(loadingHost.querySelector('[role="radiogroup"]')).toBeNull();
    mounted?.app.unmount();
    mounted = undefined;
    document.body.innerHTML = '';

    aiStore.status = null;
    aiStore.statusError = 'Netzwerk nicht erreichbar';
    const host = mountSettings();

    expect(getElement(host, '[role="alert"]').textContent).toContain('Netzwerk nicht erreichbar');
    expect(host.textContent).toContain('Status nicht verfügbar');
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();

    buttonWithText(host, 'Erneut laden').click();
    await settle();
    expect(aiStore.refreshStatus).toHaveBeenCalledTimes(1);
  });

  it('confirms credential removal and reports local cache clearing', async () => {
    const host = mountSettings();

    buttonWithText(host, 'Ändern').click();
    await nextTick();
    buttonWithText(host, 'Entfernen').click();
    await nextTick();
    expect(getElement(host, '[role="group"][aria-label="Schlüssel wirklich entfernen"]').textContent).toContain(
      'Schlüssel entfernen?',
    );
    buttonWithText(host, 'Entfernen').click();
    await settle();
    expect(aiStore.deleteCredential).toHaveBeenCalledTimes(1);

    buttonWithText(host, 'Leeren').click();
    await settle();

    expect(aiStore.clearCache).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Geleert.');
  });

  it('keeps a stored credential removable after own-key access is revoked', async () => {
    aiStore.byoOffered = false;
    const host = mountSettings();

    expect(host.textContent).toContain('OpenAI · gpt-test · •••• 1234');
    expect(host.textContent).toContain('Zugriff nicht freigeschaltet');
    expect(host.querySelector('#ai-credential-editor')).toBeNull();
    expect(host.textContent).not.toContain('Einrichten');
    expect(host.textContent).not.toContain('Ändern');

    buttonWithText(host, 'Entfernen').click();
    await nextTick();
    expect(getElement(host, '[role="group"][aria-label="Schlüssel wirklich entfernen"]')).toBeTruthy();

    buttonWithText(host, 'Entfernen').click();
    await settle();
    expect(aiStore.deleteCredential).toHaveBeenCalledTimes(1);
    expect(aiStore.saveCredential).not.toHaveBeenCalled();
  });

  it('expands response and privacy details only on request and saves preferences', async () => {
    const host = mountSettings();

    expect(host.querySelector('#ai-preferences-editor')).toBeNull();
    expect(host.querySelector('#ai-privacy-details')).toBeNull();

    buttonWithText(host, 'Bearbeiten').click();
    await nextTick();
    inputValue(getElement<HTMLInputElement>(host, '#ai-language'), ' Kroatisch ');
    inputValue(getElement<HTMLTextAreaElement>(host, '#ai-instructions'), ' Kurz erklären. ');
    getElement<HTMLFormElement>(host, '#ai-preferences-editor').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(appStore.updateConfig).toHaveBeenCalledWith({
      aiLanguage: 'Kroatisch',
      aiCustomInstructions: 'Kurz erklären.',
    });
    expect(host.textContent).toContain('Antwortstil gespeichert');

    buttonWithText(host, 'Details').click();
    await nextTick();
    expect(getElement(host, '#ai-privacy-details').textContent).toContain(
      'Aufgabe, Musterlösung und deine Antwort',
    );
    expect(getElement(host, '#ai-privacy-details').textContent).toContain(
      'Konto, Lernfortschritt und Statistiken',
    );
  });

  it('keeps credential, preference and cache failures visible', async () => {
    aiStore.status = readyStatus({
      byo: { configured: false },
      pool: { eligible: false },
      active: 'none',
    });
    aiStore.poolAllowed = false;
    aiStore.poolOffered = false;
    aiStore.saveCredential = vi.fn(async () => {
      throw new Error('Schlüssel ungültig');
    });
    aiStore.clearCache = vi.fn(async () => {
      throw new Error('Cache gesperrt');
    });
    appStore.updateConfig = vi.fn(async () => {
      throw new Error('Einstellungen nicht gespeichert');
    });
    const host = mountSettings();

    inputValue(getElement<HTMLInputElement>(host, '#ai-key'), 'test-secret');
    getElement<HTMLFormElement>(host, '#ai-credential-editor').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(host.textContent).toContain('Schlüssel ungültig');

    buttonWithText(host, 'Bearbeiten').click();
    await nextTick();
    getElement<HTMLFormElement>(host, '#ai-preferences-editor').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(host.textContent).toContain('Einstellungen nicht gespeichert');

    buttonWithText(host, 'Leeren').click();
    await settle();
    expect(host.textContent).toContain('Cache gesperrt');
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(3);
  });

  it('uses shared components and theme tokens without a platform-specific UI branch', () => {
    expect(aiSettingsSource).toContain("import { QButton, QChip, QNotice } from '@qed2/ui';");
    expect(aiSettingsSource).toContain("import SettingsCard from './SettingsCard.vue';");
    expect(aiSettingsSource).toContain("import SettingsRow from './SettingsRow.vue';");
    expect(aiSettingsSource).toContain("from 'lucide-vue-next';");
    expect(aiSettingsSource).toContain('min-height: var(--q-control-height);');
    expect(aiSettingsSource).toContain('type="radio"');
    expect(aiSettingsSource).toContain('name="ai-source"');
    expect(aiSettingsSource).toContain('background: var(--q-accent-strong);');
    expect(aiSettingsSource).toContain('color: var(--q-ink);');
    expect(aiSettingsSource).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(aiSettingsSource).not.toMatch(/rgba?\(/i);
    expect(aiSettingsSource).not.toContain('ai-set__overview');
    expect(aiSettingsSource).not.toContain('qed2Desktop');
    expect(aiSettingsSource).not.toContain('ports.shell');
    expect(aiSettingsSource).not.toContain('Electron');
  });
});
