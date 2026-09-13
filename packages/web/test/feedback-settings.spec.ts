import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import FeedbackSettings from '../src/routes/settings/FeedbackSettings.vue';

const state = vi.hoisted(() => ({
  auth: { isLoggedIn: true, session: { user: { id: 'test-user' } } },
  app: { config: { serverBaseUrl: 'https://server.example' }, serverClient: { submitFeedback: vi.fn() } },
}));
vi.mock('../src/stores/auth.js', () => ({ useAuthStore: () => state.auth }));
vi.mock('../src/stores/app.js', () => ({ useAppStore: () => state.app }));
vi.mock('../src/services.js', () => ({ APP_VERSION: '2.5.0', ports: { shell: { capabilities: { desktop: false } } } }));
vi.mock('../src/i18n.js', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let app: App | undefined;
let host: HTMLElement;

async function settle(): Promise<void> { await nextTick(); await Promise.resolve(); await nextTick(); }
function mount(): void { host = document.createElement('div'); document.body.append(host); app = createApp(FeedbackSettings); app.mount(host); }
async function fill(selector: string, value: string): Promise<void> {
  const element = host.querySelector<HTMLInputElement>(selector)!;
  element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); await settle();
}
async function submit(): Promise<void> { host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await settle(); }

beforeEach(() => { state.auth.isLoggedIn = true; state.app.serverClient.submitFeedback.mockReset(); });
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ''; });

describe('voluntary user feedback form', () => {
  it('does not expose the submission form to a guest or send anything on mount', () => {
    state.auth.isLoggedIn = false; mount();
    expect(host.textContent).toContain('Melde dich an');
    expect(host.querySelector('form')).toBeNull();
    expect(state.app.serverClient.submitFeedback).not.toHaveBeenCalled();
  });

  it('requires deliberate consent and sends only the visible report and metadata', async () => {
    state.app.serverClient.submitFeedback.mockResolvedValue({ id: 'feedback-test-1', status: 'open', createdAt: '2026-09-13T12:00:00Z' });
    mount();
    await fill('#support-subject', 'A test report'); await fill('#support-message', 'A user-written test description.');
    await submit(); expect(state.app.serverClient.submitFeedback).not.toHaveBeenCalled();
    const consent = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    consent.checked = true; consent.dispatchEvent(new Event('change', { bubbles: true })); await settle();
    await submit();
    expect(state.app.serverClient.submitFeedback).toHaveBeenCalledWith({ category: 'bug', subject: 'A test report', message: 'A user-written test description.', clientVersion: '2.5.0', platform: 'web' });
    expect(host.textContent).toContain('feedback-test-1');
    expect(host.querySelector<HTMLTextAreaElement>('#support-message')?.value).toBe('');
    expect(consent.checked).toBe(false);
  });

  it('retains an unsent description on failure without retrying', async () => {
    state.app.serverClient.submitFeedback.mockRejectedValue(new Error('offline'));
    mount();
    await fill('#support-subject', 'A test report'); await fill('#support-message', 'Do not lose this description.');
    const consent = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    consent.checked = true; consent.dispatchEvent(new Event('change', { bubbles: true })); await settle();
    await submit();
    expect(host.querySelector<HTMLTextAreaElement>('#support-message')?.value).toBe('Do not lose this description.');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Übertragung nicht bestätigt');
    expect(state.app.serverClient.submitFeedback).toHaveBeenCalledTimes(1);
  });
});
