import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LeaderboardView from '../src/routes/LeaderboardView.vue';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe('LeaderboardView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows the opt-in flow, switches periods and opens aggregate detail', async () => {
    let joined = false;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/me/leaderboard-profile')) {
        if (init?.method === 'PUT') {
          joined = true;
          return json({
            participating: true,
            profileId: 'self',
            nickname: 'tester',
            createdAt: '2026-07-23T12:00:00.000Z',
            updatedAt: '2026-07-23T12:00:00.000Z',
          });
        }
        return json(
          joined
            ? {
                participating: true,
                profileId: 'self',
                nickname: 'tester',
                createdAt: '2026-07-23T12:00:00.000Z',
                updatedAt: '2026-07-23T12:00:00.000Z',
              }
            : { participating: false, suggestedNickname: 'tester' },
        );
      }
      if (url.includes('/leaderboard/users/mira')) {
        return json({
          profileId: 'mira',
          nickname: 'Mira',
          joinedAt: '2026-07-01T12:00:00.000Z',
          totalPracticed: 18,
          todayPracticed: 4,
          weekPracticed: 9,
          totalScore: 24,
          todayScore: 5,
          weekScore: 12,
          correctAnswers: 18,
          accuracy: 75,
        });
      }
      if (url.includes('/leaderboard')) {
        const period = url.includes('period=week') ? 'week' : 'today';
        return json({
          period,
          timeZone: 'Europe/Vienna',
          generatedAt: '2026-07-23T12:00:00.000Z',
          items: [
            {
              profileId: 'mira',
              nickname: 'Mira',
              isMe: false,
              rank: 1,
              totalPracticed: 18,
              todayPracticed: 4,
              weekPracticed: 9,
              totalScore: 24,
            },
            ...(joined
              ? [{
                  profileId: 'self',
                  nickname: 'tester',
                  isMe: true,
                  rank: 2,
                  totalPracticed: 3,
                  todayPracticed: 1,
                  weekPracticed: 2,
                  totalScore: 5,
                }]
              : []),
          ],
          page: 1,
          pageSize: 50,
          totalParticipants: joined ? 2 : 1,
          me: joined
            ? { participating: true, profileId: 'self', nickname: 'tester' }
            : { participating: false },
        });
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/leaderboard', component: LeaderboardView }],
    });
    await router.push('/leaderboard');

    const auth = useAuthStore();
    auth.session = {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
    };
    useAppStore().setTokenProvider(() => auth.session?.token);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(LeaderboardView);
    app.use(pinia);
    app.use(router);
    app.mount(host);
    await settle();

    expect(host.textContent).toContain('Mira');
    expect(host.textContent).toContain('Beitreten');
    const input = host.querySelector<HTMLInputElement>('#leaderboard-nickname')!;
    expect(input.value).toBe('tester');

    const week = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Diese Woche'))!;
    week.click();
    await settle();
    expect(calls.some((call) => call.includes('period=week'))).toBe(true);

    host.querySelector<HTMLFormElement>('.leaderboard__join')!.requestSubmit();
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Dein Nickname');
      expect(host.textContent).toContain('tester');
      expect(host.querySelector('.leader-row--me')).not.toBeNull();
    });
    expect(host.querySelector('.leaderboard__profile-avatar .lucide-user-round')).not.toBeNull();
    expect(host.querySelector('.leaderboard__profile-copy strong')?.textContent).toBe('tester');
    const profileButtons = host.querySelectorAll<HTMLButtonElement>('.leaderboard__profile-buttons .q-btn');
    expect(profileButtons).toHaveLength(2);
    expect(profileButtons[0]?.classList.contains('q-btn--secondary')).toBe(true);
    expect(profileButtons[1]?.classList.contains('q-btn--danger')).toBe(true);

    host.querySelector<HTMLButtonElement>('.leader-row')!.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Lösungsquote');
      expect(document.body.textContent).toContain('75 %');
    });
    expect(document.body.querySelector('.leader-detail__periods .lucide-calendar-check-2')).not.toBeNull();
    expect(document.body.querySelector('.leader-detail__periods .lucide-calendar-range')).not.toBeNull();

    app.unmount();
  });

  it('keeps the detail dialog open after a failed request and retries in place', async () => {
    let detailCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/me/leaderboard-profile')) {
        return json({
          participating: true,
          profileId: 'self',
          nickname: 'tester',
          createdAt: '2026-07-23T12:00:00.000Z',
          updatedAt: '2026-07-23T12:00:00.000Z',
        });
      }
      if (url.includes('/leaderboard/users/mira')) {
        detailCalls += 1;
        if (detailCalls === 1) {
          return new Response(JSON.stringify({ message: 'temporary error' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return json({
          profileId: 'mira',
          nickname: 'Mira',
          joinedAt: '2026-07-01T12:00:00.000Z',
          totalPracticed: 18,
          todayPracticed: 4,
          weekPracticed: 9,
          totalScore: 24,
          todayScore: 5,
          weekScore: 12,
          correctAnswers: 18,
          accuracy: 75,
        });
      }
      if (url.includes('/leaderboard')) {
        return json({
          period: 'today',
          timeZone: 'Europe/Vienna',
          generatedAt: '2026-07-23T12:00:00.000Z',
          items: [{
            profileId: 'mira',
            nickname: 'Mira',
            isMe: false,
            rank: 1,
            totalPracticed: 18,
            todayPracticed: 4,
            weekPracticed: 9,
            totalScore: 24,
          }],
          page: 1,
          pageSize: 50,
          totalParticipants: 1,
          me: { participating: true, profileId: 'self', nickname: 'tester' },
        });
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/leaderboard', component: LeaderboardView }],
    });
    await router.push('/leaderboard');

    const auth = useAuthStore();
    auth.session = {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'tester' },
    };
    useAppStore().setTokenProvider(() => auth.session?.token);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(LeaderboardView);
    app.use(pinia);
    app.use(router);
    app.mount(host);
    await settle();

    host.querySelector<HTMLButtonElement>('.leader-row')!.click();
    await vi.waitFor(() => {
      expect(document.body.querySelector('.leader-detail__backdrop')).not.toBeNull();
      expect(document.body.textContent).toContain('Die Details konnten nicht geladen werden.');
    });

    const retry = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Erneut versuchen'));
    retry?.click();
    await vi.waitFor(() => {
      expect(detailCalls).toBe(2);
      expect(document.body.textContent).toContain('Lösungsquote');
      expect(document.body.textContent).toContain('75 %');
    });

    app.unmount();
  });
});
