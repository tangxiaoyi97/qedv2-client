import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE } from '@qed2/core-logic';
import HistoryView from '../src/routes/HistoryView.vue';
import { historyLog, storage } from '../src/services.js';
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
  beforeEach(async () => {
    await storage.clear(STORAGE.history);
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

    await vi.waitFor(() => expect(host.querySelectorAll('.hist__row')).toHaveLength(2));

    host
      .querySelector<SVGGElement>(`[data-key="${yesterdayKey}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(host.querySelectorAll('.hist__row')).toHaveLength(1);
      expect(host.textContent).toContain('question-yesterday');
      expect(host.textContent).not.toContain('question-today');
    });
    expect(host.textContent).toContain('1 Antwort');
    expect(host.querySelector(`[data-key="${yesterdayKey}"]`)?.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('Verlauf gefiltert:');

    host
      .querySelector<SVGGElement>(`[data-key="${yesterdayKey}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelectorAll('.hist__row')).toHaveLength(2));
    expect(host.querySelector(`[data-key="${todayKey}"]`)).not.toBeNull();

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
