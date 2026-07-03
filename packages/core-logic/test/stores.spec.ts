import { describe, expect, it } from 'vitest';
import type { StoragePort } from '../src/ports/index.js';
import { STORAGE } from '../src/ports/index.js';
import { ArchiveStore, AuthStore, ConfigStore, QuestionCache } from '../src/store/index.js';
import { DEFAULT_CONFIG } from '../src/config/index.js';
import { archiveChecksum } from '../src/sync/index.js';
import type { Question } from '../src/model/question.js';

class MemoryStorage implements StoragePort {
  readonly collections = new Map<string, Map<string, unknown>>();

  private coll(collection: string): Map<string, unknown> {
    let c = this.collections.get(collection);
    if (!c) {
      c = new Map();
      this.collections.set(collection, c);
    }
    return c;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.coll(collection).get(key) as T | undefined;
  }
  async set<T>(collection: string, key: string, value: T): Promise<void> {
    // Structured-clone-ish copy so tests catch accidental shared references.
    this.coll(collection).set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(collection: string, key: string): Promise<void> {
    this.coll(collection).delete(key);
  }
  async keys(collection: string): Promise<string[]> {
    return [...this.coll(collection).keys()];
  }
  async clear(collection: string): Promise<void> {
    this.coll(collection).clear();
  }
}

describe('ArchiveStore', () => {
  const now = new Date('2026-07-03T10:00:00.000Z');

  it('load returns an empty archive with baseVersion 0 by default', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    const archive = await store.load();
    expect(archive).toEqual({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
  });

  it('applyGrade creates a part entry with reps=1 and initializes mastery', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    const archive = await store.applyGrade({
      partId: 'p1',
      competencyCodes: ['AN 4.3', 'FA 1.5'],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 2,
      now,
    });

    expect(archive.content.perPart).toHaveLength(1);
    const entry = archive.content.perPart[0]!;
    expect(entry.partId).toBe('p1');
    expect(entry.fsrs.reps).toBe(1);
    expect(entry.fsrs.stability).toBeGreaterThan(0);
    expect(entry.lastResult).toEqual({
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-07-03T10:00:00.000Z',
    });
    expect(entry.updatedAt).toBe('2026-07-03T10:00:00.000Z');

    // First grade initializes mastery to the ratio for every attached competency.
    expect(archive.content.perCompetency).toHaveLength(2);
    for (const c of archive.content.perCompetency) {
      expect(c.mastery).toBeCloseTo(0.5, 10);
      expect(c.updatedAt).toBe('2026-07-03T10:00:00.000Z');
    }
  });

  it('second grade updates the same entry (reps=2) without disturbing others', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    await store.applyGrade({
      partId: 'p1',
      competencyCodes: ['AN 4.3'],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now,
    });
    await store.applyGrade({
      partId: 'p2',
      competencyCodes: ['FA 1.5'],
      verdict: 'incorrect',
      awardedPoints: 0,
      maxPoints: 1,
      now,
    });

    const later = new Date('2026-07-05T10:00:00.000Z');
    const archive = await store.applyGrade({
      partId: 'p1',
      competencyCodes: ['AN 4.3'],
      verdict: 'partial',
      awardedPoints: 1,
      maxPoints: 2,
      now: later,
    });

    expect(archive.content.perPart).toHaveLength(2);
    const p1 = archive.content.perPart.find((p) => p.partId === 'p1')!;
    expect(p1.fsrs.reps).toBe(2);
    expect(p1.fsrs.lastReview).toBe('2026-07-05T10:00:00.000Z');
    expect(p1.lastResult).toEqual({
      correct: false,
      awardedPoints: 1,
      gradedAt: '2026-07-05T10:00:00.000Z',
    });
    expect(p1.updatedAt).toBe('2026-07-05T10:00:00.000Z');

    // p2 untouched by the p1 regrade.
    const p2 = archive.content.perPart.find((p) => p.partId === 'p2')!;
    expect(p2.fsrs.reps).toBe(1);
    expect(p2.updatedAt).toBe('2026-07-03T10:00:00.000Z');

    // Mastery EMA: 1 → 1 + 0.3·(0.5 − 1) = 0.85; FA 1.5 untouched.
    const an = archive.content.perCompetency.find((c) => c.code === 'AN 4.3')!;
    expect(an.mastery).toBeCloseTo(0.85, 10);
    const fa = archive.content.perCompetency.find((c) => c.code === 'FA 1.5')!;
    expect(fa.mastery).toBeCloseTo(0, 10);
  });

  it('persists across store instances and computes checksum/userState/dueCounts', async () => {
    const storage = new MemoryStorage();
    await new ArchiveStore(storage).applyGrade({
      partId: 'p1',
      competencyCodes: ['AN 4.3'],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now,
    });

    const store = new ArchiveStore(storage);
    const archive = await store.load();
    expect(archive.content.perPart).toHaveLength(1);

    expect(await store.checksum()).toBe(archiveChecksum(archive.content));

    const userState = await store.toUserState();
    expect(userState.perPart).toEqual([
      { partId: 'p1', fsrs: archive.content.perPart[0]!.fsrs },
    ]);
    expect(userState.perCompetency).toEqual([{ code: 'AN 4.3', mastery: 1 }]);
    // Projection only — no lastResult/updatedAt leak to the anonymous core.
    expect(userState.perPart[0]).not.toHaveProperty('lastResult');
    expect(userState.perCompetency[0]).not.toHaveProperty('updatedAt');

    // Immediately after grading nothing is due yet (interval >= 1 day)…
    expect(await store.dueCounts(now)).toEqual({ due: 0, practiced: 1 });
    // …but far in the future the part is due again.
    expect(await store.dueCounts(new Date('2126-01-01T00:00:00.000Z'))).toEqual({
      due: 1,
      practiced: 1,
    });
  });
});

