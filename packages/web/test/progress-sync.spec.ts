import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { archiveChecksum, type LocalArchive } from '@qed2/core-logic';
import { archiveStore } from '../src/services.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const EMPTY: LocalArchive = {
  content: { perPart: [], perCompetency: [] },
  baseVersion: 0,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function setup(): Promise<ReturnType<typeof useProgressStore>> {
  setActivePinia(createPinia());
  await archiveStore.save(EMPTY);
  const auth = useAuthStore();
  auth.session = {
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: 'u1', username: 'tester' },
  };
  const progress = useProgressStore();
  await progress.init();
  return progress;
}

describe('progress sync orchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('compares checksums before recommendations and skips POST when equal', async () => {
    const progress = await setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/me/state');
      return json({
        archiveVersion: 7,
        checksum: archiveChecksum(EMPTY.content),
        perPart: [],
        perCompetency: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(progress.syncBeforeRecommendation()).resolves.toBe('in-sync');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(progress.archive.baseVersion).toBe(7);
  });

  it('serializes a grade behind an in-flight sync so the newer progress survives', async () => {
    const progress = await setup();
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain('/me/sync');
      expect(init?.method).toBe('POST');
      await syncGate;
      return json({ result: 'fast-forward', archiveVersion: 1, checksum: 'server-checksum' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const syncing = progress.syncNow({ quiet: true });
    const grading = progress.applyGrade({
      partId: 'q1-a',
      questionId: 'q1',
      competencyCodes: ['AG 1.1'],
      result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseSync();
    await Promise.all([syncing, grading]);

    expect(progress.archive.baseVersion).toBe(1);
    expect(progress.archive.content.perPart.map((part) => part.partId)).toEqual(['q1-a']);
    expect(progress.archive.content.perPart[0]?.grading).toBe('good');
  });
});
