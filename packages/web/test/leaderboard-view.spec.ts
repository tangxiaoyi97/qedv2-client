import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LeaderboardView from '../src/routes/LeaderboardView.vue';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useLeaderboardStore } from '../src/stores/leaderboard.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

function board(period = 'today', page = 1, ids = ['mira'], total = ids.length) {
  return {
    period, page, pageSize: 50, totalParticipants: total, timeZone: 'Europe/Vienna',
    generatedAt: '2026-09-08T12:00:00Z', me: { participating: false },
    items: ids.map((id, index) => ({ profileId: id, nickname: id, rank: index + 1,
      isMe: false, todayPracticed: 4, weekPracticed: 9, totalPracticed: 18, totalScore: 24 })),
  };
}

async function mountSignedIn(cachedPrivateProfile = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/leaderboard', component: LeaderboardView }] });
  await router.push('/leaderboard');
  const auth = useAuthStore();
  auth.session = { token: 'test', expiresAt: '2099-01-01T00:00:00Z', user: { id: 'u1', username: 'tester' }, serverBaseUrl: useAppStore().config.serverBaseUrl };
  useAppStore().setTokenProvider(() => auth.session?.token);
  if (cachedPrivateProfile) useLeaderboardStore().profile = { participating: false, suggestedNickname: 'tester' };
  const host = document.createElement('div');
  document.body.appendChild(host);
  let app = createApp(LeaderboardView).use(pinia).use(router);
  app.mount(host);
  await settle();
  return {
    host, auth, unmount: () => app.unmount(),
    remount: () => {
      app.unmount();
      app = createApp(LeaderboardView).use(pinia).use(router);
      app.mount(host);
    },
  };
}

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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('does not flash loading cards or a second crossfade for a fast first visit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).endsWith('/me/leaderboard-profile')
      ? json({ participating: false, suggestedNickname: 'tester' }) : json(board())));
    const mounted = await mountSignedIn();
    try {
      expect(mounted.host.querySelector('.leader-row')).not.toBeNull();
      expect(mounted.host.querySelector('.leaderboard__loading')).toBeNull();
      expect(mounted.host.querySelector('.leaderboard__profile .q-loadpanel')).toBeNull();
      expect(mounted.host.querySelector('.leaderboard__stage .q-crossfade-leave-active')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('restores the last completed period and warm profile immediately on re-entry while refreshing in place', async () => {
    const refresh = deferred<Response>();
    let returning = false;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (returning) return refresh.promise;
      if (String(input).endsWith('/me/leaderboard-profile')) return json({
        participating: true, profileId: 'self', nickname: 'Mira', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      });
      return json(board(String(input).includes('period=week') ? 'week' : 'today'));
    }));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => expect(mounted.host.querySelector('.leader-row')).not.toBeNull());
      mounted.host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click();
      await vi.waitFor(() => expect(mounted.host.querySelector('.leader-row')?.getAttribute('aria-label')).toContain('Diese Woche'));
      returning = true;
      vi.useFakeTimers();
      mounted.remount();
      expect(mounted.host.querySelector('.leader-row')).not.toBeNull();
      expect(mounted.host.querySelector('.leaderboard__loading')).toBeNull();
      expect(mounted.host.querySelector('.leaderboard__profile .q-loadpanel')).toBeNull();
      expect(mounted.host.querySelectorAll('[role="radio"]')[1]?.getAttribute('aria-checked')).toBe('true');
      expect(mounted.host.querySelector('.leaderboard__profile-identity')?.textContent).toContain('Mira');
      [...mounted.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Ändern'))!.click();
      await nextTick();
      expect(mounted.host.querySelector<HTMLInputElement>('#leaderboard-nickname-edit')?.value).toBe('Mira');
      await vi.advanceTimersByTimeAsync(200);
      expect(mounted.host.querySelector('.leaderboard__rows--refreshing')).toBeNull();
      expect(mounted.host.querySelector('.leaderboard__profile .q-loadpanel')).toBeNull();
    } finally {
      mounted.unmount();
      refresh.resolve(new Response(null, { status: 204 }));
      await settle();
    }
  });

  it('shows delayed feedback for a slow first visit without assuming an unknown profile has opted out', async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const mounted = await mountSignedIn();
    try {
      expect(mounted.host.querySelector('.leaderboard__loading')).toBeNull();
      expect(mounted.host.querySelector('.leaderboard__profile')).toBeNull();
      expect(mounted.host.querySelector('.leaderboard__join')).toBeNull();
      await vi.advanceTimersByTimeAsync(159);
      expect(mounted.host.querySelector('.leaderboard__loading')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(mounted.host.querySelector('.leaderboard__loading')).not.toBeNull();
      expect(mounted.host.querySelector('.leaderboard__profile .q-loadpanel')).not.toBeNull();
      expect(mounted.host.querySelector('.leaderboard__join')).toBeNull();
    } finally {
      mounted.unmount();
      pending.resolve(new Response(null, { status: 204 }));
      await settle();
    }
  });

  it.each(['save', 'leave'] as const)('waits for a %s started on the previous route before reading and caching the list', async (action) => {
    const mutation = deferred<Response>();
    let changed = false;
    let listReads = 0;
    const initialProfile = {
      participating: true, profileId: 'self', nickname: 'Old nickname', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (String(input).endsWith('/me/leaderboard-profile')) {
        if (init?.method === 'PUT' || init?.method === 'DELETE') return mutation.promise;
        return json(changed ? (action === 'leave'
          ? { participating: false, suggestedNickname: 'tester' }
          : { ...initialProfile, nickname: 'New nickname' }) : initialProfile);
      }
      listReads += 1;
      const result = board('today', 1, changed && action === 'leave' ? ['other'] : ['self']);
      if (result.items[0]?.profileId === 'self') {
        result.items[0].nickname = changed ? 'New nickname' : 'Old nickname';
        result.items[0].isMe = true;
      }
      return json(result);
    }));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => expect(mounted.host.querySelector('.leader-row')?.textContent).toContain('Old nickname'));
      const saving = action === 'save' ? useLeaderboardStore().saveNickname('New nickname') : useLeaderboardStore().leave();
      const readsBeforeReturn = listReads;
      mounted.remount();
      await settle();
      expect(listReads).toBe(readsBeforeReturn);
      expect(useLeaderboardStore().captureListScope()).toBeUndefined();
      expect(useLeaderboardStore().cachedList()).toBeUndefined();
      changed = true;
      mutation.resolve(action === 'save' ? json({ ...initialProfile, nickname: 'New nickname' }) : new Response(null, { status: 204 }));
      await saving;
      await vi.waitFor(() => expect(mounted.host.querySelector('.leader-row')?.textContent).toContain(action === 'save' ? 'New nickname' : 'other'));
      expect(listReads).toBe(readsBeforeReturn + 1);
      expect(mounted.host.querySelector('.leader-row')?.textContent).not.toContain('Old nickname');
      expect(useLeaderboardStore().cachedList()?.items.map((item) => item.nickname)).toEqual([action === 'save' ? 'New nickname' : 'other']);
      mounted.remount();
      expect(mounted.host.querySelector('.leader-row')?.textContent).toContain(action === 'save' ? 'New nickname' : 'other');
    } finally {
      mounted.unmount();
      mutation.resolve(new Response(null, { status: 204 }));
      await settle();
    }
  });

  it('keeps the signed-out state action-only', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/leaderboard', component: LeaderboardView }],
    });
    await router.push('/leaderboard');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(LeaderboardView);
    app.use(pinia);
    app.use(router);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain('Leaderboard');
    expect(host.textContent).toContain('Anmelden');
    expect(host.textContent).not.toContain('Bitte anmelden');
    expect(host.querySelector('.leaderboard__auth p')).toBeNull();
    expect([...host.querySelector('.leaderboard__auth')!.children].map((child) => child.tagName))
      .toEqual(['SPAN', 'H1', 'BUTTON']);

    app.unmount();
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
      serverBaseUrl: useAppStore().config.serverBaseUrl,
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
    expect(host.querySelector('.leaderboard--joined')).toBeNull();
    expect(host.querySelector('.leaderboard__profile-dock')).toBeNull();
    const input = host.querySelector<HTMLInputElement>('#leaderboard-nickname')!;
    expect(input.value).toBe('tester');

    const week = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Diese Woche'))!;
    week.click();
    await settle();
    expect(calls.some((call) => call.includes('period=week'))).toBe(true);

    host.querySelector<HTMLFormElement>('.leaderboard__join')!.requestSubmit();
    await vi.waitFor(() => {
      expect(host.textContent).toContain('tester');
      expect(host.querySelector('.leader-row--me')).not.toBeNull();
    });
    expect(host.textContent).not.toContain('Dein Nickname');
    expect(host.querySelector('.leaderboard__profile-avatar .lucide-user-round')).not.toBeNull();
    expect(host.querySelector('.leaderboard__profile-copy strong')?.textContent).toBe('tester');
    expect(host.querySelector('.leaderboard--joined .leaderboard__profile-dock > .leaderboard__profile--joined')).not.toBeNull();
    const profileButtons = host.querySelectorAll<HTMLButtonElement>('.leaderboard__profile-buttons .q-btn');
    expect(profileButtons).toHaveLength(2);
    expect(profileButtons[0]?.classList.contains('q-btn--secondary')).toBe(true);
    expect(profileButtons[1]?.classList.contains('q-btn--danger')).toBe(true);

    host.querySelector<HTMLButtonElement>('.leader-row')!.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Lösungsquote');
      expect(document.body.textContent).toContain('75 %');
    });
    expect(document.body.querySelector('.leader-detail__header')?.textContent).not.toContain('Statistik');
    expect(document.body.querySelector('.leader-detail__periods .lucide-calendar-check-2')).not.toBeNull();
    expect(document.body.querySelector('.leader-detail__periods .lucide-calendar-range')).not.toBeNull();

    app.unmount();
  });

  it('keeps the joined dock and pagination mounted while editing, switching periods and cancelling a failed rename', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).endsWith('/me/leaderboard-profile')
      ? json({ participating: true, profileId: 'self', nickname: 'tester',
        createdAt: '2026-07-23T12:00:00Z', updatedAt: '2026-07-23T12:00:00Z' })
      : json(board(String(input).includes('period=week') ? 'week' : 'today', 1, ['mira'], 2))));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => expect(mounted.host.querySelector('.leaderboard__profile-dock')).not.toBeNull());
      const dock = mounted.host.querySelector('.leaderboard__profile-dock')!;
      const card = dock.querySelector('.leaderboard__profile--joined')!;
      const more = mounted.host.querySelector('.leaderboard__more')!;
      expect(more.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const save = vi.spyOn(useLeaderboardStore(), 'saveNickname').mockRejectedValue(new Error('offline'));
      card.querySelector<HTMLButtonElement>('.leaderboard__profile-buttons button')!.click();
      await nextTick();
      const input = card.querySelector<HTMLInputElement>('#leaderboard-nickname-edit')!;
      input.value = 'New nickname';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      mounted.host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click();
      await vi.waitFor(() => expect(mounted.host.querySelector('.leader-row')?.getAttribute('aria-label')).toContain('Diese Woche'));
      expect(card.querySelector('#leaderboard-nickname-edit')).toBe(input);
      expect(input.value).toBe('New nickname');
      card.querySelector<HTMLFormElement>('form')!.requestSubmit();
      await vi.waitFor(() => expect(card.querySelector('[role="alert"]')?.textContent).toContain('Die Änderung konnte nicht gespeichert werden.'));
      expect(save).toHaveBeenCalledExactlyOnceWith('New nickname');
      expect(input.getAttribute('aria-describedby')).toBe('leaderboard-profile-error');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(mounted.host.querySelector('.leaderboard__profile-dock')).toBe(dock);
      expect(dock.querySelector('.leaderboard__profile--joined')).toBe(card);
      expect(mounted.host.querySelector('.leaderboard__more')).toBe(more);

      [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Abbrechen'))!.click();
      await nextTick();
      expect(card.querySelector('#leaderboard-nickname-edit')).toBeNull();
      expect(card.querySelector('.leaderboard__profile-copy strong')?.textContent).toBe('tester');
      expect(mounted.host.querySelector('.leaderboard__profile-dock')).toBe(dock);
      expect(save).toHaveBeenCalledTimes(1);
    } finally { mounted.unmount(); }
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
      serverBaseUrl: useAppStore().config.serverBaseUrl,
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

  it('preserves a typed nickname when the cached private profile refresh finishes', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).endsWith('/me/leaderboard-profile')
      ? pending.promise : json(board())));
    const { host, unmount } = await mountSignedIn(true);
    const input = host.querySelector<HTMLInputElement>('#leaderboard-nickname')!;
    input.value = 'My chosen name';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    pending.resolve(json({ participating: false, suggestedNickname: 'tester' }));
    await vi.waitFor(() => expect(useLeaderboardStore().loadingProfile).toBe(false));
    expect(input.value).toBe('My chosen name');
    unmount();
  });

  it('removes the departed profile even when refreshing the public list fails', async () => {
    let left = false;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (String(input).endsWith('/me/leaderboard-profile')) {
        if (init?.method === 'DELETE') {
          left = true;
          return new Response(null, { status: 204 });
        }
        return json({ participating: true, profileId: 'self', nickname: 'tester',
          createdAt: '2026-07-23T12:00:00Z', updatedAt: '2026-07-23T12:00:00Z' });
      }
      if (left) throw new TypeError('offline');
      const result = board('today', 1, ['self']);
      result.items[0]!.isMe = true;
      return json(result);
    }));
    const { host, unmount } = await mountSignedIn();
    await vi.waitFor(() => expect(host.querySelector('.leader-row--me')).not.toBeNull());
    [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Verlassen'))!.click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Das Leaderboard konnte nicht geladen werden.');
      expect(host.textContent).toContain('Beitreten');
      expect(host.querySelector('.leader-row--me')).toBeNull();
    });
    unmount();
  });

  it('keeps a failed participation lookup distinct from the private opt-in state and retries it', async () => {
    let profiles = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).endsWith('/me/leaderboard-profile')) {
        if (++profiles === 1) throw new TypeError('offline');
        return json({ participating: false, suggestedNickname: 'tester' });
      }
      return json(board());
    }));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => expect(mounted.host.textContent).toContain('Die Teilnahme konnte nicht geladen werden.'));
      expect(mounted.host.querySelector('.leader-row')).not.toBeNull();
      expect(mounted.host.querySelector('.leaderboard__join')).toBeNull();
      const retry = [...mounted.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Erneut versuchen'))!;
      retry.click();
      await vi.waitFor(() => expect(mounted.host.querySelector('.leaderboard__join')).not.toBeNull());
      expect(profiles).toBe(2);
    } finally { mounted.unmount(); }
  });

  it('cancels obsolete periods and never labels old rows as the new period', async () => {
    const today = deferred<Response>();
    let firstSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((input, init) => {
      const url = String(input);
      if (url.endsWith('/me/leaderboard-profile')) return Promise.resolve(json({ participating: false, suggestedNickname: 'tester' }));
      if (url.includes('period=today')) { firstSignal = init.signal; return today.promise; }
      return Promise.resolve(json(board('week', 1, ['weekly'])));
    }));
    const mounted = await mountSignedIn();
    try {
      const week = [...mounted.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Diese Woche'))!;
      week.click();
      await vi.waitFor(() => expect(mounted.host.textContent).toContain('weekly'));
      expect(firstSignal?.aborted).toBe(true);
      today.resolve(json(board('today', 1, ['obsolete'])));
      await settle();
      expect(mounted.host.textContent).not.toContain('obsolete');
      expect(mounted.host.textContent).toContain('weekly');
    } finally { mounted.unmount(); }
  });

  it('keeps rows, their period and pagination mounted while switching periods', async () => {
    const week = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = String(input);
      if (url.endsWith('/me/leaderboard-profile')) return Promise.resolve(json({ participating: false, suggestedNickname: 'tester' }));
      return url.includes('period=week') ? week.promise : Promise.resolve(json(board('today', 1, ['daily'], 2)));
    }));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => {
        expect(mounted.host.querySelector('.leader-row')).not.toBeNull();
        expect(mounted.host.querySelector('.leaderboard__loading')).toBeNull();
      });
      const row = mounted.host.querySelector('.leader-row')!;
      const more = mounted.host.querySelector<HTMLButtonElement>('.leaderboard__more button')!;
      mounted.host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click();
      await settle();
      expect(mounted.host.querySelector('.leader-row')).toBe(row);
      expect(row.getAttribute('aria-label')).toContain('Heute: 4');
      expect(mounted.host.querySelector('.leaderboard__columns span:nth-child(3)')!.textContent).toBe('Heute');
      expect(mounted.host.querySelector('.leaderboard__list')!.getAttribute('aria-busy')).toBe('true');
      expect(mounted.host.querySelector('.leaderboard__loading')).toBeNull();
      expect(mounted.host.querySelector('.leaderboard__more button')).toBe(more);
      expect(more.disabled).toBe(true);
      expect(mounted.host.querySelector('.leaderboard__rows--refreshing')).toBeNull();
      week.resolve(json(board('week', 1, ['weekly'], 2)));
      await vi.waitFor(() => expect(mounted.host.textContent).toContain('weekly'));
      expect(mounted.host.querySelector('.leader-row')!.getAttribute('aria-label')).toContain('Diese Woche: 9');
      expect(more.disabled).toBe(false);
    } finally { mounted.unmount(); }
  });

  it('restores the displayed period after a failed switch and retries the requested period', async () => {
    let weekCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/me/leaderboard-profile')) return json({ participating: false, suggestedNickname: 'tester' });
      if (url.includes('period=week')) {
        if (++weekCalls === 1) throw new TypeError('offline');
        return json(board('week', 1, ['weekly']));
      }
      return json(board('today', 1, ['daily']));
    }));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => expect(mounted.host.querySelector('.leader-row')).not.toBeNull());
      const row = mounted.host.querySelector('.leader-row');
      const radios = mounted.host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      radios[1]!.click();
      await vi.waitFor(() => expect(mounted.host.textContent).toContain('Das Leaderboard konnte nicht geladen werden.'));
      expect(mounted.host.querySelector('.leader-row')).toBe(row);
      expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
      mounted.host.querySelector<HTMLButtonElement>('.leaderboard__notice button')!.click();
      await vi.waitFor(() => expect(mounted.host.textContent).toContain('weekly'));
      expect(weekCalls).toBe(2);
      expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    } finally { mounted.unmount(); }
  });

  it('ignores a late period response when switching back to the visible period', async () => {
    const week = deferred<Response>();
    let weekSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((input, init) => {
      const url = String(input);
      if (url.endsWith('/me/leaderboard-profile')) return Promise.resolve(json({ participating: false, suggestedNickname: 'tester' }));
      if (url.includes('period=week')) { weekSignal = init.signal; return week.promise; }
      return Promise.resolve(json(board('today', 1, ['daily'])));
    }));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => expect(mounted.host.querySelector('.leader-row')).not.toBeNull());
      const radios = mounted.host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      radios[1]!.click();
      await settle();
      radios[0]!.click();
      await vi.waitFor(() => expect(weekSignal?.aborted).toBe(true));
      week.resolve(json(board('week', 1, ['obsolete'])));
      await settle();
      expect(mounted.host.textContent).not.toContain('obsolete');
      expect(mounted.host.querySelector('.leader-row')!.getAttribute('aria-label')).toContain('Heute: 4');
      expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    } finally { mounted.unmount(); }
  });

  it('drops pending list responses after logout and direct account switches', async () => {
    const old = deferred<Response>();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn((input) => {
      if (String(input).endsWith('/me/leaderboard-profile')) return Promise.resolve(json({ participating: false, suggestedNickname: 'tester' }));
      return ++calls === 1 ? old.promise : Promise.resolve(json(board('today', 1, ['new-account'])));
    }));
    const mounted = await mountSignedIn();
    try {
      mounted.auth.session = { ...mounted.auth.session!, token: 'another', user: { id: 'u2', username: 'second' } };
      await vi.waitFor(() => expect(mounted.host.textContent).toContain('new-account'));
      old.resolve(json(board('today', 1, ['old-account'])));
      await settle();
      expect(mounted.host.textContent).not.toContain('old-account');
      mounted.auth.session = undefined;
      await settle();
      expect(mounted.host.querySelector('.leaderboard__auth')).not.toBeNull();
      expect(mounted.host.querySelector('.leader-row')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('retries the failed next page in place, prevents double requests and deduplicates moving ranks', async () => {
    let pages = 0;
    const pageTwo = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/me/leaderboard-profile')) return json({ participating: false, suggestedNickname: 'tester' });
      if (url.includes('page=2')) {
        if (++pages === 1) throw new TypeError('offline');
        return pageTwo.promise;
      }
      return json(board('today', 1, ['a', 'b'], 3));
    }));
    const mounted = await mountSignedIn();
    try {
      await vi.waitFor(() => expect(mounted.host.querySelectorAll('.leader-row')).toHaveLength(2));
      mounted.host.querySelector<HTMLButtonElement>('.leaderboard__more button')!.click();
      await vi.waitFor(() => expect(mounted.host.textContent).toContain('Das Leaderboard konnte nicht geladen werden.'));
      expect(mounted.host.querySelectorAll('.leader-row')).toHaveLength(2);
      mounted.host.querySelector<HTMLButtonElement>('.leaderboard__notice button')!.click();
      await settle();
      mounted.host.querySelector<HTMLButtonElement>('.leaderboard__more button')!.click();
      expect(pages).toBe(2);
      pageTwo.resolve(json(board('today', 2, ['b', 'c'], 3)));
      await vi.waitFor(() => expect(mounted.host.querySelectorAll('.leader-row')).toHaveLength(3));
      expect(mounted.host.querySelector('.leaderboard__more')).toBeNull();
    } finally { mounted.unmount(); }
  });
});