describe('AuthStore', () => {
  const session = {
    token: 't0k3n',
    expiresAt: '2026-08-01T00:00:00.000Z',
    user: { id: 'u1', username: 'alice' },
  };

  it('round-trips a session and clears ONLY the auth collection', async () => {
    const storage = new MemoryStorage();
    const auth = new AuthStore(storage);
    const archiveStore = new ArchiveStore(storage);

    await archiveStore.applyGrade({
      partId: 'p1',
      competencyCodes: ['AN 4.3'],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      now: new Date('2026-07-03T10:00:00.000Z'),
    });
    await auth.setSession(session);
    expect(await auth.getSession()).toEqual(session);

    await auth.clearSession();

    expect(await auth.getSession()).toBeUndefined();
    // Iron rule: logout never clears the local archive.
    const archive = await archiveStore.load();
    expect(archive.content.perPart).toHaveLength(1);
    expect((await storage.keys(STORAGE.archive)).length).toBeGreaterThan(0);
  });

  it('isExpiringSoon uses a 72h default window', () => {
    const auth = new AuthStore(new MemoryStorage());
    const expiresAt = '2026-07-06T00:00:00.000Z';
    const s = { ...session, expiresAt };
    expect(auth.isExpiringSoon(s, new Date('2026-07-01T00:00:00.000Z'))).toBe(false); // 5d out
    expect(auth.isExpiringSoon(s, new Date('2026-07-03T00:00:00.000Z'))).toBe(true); // exactly 72h
    expect(auth.isExpiringSoon(s, new Date('2026-07-07T00:00:00.000Z'))).toBe(true); // already expired
    expect(auth.isExpiringSoon(s, new Date('2026-07-01T00:00:00.000Z'), 10 * 24 * 3600 * 1000)).toBe(true);
  });
});

describe('ConfigStore', () => {
  it('returns defaults when nothing is stored', async () => {
    const config = new ConfigStore(new MemoryStorage());
    expect(await config.getConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('merges stored overrides over defaults and accumulates partial writes', async () => {
    const config = new ConfigStore(new MemoryStorage());
    await config.setConfig({ coreBaseUrl: 'http://localhost:8787/' });
    let merged = await config.getConfig();
    expect(merged.coreBaseUrl).toBe('http://localhost:8787'); // trailing slash normalized
    expect(merged.serverBaseUrl).toBe(DEFAULT_CONFIG.serverBaseUrl);

    await config.setConfig({ serverBaseUrl: 'http://localhost:8080' });
    merged = await config.getConfig();
    expect(merged.coreBaseUrl).toBe('http://localhost:8787'); // earlier override kept
    expect(merged.serverBaseUrl).toBe('http://localhost:8080');
  });

  it('theme defaults to system and round-trips', async () => {
    const config = new ConfigStore(new MemoryStorage());
    expect(await config.getTheme()).toBe('system');
    await config.setTheme('dark');
    expect(await config.getTheme()).toBe('dark');
  });
});

describe('QuestionCache', () => {
  const question = {
    id: 'q1',
    schemaVersion: 2,
    status: 'reviewed',
    lang: 'de',
    source: { suite: 'srdp', year: 2023, term: 'haupttermin', part: 't1', nr: 9, file: 'x.json' },
    title: 'Testfrage',
    parts: [],
  } as unknown as Question;

  it('put/get/has/putMany passthrough over the questions collection', async () => {
    const storage = new MemoryStorage();
    const cache = new QuestionCache(storage);
    expect(await cache.get('q1')).toBeUndefined();
    expect(await cache.has('q1')).toBe(false);

    await cache.put(question);
    expect(await cache.has('q1')).toBe(true);
    expect((await cache.get('q1'))?.title).toBe('Testfrage');

    const q2 = { ...question, id: 'q2' };
    await cache.putMany([question, q2]);
    expect(await storage.keys(STORAGE.questions)).toEqual(['q1', 'q2']);
  });
});
