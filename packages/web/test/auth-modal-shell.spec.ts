import 'fake-indexeddb/auto';
import { createApp, h, nextTick, type App as VueApp } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@qed2/core-logic';
import App from '../src/App.vue';
import { useAuthStore } from '../src/stores/auth.js';
import { useUiStore } from '../src/stores/ui.js';

let mounted: VueApp | undefined;
let pinia: Pinia | undefined;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountShell(mode: 'login' | 'register' = 'login') {
  pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => h('p', 'Page') } }],
  });
  await router.push('/');
  const host = document.createElement('div');
  document.body.appendChild(host);
  mounted = createApp(App).use(pinia).use(router);
  mounted.mount(host);
  const auth = useAuthStore();
  const ui = useUiStore();
  ui.openAuthModal(mode);
  await settle();
  return { auth, ui, host };
}

function field(selector: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`.authm ${selector}`);
  if (!input) throw new Error(`Missing auth field: ${selector}`);
  return input;
}

function fill(selector: string, value: string): void {
  const input = field(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(): void {
  document.querySelector('.authm form')!.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
}

function pendingAction(auth: ReturnType<typeof useAuthStore>, name: 'login' | 'redeem') {
  let finish!: (error?: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = (error) => error ? reject(error) : resolve();
  });
  const action = vi.spyOn(auth, name).mockImplementation(async () => {
    auth.transitioning = true;
    try { await done; }
    finally { auth.transitioning = false; }
  });
  return { finish, action };
}

afterEach(async () => {
  mounted?.unmount();
  mounted = undefined;
  if (pinia) disposePinia(pinia);
  pinia = undefined;
  await settle();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('auth modal in the complete app shell', () => {
  it('keeps login inputs and the server error across the account lock, then retries', async () => {
    const { auth, ui } = await mountShell();
    const { finish, action } = pendingAction(auth, 'login');
    fill('[autocomplete="username"]', ' test-user ');
    fill('[type="password"]', 'test-password');
    submit();
    await settle();

    expect(document.querySelector('.authm')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.authm')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.app__account-lock')).not.toBeNull();
    submit();
    expect(action).toHaveBeenCalledExactlyOnceWith('test-user', 'test-password');

    finish(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials'));
    await settle();
    expect(document.querySelector('.authm [role="alert"]')?.textContent)
      .toContain('Benutzername oder Passwort falsch.');
    expect(field('[autocomplete="username"]').value).toBe(' test-user ');
    expect(field('[type="password"]').value).toBe('test-password');
    expect(document.querySelector('.authm')?.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('.app__account-lock')).toBeNull();

    action.mockResolvedValue(undefined);
    submit();
    await settle();
    expect(action).toHaveBeenCalledTimes(2);
    expect(ui.authModalOpen).toBe(false);
    ui.openAuthModal();
    await settle();
    expect(field('[type="password"]').value).toBe('');
    expect(document.querySelector('.authm [role="alert"]')).toBeNull();
  });

  it('keeps the invite form and failure visible instead of silently restarting registration', async () => {
    const { auth, ui } = await mountShell('register');
    const { finish, action } = pendingAction(auth, 'redeem');
    fill('[data-autofocus]', 'QED2-TEST-ONLY');
    fill('[autocomplete="username"]', 'new-test-user');
    fill('[type="password"]', 'test-password');
    submit();
    await settle();
    finish(new ApiError(400, 'INVITE_INVALID', 'Invalid invite'));
    await settle();

    expect(ui.authModalMode).toBe('register');
    expect(field('[data-autofocus]').value).toBe('QED2-TEST-ONLY');
    expect(field('[autocomplete="username"]').value).toBe('new-test-user');
    expect(field('[type="password"]').value).toBe('test-password');
    expect(document.querySelector('.authm [role="alert"]')?.textContent)
      .toContain('Einladungscode oder Angaben sind ungültig.');

    action.mockResolvedValue(undefined);
    fill('[data-autofocus]', 'QED2-NEW-INVITE');
    submit();
    await settle();
    expect(action).toHaveBeenLastCalledWith('QED2-NEW-INVITE', 'new-test-user', 'test-password');
    expect(ui.authModalOpen).toBe(false);
    ui.openAuthModal('register');
    await settle();
    expect(field('[type="password"]').value).toBe('');
  });

  it.each(['login', 'register'] as const)('clears the %s password after explicit dismissal', async (mode) => {
    const { ui } = await mountShell(mode);
    fill('[type="password"]', 'test-password');
    document.querySelector<HTMLButtonElement>('.authm__close')!.click();
    await settle();
    expect(ui.authModalOpen).toBe(false);
    ui.openAuthModal(mode);
    await settle();
    expect(field('[type="password"]').value).toBe('');
  });

  it('hands keyboard focus to the account lock without closing the hidden form', async () => {
    const { auth, ui } = await mountShell();
    fill('[autocomplete="username"]', 'test-user');
    auth.transitioning = true;
    auth.transitionError = true;
    await settle();
    const reload = document.querySelector<HTMLButtonElement>('.app__account-lock button')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(reload));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(ui.authModalOpen).toBe(true);
    expect(document.activeElement).toBe(reload);

    auth.transitionError = false;
    auth.transitioning = false;
    await settle();
    await vi.waitFor(() => expect(document.activeElement).toBe(field('[data-autofocus]')));
    expect(field('[autocomplete="username"]').value).toBe('test-user');
  });
});
