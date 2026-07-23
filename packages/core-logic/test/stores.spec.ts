import { describe, expect, it } from 'vitest';
import type { StoragePort } from '../src/ports/index.js';
import { STORAGE } from '../src/ports/index.js';
import { ArchiveStore, AttemptOutbox, AuthStore, ConfigStore, QuestionCache, HistoryLog, questionContentHash } from '../src/store/index.js';
import { DEFAULT_CONFIG } from '../src/config/index.js';
import { archiveChecksum } from '../src/sync/index.js';
import { EXCLUDED_DUE_SENTINEL } from '../src/fsrs/index.js';
import type { Question } from '../src/model/question.js';
import type { LocalArchive } from '../src/model/archive.js';

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

describe('AttemptOutbox', () => {
  it('keeps retries durable, idempotent and isolated by account', async () => {
    const storage = new MemoryStorage();
    const outbox = new AttemptOutbox(storage);
    const attempt = {
      clientAttemptId: 'attempt-1',
      questionId: 'q1',
      partId: 'q1-a',
      correct: true,
      awardedPoints: 1,
      gradedAt: '2026-07-23T12:00:00.000Z',
    };

    await outbox.enqueue('u1', attempt);
    await outbox.enqueue('u1', attempt);
    await outbox.enqueue('u2', { ...attempt, clientAttemptId: 'attempt-2' });

    expect(await outbox.count('u1')).toBe(1);
    expect(await outbox.count('u2')).toBe(1);
    expect(await outbox.list('u1')).toEqual([attempt]);

    await outbox.remove('u1', ['attempt-1']);
    expect(await outbox.count('u1')).toBe(0);
    expect(await outbox.count('u2')).toBe(1);
  });
});

