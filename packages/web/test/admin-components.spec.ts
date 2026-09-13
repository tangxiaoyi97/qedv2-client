import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import AdminApp from '../src/admin/AdminApp.vue';
import NodePanel from '../src/admin/NodePanel.vue';

const apps: App[] = [];
function mount(component: typeof NodePanel | typeof AdminApp, props: Record<string, unknown> = {}): HTMLElement {
  const host = document.createElement('div'); document.body.append(host);
  const app = createApp(component, props); app.mount(host); apps.push(app); return host;
}
async function settle(): Promise<void> { await nextTick(); await new Promise<void>((done) => setTimeout(done, 0)); await nextTick(); }
async function input(host: HTMLElement, selector: string, value: string): Promise<void> {
  const field = host.querySelector<HTMLInputElement>(selector)!;
  field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
}
async function submit(host: HTMLElement, selector: string): Promise<void> {
  host.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const grant = (setup = false) => ({ token: 'test-page-session-1234567890', requiresPasswordSetup: setup, expiresAt: new Date(Date.now() + 600_000).toISOString() });
let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), clear: () => saved.clear() });
});

afterEach(() => { apps.splice(0).forEach((app) => app.unmount()); document.body.innerHTML = ''; localStorage.clear(); vi.unstubAllGlobals(); });

describe('standalone management interface', () => {
  it('renders immediately without learner login, bank requests or any node connection', async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    const host = mount(AdminApp); await settle();
    expect(host.textContent).toContain('两个节点，各自独立');
    expect(host.querySelector('#server-address')).not.toBeNull();
    expect(host.querySelector('#core-address')).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('does not show management controls for a setup-only session or persist its secret', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ service: 'qed2-core', apiVersion: 1, initialized: false })).mockResolvedValueOnce(json(grant(true)));
    vi.stubGlobal('fetch', fetcher);
    const host = mount(NodePanel, { kind: 'core' });
    await input(host, '#core-address', 'http://127.0.0.1:18788');
    await submit(host, '.connection-form');
    await input(host, '#core-secret', 'test-bootstrap-key');
    await submit(host, 'form:nth-child(2)');
    expect(host.textContent).toContain('设置管理密码');
    expect(host.textContent).not.toContain('校验题库');
    expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/management/info'))).toBe(true);
    expect(host.querySelector('#core-secret')).toBeNull();
    expect(localStorage.getItem('qed2.admin.core.origin')).toBe('http://127.0.0.1:18788');
    expect(JSON.stringify([...saved])).not.toContain('test-bootstrap-key');
    expect(JSON.stringify([...saved])).not.toContain('test-page-session');
  });

  it('can connect and manage Core while Server is unreachable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const address = String(url);
      if (address.includes(':18081')) throw new TypeError('offline');
      if (address.endsWith('/auth/status')) return json({ service: 'qed2-core', apiVersion: 1, initialized: true });
      if (address.endsWith('/auth/login')) return json(grant());
      if (address.endsWith('/management/info')) return json({ version: '1.14.0', health: { status: 'ok' }, bank: { commit: 'abcd' }, management: { capabilities: { validate: true, bankUpdate: false, restart: false }, activeJob: null } });
      return json({});
    });
    vi.stubGlobal('fetch', fetcher);
    const host = mount(AdminApp);
    const server = host.querySelector<HTMLElement>('[aria-labelledby="server-title"]')!;
    const core = host.querySelector<HTMLElement>('[aria-labelledby="core-title"]')!;
    await input(server, '#server-address', 'http://127.0.0.1:18081'); await submit(server, '.connection-form');
    expect(server.textContent).toContain('无法连接节点');
    await input(core, '#core-address', 'http://127.0.0.1:18788'); await submit(core, '.connection-form');
    await input(core, '#core-secret', 'test-core-password'); await submit(core, 'form:nth-child(2)'); await settle();
    expect(core.textContent).toContain('1.14.0');
    expect(core.textContent).toContain('校验题库');
    expect(server.textContent).toContain('无法连接节点');
    const authenticated = fetcher.mock.calls.filter(([, options]) => (options?.headers as Record<string, string> | undefined)?.Authorization);
    expect(authenticated.every(([url]) => String(url).includes(':18788'))).toBe(true);
  });

  it('requires reconnecting after an address edit and never sends a secret to the previous node', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ service: 'qed2-core', apiVersion: 1, initialized: true }));
    vi.stubGlobal('fetch', fetcher);
    const host = mount(NodePanel, { kind: 'core' });
    await input(host, '#core-address', 'https://old-core.example'); await submit(host, '.connection-form');
    await input(host, '#core-secret', 'test-password-must-not-send');
    const priorLogin = host.querySelectorAll('form')[1]!;
    await input(host, '#core-address', 'https://new-core.example');
    expect(host.querySelector('#core-secret')).toBeNull();
    priorLogin.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await submit(host, '.connection-form');
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://new-core.example/management/auth/status');
    expect(host.querySelector<HTMLInputElement>('#core-secret')?.value).toBe('');
  });

  it('rejects an unknown management protocol before accepting any credential', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ service: 'qed2-core', apiVersion: 2, initialized: true }));
    vi.stubGlobal('fetch', fetcher);
    const host = mount(NodePanel, { kind: 'core' });
    await input(host, '#core-address', 'https://core.example'); await submit(host, '.connection-form');
    expect(host.textContent).toContain('协议版本不兼容');
    expect(host.querySelector('#core-secret')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires explicit capabilities before showing Server writes or sending a disabled action', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/status')) return json({ service: 'qed2-server', apiVersion: 1, initialized: true });
      if (String(url).endsWith('/auth/login')) return json(grant());
      if (String(url).endsWith('/info')) return json({ version: '2.4.0', management: { capabilities: {} } });
      if (String(url).endsWith('/stats')) return json({ users: { total: 0, newLast7Days: 0 }, activity: { attemptsLast7Days: 0, reportedUsersLast7Days: 0 }, ai: { callsLast7Days: 0, failedLast7Days: 0 }, feedback: { open: 0, inProgress: 0 } });
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetcher);
    const host = mount(NodePanel, { kind: 'server' });
    await input(host, '#server-address', 'https://server.example'); await submit(host, '.connection-form');
    await input(host, '#server-secret', 'test-password'); await submit(host, 'form:nth-child(2)'); await settle();
    const users = [...host.querySelectorAll<HTMLButtonElement>('.section-nav button')].find((button) => button.textContent === '用户')!;
    expect(users.disabled).toBe(true);
    users.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/management/users'))).toBe(false);
    expect(host.textContent).not.toContain('创建用户');
  });
});
