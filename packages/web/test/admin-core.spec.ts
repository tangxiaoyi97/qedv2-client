import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { ManagementClient } from '../src/admin/api.js';
import CorePanel from '../src/admin/CorePanel.vue';

const apps: App[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const scroll = vi.fn();
const historicalJob = { id: 'history-job', operation: 'validate', status: 'succeeded', startedAt: '2026-09-13T12:00:00Z', finishedAt: '2026-09-13T12:00:10Z' };
const runningJob = { id: 'active-job', operation: 'validate', status: 'running', startedAt: '2026-09-14T12:00:00Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const info = (activeJob: unknown = null) => ({ version: '1.15.0', health: { status: 'ok' }, management: { capabilities: { jobHistory: true }, activeJob } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function clientWith(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const paths: string[] = [];
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname.replace(/^\/management/, '');
    if (path === '/auth/login') return json({ token: 'test-admin-token-1234567890', requiresPasswordSetup: false, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    paths.push(path);
    return handler(path, init);
  });
  const client = new ManagementClient('https://core.example', transport);
  await client.login('test-password');
  return { client, count: (path: string) => paths.filter((item) => item === path).length };
}

function mount(client: ManagementClient) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(CorePanel, { client });
  app.mount(host);
  apps.push(app);
  return host;
}

async function settle() {
  await nextTick();
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
}

function button(host: ParentNode, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(found, `button: ${label}`).toBeTruthy();
  return found!;
}

function detailsTrigger(host: ParentNode, id = historicalJob.id) {
  const row = [...host.querySelectorAll('tbody tr')].find((item) => item.textContent?.includes(id));
  expect(row, `history row: ${id}`).toBeTruthy();
  return button(row!, '详情');
}

function details(host: ParentNode) {
  const region = host.querySelector<HTMLElement>('.detail-region');
  expect(region, 'job detail region').not.toBeNull();
  return region!;
}

