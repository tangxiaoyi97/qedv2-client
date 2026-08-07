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

  it('shows a textual readiness summary and uses native exclusive source controls', async () => {
    const host = mountSettings();

    expect(getElement(host, 'section').getAttribute('aria-labelledby')).toBe('ai-settings-title');
    expect(getElement(host, 'h2').textContent).toBe('KI-Erklärungen');
    expect(host.textContent).toContain('Einsatzbereit');
    expect(host.textContent).toContain('Eigener Schlüssel');
    expect(host.textContent).toContain('OpenAI · gpt-test');
    expect(host.textContent).toContain('Erklärungen & Bewertungsvorschläge');
    expect(host.textContent).toContain('Nur auf deinen Klick');

    const ownKey = getElement<HTMLInputElement>(host, 'input[name="ai-source"][value="byo"]');
    const serverPool = getElement<HTMLInputElement>(host, 'input[name="ai-source"][value="pool"]');
    expect(ownKey.checked).toBe(true);
    expect(serverPool.checked).toBe(false);

    serverPool.click();
    await nextTick();

    expect(aiStore.setMode).toHaveBeenCalledWith('pool');
    expect(serverPool.checked).toBe(true);
    expect(host.textContent).toMatch(/noch 1\s000 Token/);
  });

  it('guides an unconfigured account and never leaves the secret in the form', async () => {
    aiStore.status = readyStatus({
      byo: { configured: false },
      pool: { eligible: false },
      active: 'none',
    });
    aiStore.poolAllowed = false;
    aiStore.poolOffered = false;
    const host = mountSettings();

    expect(host.textContent).toContain('Einrichtung nötig');
    expect(getElement(host, 'details.ai-set__key-details').hasAttribute('open')).toBe(true);
    expect(getElement<HTMLInputElement>(host, 'input[name="ai-source"][value="pool"]').disabled).toBe(true);

    getElement<HTMLInputElement>(host, 'input[name="ai-provider"][value="gemini"]').click();
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

  it('announces a failed status without relying on colour and offers a retry', async () => {
    aiStore.status = null;
    aiStore.statusError = 'Netzwerk nicht erreichbar';
    const host = mountSettings();

    expect(getElement(host, '[role="alert"]').textContent).toContain('Netzwerk nicht erreichbar');
    expect(host.textContent).toContain('Status nicht verfügbar');
    expect(getElement<HTMLInputElement>(host, 'input[name="ai-source"][value="pool"]').disabled).toBe(true);
    expect(getElement<HTMLInputElement>(host, 'input[name="ai-source"][value="byo"]').disabled).toBe(true);

    buttonWithText(host, 'Status erneut laden').click();
    await settle();
    expect(aiStore.refreshStatus).toHaveBeenCalledTimes(1);
  });

  it('confirms credential removal and reports local cache clearing', async () => {
    const host = mountSettings();

    buttonWithText(host, 'Schlüssel entfernen').click();
    await nextTick();
    expect(host.textContent).toContain('Wirklich entfernen?');
    buttonWithText(host, 'Entfernen').click();
    await settle();
    expect(aiStore.deleteCredential).toHaveBeenCalledTimes(1);

    const maintenance = getElement<HTMLDetailsElement>(host, 'details.ai-set__maintenance');
    maintenance.open = true;
    await nextTick();
    buttonWithText(host, 'Antworten leeren').click();
    await settle();

    expect(aiStore.clearCache).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Lokale KI-Antworten wurden geleert');
  });

  it('uses shared components and theme tokens without a platform-specific UI branch', () => {
    expect(aiSettingsSource).toContain("import { QButton, QChip, QNotice } from '@qed2/ui';");
    expect(aiSettingsSource).toContain('min-height: var(--q-control-height);');
    expect(aiSettingsSource).toContain('background: var(--q-accent-bg);');
    expect(aiSettingsSource).toContain('color: var(--q-ink);');
    expect(aiSettingsSource).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(aiSettingsSource).not.toMatch(/rgba?\(/i);
    expect(aiSettingsSource).not.toContain('qed2Desktop');
    expect(aiSettingsSource).not.toContain('ports.shell');
    expect(aiSettingsSource).not.toContain('Electron');
  });
});
