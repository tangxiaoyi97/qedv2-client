import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App, type Component } from 'vue';
import { ManagementClient } from '../src/admin/api.js';
import UsersSection from '../src/admin/sections/UsersSection.vue';
import InvitesSection from '../src/admin/sections/InvitesSection.vue';
import FeedbackSection from '../src/admin/sections/FeedbackSection.vue';
import AuditSection from '../src/admin/sections/AuditSection.vue';
import ConfirmDialog from '../src/admin/components/ConfirmDialog.vue';
import CorePanel from '../src/admin/CorePanel.vue';
const apps: App[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const user = { id: 'user1', username: 'alice', createdAt: '2026-09-01T00:00:00Z', status: 'active', disabledAt: null, archiveVersion: 1, lastSyncWrite: null, ai: null };
const page = (items: unknown[], p = 1, total = items.length) => ({ items, total, page: p, pageSize: 25 });
function mount(component: Component, props: Record<string, unknown>) { const host = document.createElement('div'); document.body.append(host); const app = createApp(component, props); app.mount(host); apps.push(app); return { host, app }; }
async function settle() { await nextTick(); await new Promise((done) => setTimeout(done, 0)); await nextTick(); }
async function input(host: ParentNode, selector: string, value: string) { const field = host.querySelector<HTMLInputElement>(selector)!; field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); await nextTick(); }
async function click(host: ParentNode, label: string) { const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!; expect(button, label).toBeTruthy(); button.click(); await settle(); }
async function submit(host: ParentNode, selector: string) { host.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); }
async function clientWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) { const transport = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/auth/login') ? json({ token: 'test-admin-token-1234567890', requiresPasswordSetup: false, expiresAt: new Date(Date.now() + 600_000).toISOString() }) : handler(String(url), init)); const client = new ManagementClient('https://server.example', transport); await client.login('test-password'); return { client, transport }; }
afterEach(() => { apps.splice(0).forEach((app) => app.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks(); if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe('management resource interactions', () => {
  it('requires exact username, shows impacts, and adjusts a deleted last page', async () => {
    let removed = false;
    const { client, transport } = await clientWith((url, init) => {
      if (init?.method === 'DELETE') { removed = true; return json({ deleted: true, id: user.id }); }
      if (url.endsWith('/users/user1')) return json({ ...user, counts: { attempts: 42, aiCredentials: 1, feedback: 2 } });
      const p = Number(new URL(url).searchParams.get('page'));
      return json(page(removed ? [] : [user], p, removed ? 0 : 26));
    });
    const { host } = mount(UsersSection, { client, capabilities: { users: true, userDetails: true, userDelete: true } }); await settle();
    await click(host, '下一页'); await click(host, '删除');
    const dialog = document.querySelector('dialog')!;
    expect(dialog.textContent).toContain('作答记录'); expect(dialog.textContent).toContain('42');
    await input(dialog, 'input', 'Alice'); await click(dialog, '永久删除用户');
    expect(transport.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await input(dialog, 'input', 'alice'); await click(dialog, '永久删除用户');
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(JSON.parse(transport.mock.calls.find(([, init]) => init?.method === 'DELETE')![1]!.body as string)).toEqual({ confirmUsername: 'alice' });
    expect(host.textContent).toContain('第 1 / 1 页'); expect(document.querySelector('dialog')).toBeNull();
  });
  it('does not revive an old search response after a newer search or a cancellation', async () => {
    let resolveOld!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    const { client } = await clientWith((url, init) => {
      const q = new URL(url).searchParams.get('q');
      if (q === 'old') { oldSignal = init?.signal ?? undefined; return new Promise((done) => { resolveOld = done; }); }
      return json(page(q === 'new' ? [{ ...user, username: 'new-result' }] : []));
    });
    const { host } = mount(UsersSection, { client, capabilities: { users: true } }); await settle();
    await input(host, '#user-search', 'old'); await submit(host, '.filter-bar');
    await input(host, '#user-search', 'new'); await submit(host, '.filter-bar');
    expect(oldSignal?.aborted).toBe(true);
    resolveOld(json(page([{ ...user, username: 'old-result' }]))); await settle();
    expect(host.textContent).toContain('new-result'); expect(host.textContent).not.toContain('old-result');
  });
  it('shows a reset password once, revokes old sessions, and clears it on page change', async () => {
    const { client, transport } = await clientWith((url, init) => {
      if (url.endsWith('/password') && init?.method === 'POST') return json({ user, generatedPassword: 'generated-private-value', sessionsRevoked: true });
      return json(page([user], Number(new URL(url).searchParams.get('page')), 26));
    });
    const { host } = mount(UsersSection, { client, capabilities: { users: true, userPasswordReset: true } }); await settle();
    await click(host, '重置密码'); expect(document.querySelector('dialog')?.textContent).toContain('旧密码和所有旧登录会话立即失效');
    await click(document.querySelector('dialog')!, '重置密码');
    expect(host.textContent).toContain('generated-private-value');
    expect(JSON.parse(transport.mock.calls.find(([url]) => String(url).endsWith('/password'))![1]!.body as string)).toEqual({});
    await click(host, '下一页'); expect(host.textContent).not.toContain('generated-private-value');
  });
  it('hides unsupported lifecycle writes and marks incomplete invitation usage honestly', async () => {
    const { client } = await clientWith(() => json(page([{ id: 'invite1', code: 'LEGACY', kind: 'permanent', status: 'available', createdAt: '', expiresAt: null, useCount: 3, useCountComplete: false }])));
    const { host } = mount(InvitesSection, { client, capabilities: { invites: true } }); await settle();
    expect(host.textContent).toContain('至少 3'); expect(host.textContent).not.toContain('删除'); expect(host.textContent).not.toContain('撤销');
  });
  it('uses bounded authentication log pagination without invented totals or raw fields', async () => {
    const { client } = await clientWith((url) => url.includes('/auth/audit') ? json({ items: [{ at: '2026-09-13T12:00:00Z', actor: 'administrator', action: 'auth.login', outcome: 'failed', secret: 'not-rendered' }], page: 1, pageSize: 25, hasMore: true, truncated: true }) : json(page([])));
    const { host } = mount(AuditSection, { client, capabilities: { audit: true, authAudit: true, auditFilters: true } }); await settle(); await click(host, '认证与服务');
    expect(host.textContent).toContain('更早记录未包含'); expect(host.textContent).toContain('第 1 页 · 本页 1 条'); expect(host.textContent).not.toContain('not-rendered'); expect(host.textContent).not.toContain('共 1 条');
  });
  it('loads Core process history only with the explicit capability', async () => {
    const { client, transport } = await clientWith((url) => url.endsWith('/info') ? json({ version: '1.15.0', management: { capabilities: { jobHistory: true } } }) : json({ items: [{ id: 'job1', operation: 'validate', status: 'succeeded', startedAt: '2026-09-13T12:00:00Z' }] }));
    const { host } = mount(CorePanel, { client }); await settle(); await settle();
    expect(host.textContent).toContain('维护任务记录'); expect(host.textContent).toContain('job1'); expect(transport.mock.calls.some(([url]) => String(url).endsWith('/jobs'))).toBe(true);
  });
});

describe('destructive confirmation keyboard control', () => {
  it('focuses cancel, traps focus, handles Escape, and restores the trigger', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const closed = vi.fn(); const { app } = mount(ConfirmDialog, { title: '删除用户', description: '无法撤销', match: 'alice', onClose: closed }); await settle();
    const dialog = document.querySelector('dialog')!;
    expect(document.activeElement?.textContent).toBe('取消');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement?.tagName).toBe('INPUT');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); expect(closed).toHaveBeenCalledTimes(1);
    app.unmount(); apps.splice(apps.indexOf(app), 1); expect(document.activeElement).toBe(trigger);
  });
});


describe('resource detail focus', () => {
  const invitation = { id: 'invite1', code: 'INVITE-TEST', kind: 'permanent', status: 'available', createdAt: '', expiresAt: null, useCount: 0, recentUses: [] };
  const feedback = { id: 'feedback1', subject: 'A test report', message: 'Report content', category: 'bug', status: 'open', createdAt: '', user: { username: 'alice' } };
  const allowance = { mode: 'BYO', usedTokens: 0, usedCostCents: 0, monthlyTokenLimit: null, monthlyCostLimitCents: null, expiresAt: null };
  it.each([
    { name: 'user details', component: UsersSection, capabilities: { users: true, userDetails: true }, label: 'alice', list: user, detail: user, path: '/users/user1', close: '关闭详情' },
    { name: 'AI allowance', component: UsersSection, capabilities: { users: true, aiAllowance: true }, label: 'AI 授权', list: user, detail: allowance, path: '/users/user1/ai', close: '关闭' },
    { name: 'invite redemptions', component: InvitesSection, capabilities: { invites: true, inviteUsage: true }, label: '兑换记录', list: invitation, detail: invitation, path: '/invites/invite1', close: '关闭详情' },
    { name: 'feedback details', component: FeedbackSection, capabilities: { feedback: true }, label: 'A test report', list: feedback, detail: feedback, path: '/feedback/feedback1', close: '关闭详情' },
  ])('reveals $name and restores its exact row trigger on close', async ({ component, capabilities, label, list, detail, path, close }) => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    const { client } = await clientWith((url) => json(url.endsWith(path) ? detail : page([list])));
    const { host } = mount(component, { client, capabilities }); await settle();
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('.table-wrap button')].find((button) => button.textContent?.trim() === label)!;
    trigger.focus(); trigger.click(); await settle();
    const region = host.querySelector<HTMLElement>('.detail-region')!;
    expect(region).toBeTruthy(); expect(document.activeElement).toBe(region);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    await click(region, close);
    expect(host.querySelector('.detail-region')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest' });
  });
  it('restores the delete-row trigger after asynchronous impact loading and Escape', async () => {
    let resolveDetail!: (value: Response) => void;
    const { client } = await clientWith((url) => url.endsWith('/users/user1') ? new Promise((done) => { resolveDetail = done; }) : json(page([user])));
    const { host } = mount(UsersSection, { client, capabilities: { users: true, userDetails: true, userDelete: true } }); await settle();
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('.table-wrap button')].find((button) => button.textContent === '删除')!;
    trigger.focus(); trigger.click(); await settle();
    expect(trigger.disabled).toBe(true);
    document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); expect(document.activeElement).toBe(document.body);
    resolveDetail(json({ ...user, counts: { archives: 1, attempts: 0 } })); await settle();
    const dialog = document.querySelector('dialog')!;
    expect(document.activeElement?.textContent).toBe('取消');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle();
    expect(document.querySelector('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
});