beforeEach(() => {
  vi.useFakeTimers();
  scroll.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
});

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('Core maintenance task details', () => {
  it('fetches and focuses each opening, including the same task again, and restores its row trigger on close', async () => {
    let revision = 0;
    const { client, count } = await clientWith((path) => {
      if (path === '/info') return json(info());
      if (path === '/jobs') return json({ items: [historicalJob] });
      if (path === '/jobs/history-job') return json({ job: { ...historicalJob, result: { rootSha256: `result-revision-${++revision}` } } });
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    const trigger = detailsTrigger(host);
    trigger.focus(); trigger.click(); await settle();
    const firstRegion = details(host);
    expect(firstRegion.getAttribute('tabindex')).toBe('-1');
    expect(firstRegion.textContent).toContain('result-revision-1');
    expect(document.activeElement).toBe(firstRegion);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });

    scroll.mockClear();
    trigger.focus(); trigger.click(); await settle();
    expect(count('/jobs/history-job')).toBe(2);
    expect(details(host).textContent).toContain('result-revision-2');
    expect(details(host).textContent).not.toContain('result-revision-1');
    expect(document.activeElement).toBe(details(host));
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });

    button(details(host), '关闭详情').click(); await settle();
    expect(host.querySelector('.detail-region')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest' });

    trigger.click(); await settle();
    expect(count('/jobs/history-job')).toBe(3);
    expect(details(host).textContent).toContain('result-revision-3');
    expect(document.activeElement).toBe(details(host));
  });

  it('clears the previous successful result immediately and retains an error region when the new read fails', async () => {
    const retry = deferred<Response>();
    let reads = 0;
    const { client } = await clientWith((path) => {
      if (path === '/info') return json(info());
      if (path === '/jobs') return json({ items: [historicalJob] });
      if (path === '/jobs/history-job') return ++reads === 1
        ? json({ job: { ...historicalJob, result: { rootSha256: 'prior-success-digest' } } })
        : retry.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    const trigger = detailsTrigger(host);
    trigger.click(); await settle();
    expect(details(host).textContent).toContain('prior-success-digest');

    button(details(host), '刷新任务状态').click(); await nextTick();
    expect(details(host).textContent).not.toContain('prior-success-digest');
    expect(details(host).textContent).not.toContain('任务已完成。');
    expect(details(host).querySelector('[role="status"]')?.textContent).toMatch(/正在|加载/);

    retry.resolve(json({ error: { code: 'MANAGEMENT_ERROR' } }, 500)); await settle();
    expect(details(host).querySelector('[role="alert"]')?.textContent).toContain('节点处理请求失败');
    expect(details(host).textContent).not.toContain('prior-success-digest');
    expect(details(host).textContent).not.toContain('任务已完成。');
    expect(button(details(host), '关闭详情').disabled).toBe(false);
  });

  it('aborts a pending detail read on close and ignores its late successful response', async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    const { client } = await clientWith((path, init) => {
      if (path === '/info') return json(info());
      if (path === '/jobs') return json({ items: [historicalJob] });
      if (path === '/jobs/history-job') { signal = init?.signal ?? undefined; return pending.promise; }
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    const trigger = detailsTrigger(host);
    trigger.focus(); trigger.click(); await nextTick();
    expect(details(host).getAttribute('tabindex')).toBe('-1');
    expect(details(host).querySelector('[role="status"]')?.textContent).toMatch(/正在|加载/);
    button(details(host), '关闭详情').click(); await settle();
    expect(signal?.aborted).toBe(true);
    expect(host.querySelector('.detail-region')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    pending.resolve(json({ job: { ...historicalJob, result: { rootSha256: 'late-closed-result' } } })); await settle();
    expect(host.querySelector('.detail-region')).toBeNull();
    expect(host.textContent).not.toContain('late-closed-result');
    expect(document.activeElement).toBe(trigger);
  });

  it('continues polling the active task while viewing and closing history, then refreshes status and history on completion', async () => {
    let polls = 0;
    let completed = false;
    const { client, count } = await clientWith((path) => {
      if (path === '/info') return json(info(completed ? null : runningJob));
      if (path === '/jobs') return json({ items: [historicalJob] });
      if (path === '/jobs/history-job') return json({ job: { ...historicalJob, result: { rootSha256: 'history-only-result' } } });
      if (path === '/jobs/active-job') {
        completed = ++polls === 3;
        return json({ job: completed ? { ...runningJob, status: 'succeeded', finishedAt: '2026-09-14T12:00:10Z' } : runningJob });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    detailsTrigger(host).click(); await settle();
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(count('/jobs/active-job')).toBe(1);
    expect(details(host).textContent).toContain('history-only-result');
    expect(details(host).textContent).not.toContain('active-job');

    button(details(host), '关闭详情').click(); await settle();
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(count('/jobs/active-job')).toBe(2);
    expect(host.querySelector('.detail-region')).toBeNull();

    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(count('/jobs/active-job')).toBe(3);
    expect(count('/info')).toBe(2);
    expect(count('/jobs')).toBe(2);
    expect(host.querySelector('.detail-region')).toBeNull();
    await vi.advanceTimersByTimeAsync(4000); await settle();
    expect(count('/jobs/active-job')).toBe(3);
  });
});

describe('Core bank update decisions', () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  const checked = (status: 'up_to_date' | 'update_available' | 'pending_restart') => ({ currentCommit: A,
    latestCommit: status === 'up_to_date' ? A : B, pendingCommit: status === 'pending_restart' ? B : null,
    status, requiresRestart: status === 'pending_restart', checkedAt: new Date().toISOString(), repository: 'https://github.com/example/bank.git', ref: 'main' });
  const nodeInfo = (supported = true) => ({ ...info(), bank: { commit: A }, management: { capabilities: { jobHistory: true, validate: true, bankUpdate: true, bankUpdateCheck: supported, restart: true }, activeJob: null } });
  it('waits for an in-flight version check before offering validation or restart', async () => {
    const pending = deferred<Response>();
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] }) : pending.promise);
    const host = mount(client); await settle();
    expect(button(host, '校验题库').disabled).toBe(true);
    expect(button(host, '重启 Core').disabled).toBe(true);
    pending.resolve(json(checked('up_to_date'))); await settle();
    expect(button(host, '校验题库').disabled).toBe(false);
    expect(button(host, '重启 Core').disabled).toBe(false);
  });
  it.each([['up_to_date', '重新安装', '确认重新安装', 'reinstall', A], ['update_available', '更新题库', '确认更新', 'update', B]] as const)('uses the %s action and submits the exact confirmed commit once', async (status, label, confirm, mode, expectedCommit) => {
    const writes: unknown[] = [];
    const { client } = await clientWith((path, init) => {
      if (path === '/info') return json(nodeInfo());
      if (path === '/jobs') return json({ items: [] });
      if (path === '/core/update-check') return json(checked(status));
      if (path === '/core/update') { writes.push(JSON.parse(String(init?.body))); return json({ job: { ...runningJob, operation: 'bank-update' } }, 202); }
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    expect(host.textContent).toContain(expectedCommit);
    expect(button(host, label).disabled).toBe(false);
    if (status === 'up_to_date') expect([...host.querySelectorAll('button')].some((b) => b.textContent?.trim() === '更新题库')).toBe(false);
    button(host, label).click(); await settle();
    expect(document.querySelector('dialog')?.textContent).toContain(expectedCommit);
    const submit = button(document, confirm); submit.click(); submit.click(); await settle();
    expect(writes).toEqual([{ mode, expectedCommit }]);
    expect(details(host).textContent).toContain('active-job');
  });
  it('shows pending activation and offers restart without downloading again', async () => {
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] }) : json(checked('pending_restart')));
    const host = mount(client); await settle();
    expect(host.textContent).toContain('待重启题库'); expect(host.textContent).toContain(B);
    expect([...host.querySelectorAll('button')].some((b) => ['更新题库', '重新安装'].includes(b.textContent?.trim() ?? ''))).toBe(false);
    expect(button(host, '重启 Core').disabled).toBe(false);
  });
  it('treats the same commit from a different source as an update and confirms both source revision and commit', async () => {
    const revision = 'd'.repeat(64), repository = 'https://github.com/example/new-bank';
    const writes: unknown[] = [];
    const { client } = await clientWith((path, init) => {
      if (path === '/info') return json(nodeInfo());
      if (path === '/jobs') return json({ items: [] });
      if (path === '/core/update-check') return json({ ...checked('update_available'), latestCommit: A, repository,
        sourceRevision: revision, sourceChanged: true, currentSource: { repository: 'https://github.com/example/old-bank', ref: 'main', commit: A }, pendingSource: null });
      if (path === '/core/update') { writes.push(JSON.parse(String(init?.body))); return json({ job: runningJob }, 202); }
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    expect(host.textContent).toContain('获取来源已更改');
    button(host, '更新题库').click(); await settle();
    expect(document.querySelector('dialog')?.textContent).toContain(repository);
    button(document, '确认更新').click(); await settle();
    expect(writes).toEqual([{ mode: 'update', expectedCommit: A, expectedSourceRevision: revision, expectedPendingCommit: null }]);
  });
  it('rejects inconsistent source identity instead of enabling an update from ambiguous metadata', async () => {
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] }) : json({ ...checked('update_available'), sourceRevision: 'd'.repeat(64), sourceChanged: false,
      currentSource: { repository: 'https://github.com/example/different-bank', ref: 'main', commit: A }, pendingSource: null }));
    const host = mount(client); await settle();
    expect(button(host, '更新题库').disabled).toBe(true);
    expect(host.textContent).toContain('题库来源检查结果无效');
  });
  it('blocks maintenance during a source save and replaces the old update confirmation with the saved source', async () => {
    const oldSource = { repository: 'https://github.com/example/old-bank', ref: 'main' };
    const newSource = { repository: 'https://github.com/example/new-bank', ref: 'main' };
    let source = { ...oldSource, revision: 'd'.repeat(64), origin: 'override' };
    const pending = deferred<Response>(), writes: unknown[] = [];
    const state = () => ({ source, defaultSource: oldSource, current: { ...oldSource, commit: A }, pending: null });
    const { client } = await clientWith((path, init) => {
      if (path === '/info') { const value = nodeInfo(); return json({ ...value, management: { ...value.management, capabilities: { ...value.management.capabilities, bankSource: true } } }); }
      if (path === '/jobs') return json({ items: [] });
      if (path === '/core/bank-source') return init?.method === 'POST' ? pending.promise : json(state());
      if (path === '/core/update-check') return json({ ...checked(source.repository === oldSource.repository ? 'up_to_date' : 'update_available'), ...source,
        sourceRevision: source.revision, sourceChanged: source.repository !== oldSource.repository, currentSource: { ...oldSource, commit: A }, pendingSource: null });
      if (path === '/core/update') { writes.push(JSON.parse(String(init?.body))); return json({ job: runningJob }, 202); }
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    expect(button(host, '重新安装').disabled).toBe(false);
    button(host, '更改来源').click(); await settle();
    const field = host.querySelector<HTMLInputElement>('#bank-source-repository')!;
    field.value = newSource.repository; field.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    button(document, '确认保存来源').click(); await settle();
    expect(button(host, '校验题库').disabled).toBe(true);
    expect(button(host, '重新安装').disabled).toBe(true);
    expect(button(host, '重启 Core').disabled).toBe(true);
    source = { ...newSource, revision: 'e'.repeat(64), origin: 'override' };
    pending.resolve(json({ ...state(), latestCommit: B, changed: true, durability: 'confirmed' })); await settle();
    expect(host.textContent).toContain('题库来源已保存。');
    button(host, '更新题库').click(); await settle();
    expect(document.querySelector('dialog')?.textContent).toContain(newSource.repository);
    button(document, '确认更新').click(); await settle();
    expect(writes).toEqual([{ mode: 'update', expectedCommit: B, expectedSourceRevision: source.revision, expectedPendingCommit: null }]);
  });
  it('returns to the completed history row when the reinstall trigger is removed after staging', async () => {
    let started = false, completed = false;
    const stagedJob = { ...runningJob, operation: 'bank-update', status: 'succeeded', result: { action: 'reinstall', requiresRestart: true } };
    const { client } = await clientWith((path) => {
      if (path === '/info') return json(nodeInfo());
      if (path === '/jobs') return json({ items: started ? [completed ? stagedJob : { ...runningJob, operation: 'bank-update' }] : [] });
      if (path === '/core/update-check') return json(completed ? { ...checked('pending_restart'), latestCommit: A, pendingCommit: A } : checked('up_to_date'));
      if (path === '/core/update') { started = true; return json({ job: { ...runningJob, operation: 'bank-update' } }, 202); }
      if (path === '/jobs/active-job') { completed = true; return json({ job: stagedJob }); }
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = mount(client); await settle();
    const trigger = button(host, '重新安装'); trigger.focus(); trigger.click(); await settle();
    button(document, '确认重新安装').click(); await settle();
    expect(document.activeElement).toBe(details(host));
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(trigger.isConnected).toBe(false);
    expect(details(host).textContent).toContain('题库已重新安装');
    const rowTrigger = detailsTrigger(host, runningJob.id);
    button(details(host), '关闭详情').click(); await settle();
    expect(document.activeElement).toBe(rowTrigger);
  });
  it('keeps an older pending commit visible alongside a newer upstream commit and confirms its replacement', async () => {
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] }) : json({ ...checked('update_available'), latestCommit: C, pendingCommit: B, requiresRestart: true }));
    const host = mount(client); await settle();
    expect(host.textContent).toContain(B); expect(host.textContent).toContain(C);
    button(host, '更新题库').click(); await settle();
    expect(document.querySelector('dialog')?.textContent).toContain('将替换待重启题库');
    expect(document.querySelector('dialog')?.textContent).toContain(B);
  });
  it('clears a previous latest result and disables writes after a failed check', async () => {
    let checks = 0;
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] })
      : ++checks === 1 ? json(checked('up_to_date')) : json({ error: { code: 'BANK_UPDATE_CHECK_FAILED' } }, 503));
    const host = mount(client); await settle();
    button(host, '检查更新').click(); await settle();
    expect(host.textContent).toContain('无法检查远端题库版本'); expect(host.textContent).not.toContain('已是最新版本');
    expect(button(host, '更新题库').disabled).toBe(true);
  });
  it('expires the checked version and an open confirmation instead of reusing stale approval', async () => {
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] }) : json(checked('up_to_date')));
    const host = mount(client); await settle();
    button(host, '重新安装').click(); await settle(); expect(document.querySelector('dialog')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(300_000); await settle();
    expect(document.querySelector('dialog')).toBeNull(); expect(host.textContent).toContain('版本检查已过期');
    expect(button(host, '更新题库').disabled).toBe(true);
  });
  it('does not guess update status when the Core lacks the check capability', async () => {
    const { client, count } = await clientWith((path) => path === '/info' ? json(nodeInfo(false)) : json({ items: [] }));
    const host = mount(client); await settle();
    expect(host.textContent).toContain('请升级 Core'); expect(button(host, '更新题库').disabled).toBe(true);
    expect(count('/core/update-check')).toBe(0);
  });
  it('still expires a check after an unrelated maintenance request fails', async () => {
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] })
      : path === '/core/validate' ? json({ error: { code: 'MANAGEMENT_ERROR' } }, 500) : json(checked('up_to_date')));
    const host = mount(client); await settle();
    button(host, '校验题库').click(); await settle();
    await vi.advanceTimersByTimeAsync(300_000); await settle();
    expect(host.textContent).toContain('版本检查已过期'); expect(button(host, '更新题库').disabled).toBe(true);
  });
  it('rejects an internally inconsistent latest response', async () => {
    const { client } = await clientWith((path) => path === '/info' ? json(nodeInfo()) : path === '/jobs' ? json({ items: [] }) : json({ ...checked('up_to_date'), currentCommit: B }));
    const host = mount(client); await settle();
    expect(host.textContent).toContain('检查结果无效'); expect(button(host, '更新题库').disabled).toBe(true);
  });
});