describe('ArchiveStore', () => {
  const now = new Date('2026-07-03T10:00:00.000Z');

  it('load returns an empty archive with baseVersion 0 by default', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    const archive = await store.load();
    expect(archive).toEqual({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
  });

  it('applyGrade creates a part entry with reps=1, auto grading, and initializes mastery', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    const result = await store.applyGrade({
      partId: 'p1',
      competencyCodes: ['AN 4.3', 'FA 1.5'],
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 2,
      now,
    });

    expect(result.grading).toBe('good');
    expect(result.previousFsrs).toBeUndefined();
    const archive = result.archive;
    expect(archive.content.perPart).toHaveLength(1);
    const entry = archive.content.perPart[0]!;
    expect(entry.partId).toBe('p1');
    expect(entry.grading).toBe('good');
    expect(entry.starred).toBe(false);
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

  it('auto grading maps verdicts: correct→good, partial→meh, incorrect→baffled', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    const a = await store.applyGrade({ partId: 'a', competencyCodes: [], verdict: 'correct', awardedPoints: 1, maxPoints: 1, now });
    const b = await store.applyGrade({ partId: 'b', competencyCodes: [], verdict: 'partial', awardedPoints: 0.5, maxPoints: 1, now });
    const c = await store.applyGrade({ partId: 'c', competencyCodes: [], verdict: 'incorrect', awardedPoints: 0, maxPoints: 1, now });
    expect(a.grading).toBe('good');
    expect(b.grading).toBe('meh');
    expect(c.grading).toBe('baffled');
    // baffled: due immediately; meh: short relearn (1–3 days)
    const cEntry = c.archive.content.perPart.find((p) => p.partId === 'c')!;
    expect(cEntry.fsrs.due).toBe(now.toISOString());
    const bEntry = c.archive.content.perPart.find((p) => p.partId === 'b')!;
    const dueDays = (new Date(bEntry.fsrs.due).getTime() - now.getTime()) / 86_400_000;
    expect(dueDays).toBeGreaterThanOrEqual(1);
    expect(dueDays).toBeLessThanOrEqual(3);
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
    const { archive } = await store.applyGrade({
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
    expect(p1.grading).toBe('meh');
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
    expect(an.mastery).toBeCloseTo(0.85, 6);
    const fa = archive.content.perCompetency.find((c) => c.code === 'FA 1.5')!;
    expect(fa.mastery).toBeCloseTo(0, 10);
  });

  it('manual setGrading with baseFsrs REPLACES the auto advance (supplement §1.2)', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    await store.applyGrade({ partId: 'p1', competencyCodes: [], verdict: 'correct', awardedPoints: 1, maxPoints: 1, now });
    const before = (await store.load()).content.perPart[0]!.fsrs;

    // Answer again later — wrong this time (auto baffled)…
    const later = new Date('2026-07-10T10:00:00.000Z');
    const second = await store.applyGrade({ partId: 'p1', competencyCodes: [], verdict: 'incorrect', awardedPoints: 0, maxPoints: 1, now: later });
    expect(second.previousFsrs).toEqual(before);
    expect((await store.load()).content.perPart[0]!.fsrs.lapses).toBe(1);

    // …but the user says "careless slip" — rebased on the SAME snapshot:
    const archive = await store.setGrading({ partId: 'p1', grading: 'careless', now: later, baseFsrs: second.previousFsrs });
    const entry = archive.content.perPart[0]!;
    expect(entry.grading).toBe('careless');
    // careless = Hard, not a lapse — the auto 'again' lapse is rolled back
    expect(entry.fsrs.lapses).toBe(0);
    expect(entry.fsrs.reps).toBe(2);
    // lastResult from the answer is preserved
    expect(entry.lastResult?.correct).toBe(false);
  });

  it('excluded freezes: fsrs untouched, never due, projected with far-future due', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    await store.applyGrade({ partId: 'p1', competencyCodes: ['AG 1.1'], verdict: 'incorrect', awardedPoints: 0, maxPoints: 1, now });
    const frozen = (await store.load()).content.perPart[0]!.fsrs; // baffled → due now (would be due)

    const archive = await store.setGrading({ partId: 'p1', grading: 'excluded', now: new Date('2026-07-04T00:00:00.000Z') });
    const entry = archive.content.perPart[0]!;
    expect(entry.grading).toBe('excluded');
    expect(entry.fsrs).toEqual(frozen); // frozen, not advanced

    // never due
    expect(await store.dueCounts(new Date('2126-01-01T00:00:00.000Z'))).toEqual({ due: 0, practiced: 1 });
    // recommendation projection: far-future due sentinel
    const userState = await store.toUserState();
    expect(userState.perPart).toEqual([{ partId: 'p1', fsrs: { ...frozen, due: EXCLUDED_DUE_SENTINEL } }]);
    expect(await store.excludedPartIds()).toEqual(new Set(['p1']));

    // re-grading thaws from the frozen state
    const thawed = await store.setGrading({ partId: 'p1', grading: 'good', now: new Date('2026-07-05T00:00:00.000Z') });
    expect(thawed.content.perPart[0]!.grading).toBe('good');
    expect(thawed.content.perPart[0]!.fsrs.reps).toBe(frozen.reps + 1);
    expect(await store.dueCounts(new Date('2126-01-01T00:00:00.000Z'))).toEqual({ due: 1, practiced: 1 });
  });

  it('setStarred creates a reps-0 placeholder that stays out of userState and dueCounts', async () => {
    const store = new ArchiveStore(new MemoryStorage());
    const archive = await store.setStarred('p9', true, now);
    const entry = archive.content.perPart[0]!;
    expect(entry.starred).toBe(true);
    expect(entry.grading).toBeNull();
    expect(entry.fsrs.reps).toBe(0);
    expect(entry.fsrs.lastReview).toBeNull();

    // Placeholder is unseen for core (dropped) and never practiced/due.
    expect((await store.toUserState()).perPart).toEqual([]);
    expect(await store.dueCounts(new Date('2126-01-01T00:00:00.000Z'))).toEqual({ due: 0, practiced: 0 });

    // Un-star keeps the entry but flips the flag; grading survives a star toggle.
    await store.setGrading({ partId: 'p9', grading: 'excluded', now });
    const after = await store.setStarred('p9', false, now);
    expect(after.content.perPart[0]!.starred).toBe(false);
    expect(after.content.perPart[0]!.grading).toBe('excluded');
  });

  it('migrates pre-grading archives: shape filled, grading derived from lastResult', async () => {
    const storage = new MemoryStorage();
    const legacy = {
      content: {
        perPart: [
          {
            partId: 'old-correct',
            fsrs: { due: '2026-07-05T00:00:00.000Z', stability: 2, difficulty: 5, reps: 3, lapses: 0, lastReview: '2026-07-01T00:00:00.000Z' },
            lastResult: { correct: true, awardedPoints: 1, gradedAt: '2026-07-01T00:00:00.000Z' },
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
          {
            partId: 'old-partial',
            fsrs: { due: '2026-07-05T00:00:00.000Z', stability: 1, difficulty: 6, reps: 1, lapses: 0 },
            lastResult: { correct: false, awardedPoints: 0.5, gradedAt: '2026-07-01T00:00:00.000Z' },
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
          {
            partId: 'old-wrong',
            fsrs: { due: '2026-07-05T00:00:00.000Z', stability: 0.5, difficulty: 7, reps: 2, lapses: 1 },
            lastResult: { correct: false, awardedPoints: 0, gradedAt: '2026-07-01T00:00:00.000Z' },
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
        perCompetency: [{ code: 'AG 1.1', mastery: 0.7, updatedAt: '2026-07-01T00:00:00.000Z' }],
      },
      baseVersion: 4,
    } as unknown as LocalArchive;
    await storage.set(STORAGE.archive, 'current', legacy);

    const archive = await new ArchiveStore(storage).load();
    const byId = new Map(archive.content.perPart.map((p) => [p.partId, p]));
    expect(byId.get('old-correct')!.grading).toBe('good');
    expect(byId.get('old-partial')!.grading).toBe('meh');
    expect(byId.get('old-wrong')!.grading).toBe('baffled');
    for (const p of archive.content.perPart) {
      expect(p.starred).toBe(false);
      expect(p.fsrs.lastReview !== undefined).toBe(true); // null or string, never missing
    }
    expect(archive.baseVersion).toBe(4);
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

describe('HistoryLog', () => {
  it('appends newest-first, lists with limit/offset, and aggregates daily activity', async () => {
    const log = new HistoryLog(new MemoryStorage());
    await log.append({ partId: 'p1', questionId: 'q1', verdict: 'correct', awardedPoints: 1, maxPoints: 1, grading: 'good', gradedAt: '2026-07-01T10:00:00.000Z' });
    await log.append({ partId: 'p2', questionId: 'q2', verdict: 'incorrect', awardedPoints: 0, maxPoints: 1, grading: 'baffled', gradedAt: '2026-07-02T09:00:00.000Z' });
    await log.append({ partId: 'p3', questionId: 'q2', verdict: 'partial', awardedPoints: 0.5, maxPoints: 1, grading: 'meh', gradedAt: '2026-07-02T11:30:00.000Z', elapsedMs: 45000 });

    expect(await log.count()).toBe(3);
    const list = await log.list(2);
    expect(list.map((e) => e.partId)).toEqual(['p3', 'p2']);
    expect((await log.list(2, 2)).map((e) => e.partId)).toEqual(['p1']);

    const daily = await log.dailyActivity(30, new Date('2026-07-03T00:00:00.000Z'));
    expect(daily['2026-07-02']).toBe(2);
    expect(daily['2026-07-01']).toBe(1);
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

  it('hashes cached questions like the core manifest and ignores runtime-only fields', () => {
    const hash = questionContentHash(question);
    const withPlayable = { ...question, playable: true };
    const reordered = {
      title: question.title,
      source: question.source,
      status: question.status,
      schemaVersion: question.schemaVersion,
      parts: question.parts,
      lang: question.lang,
      id: question.id,
    } as unknown as Question;

    expect(questionContentHash(withPlayable)).toBe(hash);
    expect(questionContentHash(reordered)).toBe(hash);
    expect(questionContentHash({ ...question, title: 'Andere Frage' })).not.toBe(hash);
  });
});
