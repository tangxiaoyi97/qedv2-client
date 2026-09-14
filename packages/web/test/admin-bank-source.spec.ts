import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { ManagementClient } from '../src/admin/api.js';
import type { BankSourceSaved, BankSourceState } from '../src/admin/bank-source.js';
import BankSourcePanel from '../src/admin/BankSourcePanel.vue';

const apps: App[] = [];
const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64), commit = '1'.repeat(40);
const defaultSource = { repository: 'https://github.com/deployment/default-bank', ref: 'release/stable' };
const alternative = { repository: 'https://github.com/example/another-bank', ref: 'release/next' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function sourceState(overrides: Partial<BankSourceState> = {}): BankSourceState {
  return {
    source: { repository: 'https://github.com/example/current-bank', ref: 'main', revision, origin: 'override' },
    defaultSource: { ...defaultSource },
    current: { repository: 'https://github.com/example/running-bank', ref: 'main', commit },
    pending: null,
    ...overrides,
  };
}
function saved(overrides: Partial<BankSourceSaved> = {}): BankSourceSaved {
  return { ...sourceState({ source: { ...alternative, revision: nextRevision, origin: 'override' } }), latestCommit: '2'.repeat(40), changed: true, durability: 'confirmed', ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function clientWith(handler: (init: RequestInit) => Response | Promise<Response>) {
  const reads: RequestInit[] = [], writes: RequestInit[] = [];
  const transport = vi.fn<typeof fetch>(async (url, init = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/management/, '');
    if (path === '/auth/login') return json({ token: 'test-admin-token-1234567890', requiresPasswordSetup: false, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    expect(path).toBe('/core/bank-source');
    (init.method === 'GET' ? reads : writes).push(init);
    return handler(init);
  });
  const client = new ManagementClient('https://core.example', transport);
  await client.login('test-password');
  return { client, reads, writes };
}
function mount(client: ManagementClient, initial: { locked?: boolean; generation?: number } = {}) {
  const props = reactive({ locked: false, generation: 0, ...initial });
  const changed = vi.fn(), sessionLost = vi.fn(), busy = vi.fn();
  const host = document.createElement('div'); document.body.append(host);
  const app = createApp({ render: () => h(BankSourcePanel, { client, ...props, onChanged: changed, onSessionLost: sessionLost, onBusy: busy }) });
  app.mount(host); apps.push(app);
  return { host, props, changed, sessionLost, busy, unmount: () => { apps.splice(apps.indexOf(app), 1); app.unmount(); } };
}
async function settle() { await nextTick(); await vi.advanceTimersByTimeAsync(0); await nextTick(); }
function button(host: ParentNode, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(found, `button: ${label}`).toBeTruthy();
  return found!;
}
function dialog() {
  const found = document.querySelector<HTMLDialogElement>('dialog');
  expect(found, 'source confirmation dialog').not.toBeNull();
  return found!;
}
function input(host: ParentNode, id: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
  expect(field).not.toBeNull(); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
}
async function edit(host: ParentNode, repository = alternative.repository, ref = alternative.ref) {
  button(host, '更改来源').click(); await settle();
  input(host, 'bank-source-repository', repository); input(host, 'bank-source-ref', ref); await nextTick();
}
async function prepare(host: ParentNode) {
  host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount()); document.body.innerHTML = '';
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('Core question bank source controls', () => {
  it('moves keyboard focus into source editing and returns it on cancellation', async () => {
    const { client, writes } = await clientWith(() => json(sourceState()));
    const { host } = mount(client); await settle();
    button(host, '更改来源').focus(); await edit(host);
    expect(document.activeElement).toBe(host.querySelector('#bank-source-repository'));
    button(host, '取消编辑').click(); await settle();
    expect(document.activeElement).toBe(button(host, '更改来源'));
    expect(writes).toHaveLength(0);
  });
  it('confirms the exact edited source and revision, and sends only one write on repeated submission', async () => {
    const pending = deferred<Response>();
    const { client, writes, reads } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : pending.promise);
    const { host, changed, busy } = mount(client); await settle();
    expect(host.textContent).toContain('https://github.com/example/current-bank');
    await edit(host, ` ${alternative.repository} `, ` ${alternative.ref} `); await prepare(host);
    expect(writes).toHaveLength(0);
    expect(dialog().textContent).toContain(alternative.repository);
    expect(dialog().textContent).toContain(alternative.ref);
    const confirm = button(dialog(), '确认保存来源');
    confirm.click(); confirm.click(); await settle();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]!.body))).toEqual({ ...alternative, expectedRevision: revision, confirmation: 'change-bank-source' });
    expect(button(dialog(), '正在提交…').disabled).toBe(true);
    expect(button(dialog(), '取消').disabled).toBe(true);
    expect(button(host, '刷新来源').disabled).toBe(true);
    expect(busy).toHaveBeenLastCalledWith(true);
    pending.resolve(json(saved())); await settle();
    expect(document.querySelector('dialog')).toBeNull();
    expect(host.textContent).toContain(alternative.repository);
    expect(host.textContent).toContain('题库来源已保存');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(reads).toHaveLength(1);
  });

  it('shows the deployment repository and branch before restoring defaults with the reset contract', async () => {
    const { client, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : json(saved({ source: { ...defaultSource, revision: nextRevision, origin: 'deployment' } })));
    const { host } = mount(client); await settle();
    button(host, '恢复默认').click(); await settle();
    expect(dialog().textContent).toContain('恢复默认题库来源');
    expect(dialog().textContent).toContain(defaultSource.repository);
    expect(dialog().textContent).toContain(defaultSource.ref);
    expect(dialog().textContent).not.toContain(sourceState().source.repository);
    expect(writes).toHaveLength(0);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(JSON.parse(String(writes[0]!.body))).toEqual({ reset: true, expectedRevision: revision, confirmation: 'change-bank-source' });
    expect(host.textContent).toContain('部署默认');
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === '恢复默认')).toBe(false);
  });

  it('does not submit when confirmation is cancelled and preserves the edited fields', async () => {
    const { client, writes } = await clientWith(() => json(sourceState()));
    const { host } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '取消').click(); await settle();
    expect(document.querySelector('dialog')).toBeNull();
    expect(writes).toHaveLength(0);
    expect(host.querySelector<HTMLInputElement>('#bank-source-repository')?.value).toBe(alternative.repository);
    expect(host.querySelector<HTMLInputElement>('#bank-source-ref')?.value).toBe(alternative.ref);
  });

  it.each(['pending', 'locked'] as const)('blocks editing and restoring defaults while %s', async (reason) => {
    const { client, writes } = await clientWith(() => json(sourceState(reason === 'pending' ? { pending: { ...alternative, commit } } : {})));
    const { host } = mount(client, { locked: reason === 'locked' }); await settle();
    expect(button(host, '更改来源').disabled).toBe(true);
    expect(button(host, '恢复默认').disabled).toBe(true);
    button(host, '更改来源').click(); button(host, '恢复默认').click(); await settle();
    expect(host.querySelector('form')).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
    expect(writes).toHaveLength(0);
    if (reason === 'pending') expect(host.textContent).toContain('请先重启 Core');
  });

  it('closes an open confirmation on maintenance lock while preserving edits for a new confirmation', async () => {
    const { client, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : json(saved()));
    const { host, props } = mount(client); await settle(); await edit(host); await prepare(host);
    const oldConfirm = button(dialog(), '确认保存来源');
    props.locked = true; await settle();
    expect(document.querySelector('dialog')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('#bank-source-repository')?.value).toBe(alternative.repository);
    expect(host.querySelector<HTMLInputElement>('#bank-source-ref')?.value).toBe(alternative.ref);
    expect(button(host, '保存来源').disabled).toBe(true);
    oldConfirm.click(); await settle();
    expect(writes).toHaveLength(0);
    props.locked = false; await settle();
    expect(document.querySelector('dialog')).toBeNull();
    expect(button(host, '保存来源').disabled).toBe(false);
    await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]!.body))).toEqual({ ...alternative, expectedRevision: revision, confirmation: 'change-bank-source' });
  });

  it('treats repository case and the optional .git suffix as an unchanged source', async () => {
    const { client, writes } = await clientWith(() => json(sourceState()));
    const { host } = mount(client); await settle();
    await edit(host, 'https://github.com/EXAMPLE/CURRENT-BANK.git', 'main');
    expect(button(host, '保存来源').disabled).toBe(true);
    await prepare(host);
    expect(document.querySelector('dialog')).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['https://github.com.evil.example/owner/bank', 'main'],
    ['https://github.com/owner/bank?token=secret', 'main'],
    ['https://username:password@github.com/owner/bank', 'main'],
    ['git@github.com:owner/bank.git', 'main'],
    [alternative.repository, 'release/../main'],
    [alternative.repository, 'release//main'],
    [alternative.repository, 'release/branch.lock'],
    [alternative.repository, 'release/'],
  ])('rejects invalid source %s at %s before opening confirmation', async (repository, ref) => {
    const { client, writes } = await clientWith(() => json(sourceState()));
    const { host } = mount(client); await settle(); await edit(host, repository, ref); await prepare(host);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('公开 GitHub HTTPS 仓库地址和有效分支名');
    expect(document.querySelector('dialog')).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it('preserves the selected source and edit after a failed write without automatically retrying', async () => {
    const { client, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : Promise.reject(new TypeError('connection lost')));
    const { host, changed } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('操作结果尚未确认');
    expect(host.textContent).toContain(sourceState().source.repository);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); await settle();
    expect(writes).toHaveLength(1);
    button(dialog(), '取消').click(); await settle();
    expect(host.querySelector<HTMLInputElement>('#bank-source-repository')?.value).toBe(alternative.repository);
    expect(host.querySelector<HTMLInputElement>('#bank-source-ref')?.value).toBe(alternative.ref);
  });

  it('reports revision conflict without treating the proposed source as saved', async () => {
    const { client, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : json({ error: { code: 'BANK_SOURCE_CHANGED' } }, 409));
    const { host, changed } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('刷新来源并重新确认');
    expect(host.textContent).toContain(sourceState().source.repository);
    expect(changed).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it('adopts an uncertain persisted result with an explicit storage notice', async () => {
    const { client } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : json(saved({ durability: 'uncertain' })));
    const { host, changed } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(document.querySelector('dialog')).toBeNull();
    expect(host.textContent).toContain(alternative.repository);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('持久保存尚未确认');
    expect(host.textContent).not.toContain('题库来源已保存');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed save response without replacing the previously loaded source', async () => {
    const { client } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : json(saved({ latestCommit: 'invalid-commit' })));
    const { host, changed } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('保存结果无法确认');
    expect(host.textContent).toContain(sourceState().source.repository);
    expect(changed).not.toHaveBeenCalled();
  });

  it('replaces an in-flight read on generation change and ignores its late result', async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    let read = 0;
    const { client, reads } = await clientWith(() => ++read === 1 ? first.promise : second.promise);
    const { host, props, changed, sessionLost } = mount(client); await nextTick();
    props.generation++; await settle();
    expect(reads).toHaveLength(2);
    expect(reads[0]!.signal?.aborted).toBe(true);
    second.resolve(json(sourceState({ source: { ...alternative, revision: nextRevision, origin: 'override' } }))); await settle();
    expect(host.textContent).toContain(alternative.repository);
    first.resolve(json(sourceState())); await settle();
    expect(host.textContent).not.toContain(sourceState().source.repository);
    expect(host.textContent).toContain(alternative.repository);
    expect(changed).not.toHaveBeenCalled();
    expect(sessionLost).not.toHaveBeenCalled();
  });

  it('clears a prepared confirmation when refreshed and requires confirming the new revision', async () => {
    let read = 0;
    const { client, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState({ source: { ...sourceState().source, revision: ++read === 1 ? revision : nextRevision } })) : json(saved()));
    const { host, props } = mount(client); await settle(); await edit(host); await prepare(host);
    props.generation++; await settle();
    expect(document.querySelector('dialog')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(JSON.parse(String(writes[0]!.body)).expectedRevision).toBe(nextRevision);
  });

  it('does not interrupt an in-flight save for maintenance locking or a parent refresh', async () => {
    const pending = deferred<Response>();
    const { client, reads, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : pending.promise);
    const { host, props, changed } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    props.locked = true; props.generation++; await settle();
    expect(reads).toHaveLength(1);
    expect(writes[0]!.signal?.aborted).toBe(false);
    expect(button(dialog(), '正在提交…').disabled).toBe(true);
    pending.resolve(json(saved())); await settle();
    expect(host.textContent).toContain(alternative.repository);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('clears stale configuration when a manual refresh fails', async () => {
    let reads = 0;
    const { client } = await clientWith(() => ++reads === 1 ? json(sourceState()) : json({ error: { code: 'BANK_SOURCE_UNAVAILABLE' } }, 503));
    const { host } = mount(client); await settle();
    button(host, '刷新来源').click(); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('题库来源配置无法读取');
    expect(host.textContent).not.toContain(sourceState().source.repository);
    expect(host.textContent).not.toContain('更改来源');
  });

  it('emits sessionLost for a rejected authenticated write without reporting success', async () => {
    const { client, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : json({ error: { code: 'INVALID_SESSION' } }, 401));
    const { host, sessionLost, changed } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle();
    expect(sessionLost).toHaveBeenCalledTimes(1);
    expect(client.session).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it('aborts a read on unmount and ignores its late response', async () => {
    const pending = deferred<Response>();
    const { client, reads } = await clientWith(() => pending.promise);
    const { host, unmount, changed, sessionLost } = mount(client); await settle();
    unmount();
    expect(reads[0]!.signal?.aborted).toBe(true);
    pending.resolve(json(sourceState())); await settle();
    expect(host.innerHTML).toBe('');
    expect(changed).not.toHaveBeenCalled();
    expect(sessionLost).not.toHaveBeenCalled();
  });

  it('does not cancel or apply an in-flight write after unmount', async () => {
    const pending = deferred<Response>();
    const { client, writes } = await clientWith((init) => init.method === 'GET' ? json(sourceState()) : pending.promise);
    const { host, unmount, changed, sessionLost } = mount(client); await settle(); await edit(host); await prepare(host);
    button(dialog(), '确认保存来源').click(); await settle(); unmount();
    expect(writes[0]!.signal?.aborted).toBe(false);
    expect(document.querySelector('dialog')).toBeNull();
    pending.resolve(json(saved())); await settle();
    expect(host.innerHTML).toBe('');
    expect(changed).not.toHaveBeenCalled();
    expect(sessionLost).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });
});
