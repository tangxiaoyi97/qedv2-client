import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { historyLog } from '../src/services.js';
import { useActivityStore } from '../src/stores/activity.js';
import { useAuthStore } from '../src/stores/auth.js';

describe('shared activity store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the local history log as the single guest activity source', async () => {
    const local = { '2026-08-07': 3 };
    const dailyActivity = vi.spyOn(historyLog, 'dailyActivity').mockResolvedValue(local);

    const activity = useActivityStore();
    await activity.ensure(84, new Date('2026-08-07T10:00:00.000Z'));

    expect(dailyActivity).toHaveBeenCalledWith(84, new Date('2026-08-07T10:00:00.000Z'));
    expect(activity.activity).toEqual(local);
    expect(activity.status).toBe('ready');
    expect(activity.cloudMode).toBe(false);
  });

  it('replaces an earlier cloud result with the authoritative empty response', async () => {
    const auth = useAuthStore();
    auth.session = {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'learner-1', username: 'Ada' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ activity: { '2026-08-07': 4 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ activity: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const activity = useActivityStore();
    await activity.ensure(84, new Date('2026-08-07T10:00:00.000Z'));
    expect(activity.activity).toEqual({ '2026-08-07': 4 });

    await activity.refresh(84, { force: true, now: new Date('2026-08-07T10:05:00.000Z') });

    expect(activity.activity).toEqual({});
    expect(activity.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears cloud data on failure instead of rendering a stale cache', async () => {
    const auth = useAuthStore();
    auth.session = {
      token: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'learner-1', username: 'Ada' },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ activity: { '2026-08-07': 4 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
        .mockRejectedValueOnce(new TypeError('offline')),
    );

    const activity = useActivityStore();
    await activity.ensure(84, new Date('2026-08-07T10:00:00.000Z'));
    await activity.refresh(84, { force: true });

    expect(activity.activity).toEqual({});
    expect(activity.status).toBe('error');
    expect(activity.updatedAt).toBeUndefined();
    expect(activity.error).toContain('erneut');
  });
});
