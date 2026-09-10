import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE } from '@qed2/core-logic';
import HistoryView from '../src/routes/HistoryView.vue';
import historySource from '../src/routes/HistoryView.vue?raw';
import { historyLog, localProfileStore, storage } from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe('HistoryView activity filter', () => {
  it('keeps long titles shrinkable on narrow phones while preserving score and time columns', () => {
    const css = historySource.slice(historySource.indexOf('<style scoped>'));
    const title = css.match(/\.hist__row-title\s*\{([^}]*)\}/u)?.[1] ?? '';
    const copyRules = [...css.matchAll(/\.hist__row-copy\s*\{([^}]*)\}/gu)].map(match => match[1]);
    expect(title).toMatch(/flex:\s*1\s+1\s+0%/u);
    expect(title).toMatch(/min-width:\s*0/u);
    expect(title).toMatch(/max-width:\s*100%/u);
    expect(title).toMatch(/overflow:\s*hidden/u);
    expect(title).toMatch(/text-overflow:\s*ellipsis/u);
    // A previous <=420px column override let the inline title use its full
    // intrinsic width and paint over the score, despite a bounded outer grid.
    expect(copyRules.every(rule => !/flex-direction:\s*column/u.test(rule ?? ''))).toBe(true);
    for (const className of ['hist__row-points', 'hist__row-time']) {
      const rules = [...css.matchAll(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`, 'gu'))];
      expect(rules.every(match => !/display:\s*none|visibility:\s*hidden/u.test(match[1] ?? ''))).toBe(true);
    }
  });

  beforeEach(async () => {
    await storage.clear(STORAGE.app);
    await storage.clear(STORAGE.archive);
    await storage.clear(STORAGE.auth);
    await storage.clear(STORAGE.history);
    await localProfileStore.initialize();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('filters the full local history by a clicked heatmap day and toggles it off', async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
    const todayKey = localDayKey(today);
    const yesterdayKey = localDayKey(yesterday);

    await historyLog.append({
      partId: 'part-today',
      questionId: 'question-today',
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      grading: 'good',
      gradedAt: today.toISOString(),
    });
    await historyLog.append({
      partId: 'part-yesterday',
      questionId: 'question-yesterday',
      verdict: 'incorrect',
      awardedPoints: 0,
      maxPoints: 1,
      grading: 'baffled',
      gradedAt: yesterday.toISOString(),
    });
    const snapshotSpy = vi.spyOn(historyLog, 'snapshot');

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(HistoryView);
    app.use(pinia);
    app.use(router);
    app.mount(host);
    await settle();

    await vi.waitFor(
      () => expect(host.querySelectorAll('.hist__row')).toHaveLength(2),
      { timeout: 5_000 },
    );
    expect(snapshotSpy).toHaveBeenCalledTimes(1);

    host
      .querySelector<SVGGElement>(`[data-key="${yesterdayKey}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(host.querySelectorAll('.hist__row')).toHaveLength(1);
      expect(host.textContent).toContain('question-yesterday');
      expect(host.textContent).not.toContain('question-today');
    }, { timeout: 5_000 });
    expect(host.textContent).toContain('1 Antwort');
    expect(host.querySelector(`[data-key="${yesterdayKey}"]`)?.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('Verlauf gefiltert:');

    host
      .querySelector<SVGGElement>(`[data-key="${yesterdayKey}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(
      () => expect(host.querySelectorAll('.hist__row')).toHaveLength(2),
      { timeout: 5_000 },
    );
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(host.querySelector(`[data-key="${todayKey}"]`)).not.toBeNull();

    app.unmount();
  });

  it('keeps the latest date and its height reservation through out-of-order filter responses', async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const days = [2, 1, 0].map(offset => new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, 12));
    const keys = days.map(localDayKey);
    const pending = new Map<string, (response: Response) => void>();
    const historyResponse = (day: Date, questions: string[]) => new Response(JSON.stringify({
      items: questions.map(questionId => ({
        id: `attempt-${questionId}`, questionId, partId: `part-${questionId}`,
        correct: true, awardedPoints: 1, gradedAt: day.toISOString(),
      })),
      page: 1, pageSize: 50, total: questions.length,
    }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/me/history/activity')) {
        return new Response(JSON.stringify({ activity: Object.fromEntries(keys.map(key => [key, 2])) }), { status: 200 });
      }
      if (url.pathname.endsWith('/me/history')) {
        const since = url.searchParams.get('since');
        if (!since) return historyResponse(today, ['initial-history']);
        return new Promise<Response>(resolve => { pending.set(localDayKey(new Date(since)), resolve); });
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.session = {
      token: 'filter-test-token', expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'filter-user', username: 'tester' }, serverBaseUrl: useAppStore().config.serverBaseUrl,
    };
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const vueApp = createApp(HistoryView).use(pinia).use(router);
    vueApp.mount(host);
    let observer: MutationObserver | undefined;
    let restoreRect: (() => void) | undefined;
    try {
      await vi.waitFor(() => expect(host.querySelector('.hist__row')?.textContent).toContain('initial-history'));
      const stage = host.querySelector<HTMLElement>('.hist__stage')!;
      await vi.waitFor(() => expect(stage.getAttribute('aria-busy')).toBe('false'));
      // jsdom has no layout; simulate the already-scrolled long result list.
      const rect = vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ height: 960 } as DOMRect);
      restoreRect = () => rect.mockRestore();
      for (const key of keys) {
        host.querySelector<SVGGElement>(`[data-key="${key}"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextTick();
      }
      await vi.waitFor(() => expect(pending.size).toBe(3));
      expect(stage.style.minHeight).toBe('960px');
      expect(stage.getAttribute('aria-busy')).toBe('true');
      await vi.waitFor(() => expect(stage.querySelectorAll('.hist__row')).toHaveLength(0));

      // The oldest response must not dismiss the final date's loader or
      // release its footprint while that final request is still pending.
      pending.get(keys[0]!)!(historyResponse(days[0]!, ['obsolete-oldest']));
      await settle();
      expect(stage.getAttribute('aria-busy')).toBe('true');
      expect(stage.style.minHeight).toBe('960px');
      expect(stage.querySelectorAll('.hist__row')).toHaveLength(0);
      expect(host.querySelector(`[data-key="${keys[2]}"]`)?.getAttribute('aria-pressed')).toBe('true');

      const replacements: Array<{ minHeight: string; busy: string | null }> = [];
      observer = new MutationObserver(() => {
        if (stage.textContent?.includes('latest-one')) {
          replacements.push({ minHeight: stage.style.minHeight, busy: stage.getAttribute('aria-busy') });
        }
      });
      observer.observe(stage, { attributes: true, childList: true, subtree: true });
      pending.get(keys[2]!)!(historyResponse(days[2]!, ['latest-one', 'latest-two']));
      await vi.waitFor(() => {
        expect(stage.querySelectorAll('.hist__row')).toHaveLength(2);
        expect(stage.style.minHeight).toBe('');
        expect(stage.getAttribute('aria-busy')).toBe('false');
      });
      // Observe actual DOM commits: new rows must mount with the old height
      // still held. Releasing it in the same patch can clamp browser scrollY.
      expect(replacements[0]).toEqual({ minHeight: '960px', busy: 'false' });
      expect(replacements.at(-1)).toEqual({ minHeight: '', busy: 'false' });

      // The middle request arrives last, after the final results are visible.
      pending.get(keys[1]!)!(historyResponse(days[1]!, ['obsolete-middle']));
      await settle();
      expect([...stage.querySelectorAll('.hist__row-title')].map(row => row.textContent)).toEqual(['latest-one', 'latest-two']);
      expect(host.querySelector('.hist__count')?.textContent).toContain('2 Antworten');
      expect(host.querySelector(`[data-key="${keys[2]}"]`)?.getAttribute('aria-pressed')).toBe('true');
      expect(host.querySelector(`[data-key="${keys[1]}"]`)?.getAttribute('aria-pressed')).toBe('false');
      expect(stage.getAttribute('aria-busy')).toBe('false');
      expect(stage.style.minHeight).toBe('');
      expect(host.textContent).not.toContain('obsolete-');
    } finally {
      observer?.disconnect();
      restoreRect?.();
      vueApp.unmount();
      pending.forEach(resolve => resolve(historyResponse(today, [])));
      await settle();
    }
  });

  it('reopens a local history row through its original Core source and revision', async () => {
    const commit = 'c'.repeat(40);
    await historyLog.append({
      partId: 'part-local',
      questionId: 'question-local',
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      grading: 'good',
      gradedAt: new Date().toISOString(),
      contentSource: 'local',
      contentId: commit,
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(HistoryView);
    app.use(pinia);
    app.use(router);
    app.mount(host);

    await vi.waitFor(() => expect(host.querySelector('.hist__row')).not.toBeNull());
    const row = host.querySelector<HTMLButtonElement>('.hist__row');
    expect(row?.textContent).toContain('question-local');
    expect(row?.textContent).toContain('1/1 P');
    expect(row?.textContent).not.toContain('part-local');
    expect(row?.textContent).not.toContain('Lokal');
    expect(row?.querySelector('.hist__row-source')).toBeNull();
    expect(row?.querySelector('.hist__row-provenance')).toBeNull();
    expect(row?.getAttribute('aria-label')).toContain('Erneut üben');
    expect(row?.getAttribute('aria-label')).toContain(`Quelle Lokal, Bank ${commit.slice(0, 7)}`);
    expect(host.textContent).not.toContain('auf diesem Gerät gespeichert');
    row?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/practice'));
    expect(router.currentRoute.value.query).toMatchObject({
      questions: 'question-local',
      focus: 'question-local',
      coreSource: 'local',
      contentId: commit,
    });
    app.unmount();
  });

  it('loads account activity from the aggregate endpoint in one local-time-zone request', async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayKey = localDayKey(today);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/me/history/activity?')) {
        return new Response(JSON.stringify({ activity: { [todayKey]: 7 } }), { status: 200 });
      }
      if (url.includes('/me/history?')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'attempt-1',
            questionId: 'question-cloud',
            partId: 'part-cloud',
            correct: true,
            awardedPoints: 1,
            gradedAt: today.toISOString(),
          }],
          page: 1,
          pageSize: 50,
          total: 1,
        }), { status: 200 });
      }
      if (url.endsWith('/content/questions/batch')) {
        return new Response(JSON.stringify({ questions: [], missing: ['question-cloud'] }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.session = {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
      serverBaseUrl: useAppStore().config.serverBaseUrl,
    };
    useAppStore().setTokenProvider(() => auth.session?.token);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(HistoryView);
    app.use(pinia);
    app.use(router);
    app.mount(host);

    await vi.waitFor(() => expect(host.querySelectorAll('.hist__row')).toHaveLength(1));
    await vi.waitFor(() => {
      expect(host.querySelector(`[data-key="${todayKey}"]`)?.getAttribute('aria-label')).toContain('7 Aufgaben');
    });

    const aggregateCalls = calls.filter((url) => url.includes('/me/history/activity?'));
    expect(aggregateCalls).toHaveLength(1);
    const decoded = decodeURIComponent(aggregateCalls[0]!);
    expect(decoded).toContain('since=');
    expect(decoded).toContain('until=');
    expect(decoded).toContain('timeZone=');
    expect(calls.some((url) => url.includes('pageSize=200'))).toBe(false);

    // Rows written by pre-provenance clients must be honest about replaying
    // against today's bank. They never receive a fabricated source/revision.
    expect(host.querySelector('.hist__row-provenance')?.getAttribute('title')).toBe('Version unbekannt');
    expect(host.textContent).not.toContain('Wiederholung mit aktueller Bank');
    expect(host.textContent).not.toContain('Verlauf aus deinem Konto');
    const legacyRow = host.querySelector<HTMLButtonElement>('.hist__row');
    expect(legacyRow?.getAttribute('aria-label')).toContain('Version unbekannt');
    expect(legacyRow?.getAttribute('aria-label')).toContain('Aktuelle Bank muss bestätigt werden');
    expect(calls.some((url) => url.includes('/content/'))).toBe(false);
    legacyRow?.click();
    await nextTick();
    expect(router.currentRoute.value.path).toBe('/history');
    expect(document.body.textContent).toContain('Diese Antwort nennt keine Aufgabenbank.');
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Aktuelle Bank verwenden');
    expect(confirm).toBeDefined();
    confirm?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/practice'));
    expect(router.currentRoute.value.query).toMatchObject({
      questions: 'question-cloud',
      focus: 'question-cloud',
    });
    expect(router.currentRoute.value.query).not.toHaveProperty('coreSource');
    expect(router.currentRoute.value.query).not.toHaveProperty('contentId');

    app.unmount();
  });

  it('ignores an old history response and never sends its bearer to a new endpoint', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldStarted!: () => void;
    const oldStart = new Promise<void>((resolve) => { oldStarted = resolve; });
    const requests: Array<{ hostname: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        hostname: url.hostname,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (url.pathname.endsWith('/me/history/activity')) {
        return new Response(JSON.stringify({ activity: {} }), { status: 200 });
      }
      if (url.pathname.endsWith('/me/history')) {
        if (url.hostname === 'server-a.example') {
          oldStarted();
          await oldGate;
          return new Response(JSON.stringify({
            items: [{
              id: 'old-endpoint-attempt',
              questionId: 'old-endpoint-question',
              partId: 'old-endpoint-part',
              correct: true,
              awardedPoints: 1,
              gradedAt: new Date().toISOString(),
            }],
            page: 1,
            pageSize: 50,
            total: 1,
          }), { status: 200 });
        }
        throw new Error(`old credentials reached ${url.hostname}`);
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const appStore = useAppStore();
    appStore.config = { ...appStore.config, serverBaseUrl: 'https://server-a.example' };
    const auth = useAuthStore();
    auth.session = {
      token: 'endpoint-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
      serverBaseUrl: 'https://server-a.example',
    };
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const vueApp = createApp(HistoryView);
    vueApp.use(pinia);
    vueApp.use(router);
    vueApp.mount(host);

    await oldStart;
    await appStore.updateConfig({ serverBaseUrl: 'https://server-b.example' });
    await vi.waitFor(() => expect(auth.session).toBeUndefined());
    releaseOld();
    await settle();

    expect(host.textContent).not.toContain('old-endpoint-question');
    expect(host.textContent).not.toContain('new-endpoint-question');
    expect(requests.some((request) =>
      request.hostname === 'server-b.example' && request.authorization !== null,
    )).toBe(false);
    vueApp.unmount();
  });

  it('reopens a cloud history row through the recorded Core source and revision', async () => {
    const commit = 'd'.repeat(40);
    const now = new Date().toISOString();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/me/history/activity?')) {
        return new Response(JSON.stringify({ activity: {} }), { status: 200 });
      }
      if (url.includes('/me/history?')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'attempt-provenance',
            questionId: 'question-remote',
            partId: 'part-remote',
            correct: true,
            awardedPoints: 1,
            elapsedMs: null,
            gradedAt: now,
            recordedAt: now,
            contentSource: 'remote',
            contentId: commit,
          }],
          page: 1,
          pageSize: 50,
          total: 1,
        }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.session = {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
      serverBaseUrl: useAppStore().config.serverBaseUrl,
    };
    useAppStore().setTokenProvider(() => auth.session?.token);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(HistoryView);
    app.use(pinia);
    app.use(router);
    app.mount(host);

    await vi.waitFor(() => expect(host.querySelector('.hist__row')).not.toBeNull());
    const row = host.querySelector<HTMLButtonElement>('.hist__row');
    expect(row?.textContent).toContain('question-remote');
    expect(row?.textContent).not.toContain('part-remote');
    expect(row?.textContent).not.toContain('Remote');
    expect(row?.textContent).not.toContain('Version unbekannt');
    expect(row?.querySelector('.hist__row-source')).toBeNull();
    expect(row?.getAttribute('aria-label')).toContain(`Quelle Remote, Bank ${commit.slice(0, 7)}`);
    row?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/practice'));
    expect(router.currentRoute.value.query).toMatchObject({
      questions: 'question-remote',
      focus: 'question-remote',
      coreSource: 'remote',
      contentId: commit,
    });
    app.unmount();
  });

  it('falls back to numbered continuation when a rolling rollback ignores the cursor', async () => {
    const now = new Date().toISOString();
    const calls: string[] = [];
    const item = (id: string) => ({
      id,
      questionId: `question-${id}`,
      partId: `part-${id}`,
      correct: true,
      awardedPoints: 1,
      elapsedMs: null,
      gradedAt: now,
      recordedAt: now,
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/me/history/activity?')) {
        return new Response(JSON.stringify({ activity: {} }), { status: 200 });
      }
      if (url.includes('/me/history?')) {
        const parsed = new URL(url);
        if (parsed.searchParams.get('cursor') === 'cursor-1') {
          // 2.1-style response: cursor was ignored and page 1 came back.
          return new Response(JSON.stringify({
            items: [item('one')], page: 1, pageSize: 50, total: 2,
          }), { status: 200 });
        }
        if (parsed.searchParams.get('page') === '2') {
          return new Response(JSON.stringify({
            items: [item('two')], page: 2, pageSize: 50, total: 2,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          items: [item('one')],
          page: 1,
          pageSize: 50,
          total: 2,
          hasMore: true,
          nextCursor: 'cursor-1',
        }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.session = {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
      serverBaseUrl: useAppStore().config.serverBaseUrl,
    };
    useAppStore().setTokenProvider(() => auth.session?.token);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(HistoryView);
    app.use(pinia);
    app.use(router);
    app.mount(host);

    await vi.waitFor(() => expect(host.querySelectorAll('.hist__row')).toHaveLength(1));
    const more = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Mehr laden');
    expect(more).toBeDefined();
    more?.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.hist__row')).toHaveLength(2));
    expect(host.textContent).toContain('question-one');
    expect(host.textContent).toContain('question-two');
    expect(calls.some((url) => url.includes('cursor=cursor-1'))).toBe(true);
    expect(calls.some((url) => url.includes('page=2'))).toBe(true);
    app.unmount();
  });

  it('discards in-flight rows and heatmap data when the account changes', async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayKey = localDayKey(today);
    let releaseAHistory!: (response: Response) => void;
    let releaseAActivity!: (response: Response) => void;
    const aHistory = new Promise<Response>((resolve) => { releaseAHistory = resolve; });
    const aActivity = new Promise<Response>((resolve) => { releaseAActivity = resolve; });
    let aRequests = 0;

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url.includes('/me/history/activity?')) {
        if (authorization === 'Bearer token-a') {
          aRequests += 1;
          return aActivity;
        }
        return new Response(JSON.stringify({ activity: { [todayKey]: 2 } }), { status: 200 });
      }
      if (url.includes('/me/history?')) {
        if (authorization === 'Bearer token-a') {
          aRequests += 1;
          return aHistory;
        }
        return new Response(JSON.stringify({
          items: [{
            id: 'attempt-b',
            questionId: 'question-b',
            partId: 'part-b',
            correct: true,
            awardedPoints: 1,
            gradedAt: today.toISOString(),
          }],
          page: 1,
          pageSize: 50,
          total: 1,
        }), { status: 200 });
      }
      if (url.endsWith('/content/questions/batch')) {
        return new Response(JSON.stringify({ questions: [], missing: [] }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.session = {
      token: 'token-a',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'account-a', username: 'a' },
      serverBaseUrl: useAppStore().config.serverBaseUrl,
    };
    useAppStore().setTokenProvider(() => auth.session?.token);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/history', component: HistoryView },
        { path: '/practice', component: { template: '<div />' } },
      ],
    });
    await router.push('/history');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(HistoryView);
    app.use(pinia);
    app.use(router);
    app.mount(host);

    await vi.waitFor(() => expect(aRequests).toBe(2));
    auth.session = {
      token: 'token-b',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'account-b', username: 'b' },
      serverBaseUrl: useAppStore().config.serverBaseUrl,
    };
    await vi.waitFor(() => expect(host.textContent).toContain('question-b'));
    await vi.waitFor(() => {
      expect(host.querySelector(`[data-key="${todayKey}"]`)?.getAttribute('aria-label')).toContain('2 Aufgaben');
    });

    releaseAHistory(new Response(JSON.stringify({
      items: [{
        id: 'attempt-a',
        questionId: 'question-a',
        partId: 'part-a',
        correct: false,
        awardedPoints: 0,
        gradedAt: today.toISOString(),
      }],
      page: 1,
      pageSize: 50,
      total: 1,
    }), { status: 200 }));
    releaseAActivity(new Response(JSON.stringify({ activity: { [todayKey]: 99 } }), { status: 200 }));
    await settle();

    expect(host.textContent).toContain('question-b');
    expect(host.textContent).not.toContain('question-a');
    expect(host.querySelector(`[data-key="${todayKey}"]`)?.getAttribute('aria-label')).toContain('2 Aufgaben');
    app.unmount();
  });
});
