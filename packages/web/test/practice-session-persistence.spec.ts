import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  GUEST_ATTEMPT_OWNER,
  STORAGE,
  type LocalArchive,
  type Question,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  historyLog,
  questionCache,
  storage,
} from '../src/services.js';
import { usePracticeStore } from '../src/stores/practice.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const EMPTY_ARCHIVE: LocalArchive = {
  content: { perPart: [], perCompetency: [] },
  baseVersion: 0,
};

function question(id: string, nr: number): Question {
  return {
    id,
    schemaVersion: 3,
    status: 'reviewed',
    lang: 'de',
    source: {
      suite: 'srdp',
      year: 2026,
      term: 'haupttermin',
      part: 't1',
      nr,
      file: `${id}.pdf`,
    },
    title: id,
    playable: true,
    parts: [
      {
        id: `${id}-a`,
        label: 'a',
        competencies: [{ code: 'AG 1.1' }],
        answer: {
          kind: 'choice',
          options: [
            [{ t: 'text', v: 'richtig' }],
            [{ t: 'text', v: 'falsch' }],
          ],
          correct: [0],
          selectCount: 1,
        },
        scoring: { mode: 'allOrNothing', points: 1 },
        points: 1,
      },
    ],
  };
}

async function freshStores(): Promise<{
  practice: ReturnType<typeof usePracticeStore>;
  progress: ReturnType<typeof useProgressStore>;
}> {
  setActivePinia(createPinia());
  const progress = useProgressStore();
  await progress.init();
  return { practice: usePracticeStore(), progress };
}

async function gradeCurrent(practice: ReturnType<typeof usePracticeStore>): Promise<void> {
  const current = practice.current;
  if (!current) throw new Error('Expected an active practice part');
  await practice.recordGraded({
    part: current.part,
    submission: { kind: 'choice', selected: [0] },
    result: {
      verdict: 'correct',
      correct: true,
      awardedPoints: 1,
      maxPoints: 1,
    },
  });
}

async function guestSession(): Promise<{
  owner?: { userId: string; guestGeneration?: string };
  graded: Array<{ clientAttemptId: string }>;
} | undefined> {
  return storage.get(STORAGE.app, 'practice-session:guest');
}

describe('practice session persistence', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
      storage.clear(STORAGE.history),
      storage.clear(STORAGE.auth),
    ]);
    await archiveStore.save(EMPTY_ARCHIVE);
    await questionCache.putMany([question('q1', 1), question('q2', 2)]);
  });

  it('resumes after the last completed part without losing the daily grade', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const current = first.practice.current;
    expect(current?.part.id).toBe('q1-a');

    await first.practice.recordGraded({
      part: current!.part,
      submission: { kind: 'choice', selected: [0] },
      result: {
        verdict: 'correct',
        correct: true,
        awardedPoints: 1,
        maxPoints: 1,
      },
    });
    first.practice.next();
    await first.practice.finishSession();

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);

    expect(restored.practice.phase).toBe('running');
    expect(restored.practice.graded.map((record) => record.partId)).toEqual(['q1-a']);
    expect(restored.practice.current?.part.id).toBe('q2-a');
    expect(restored.progress.practicedParts).toBe(1);
  });

  it('advances an in-memory paused session when the scored part was not continued', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const current = practice.current;
    await practice.recordGraded({
      part: current!.part,
      submission: { kind: 'choice', selected: [0] },
      result: {
        verdict: 'correct',
        correct: true,
        awardedPoints: 1,
        maxPoints: 1,
      },
    });
    await practice.finishSession();

    await expect(practice.restoreSession()).resolves.toBe(true);
    expect(practice.graded.map((record) => record.partId)).toEqual(['q1-a']);
    expect(practice.current?.part.id).toBe('q2-a');
  });

  it('removes the durable snapshot only when a session is deliberately aborted', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    first.practice.abort();

    await vi.waitFor(async () => {
      expect(await storage.get(STORAGE.app, 'practice-session:guest')).toBeUndefined();
    });
    const restored = await freshStores();

    await expect(restored.practice.restoreSession()).resolves.toBe(false);
    expect(restored.practice.phase).toBe('idle');
  });

  it('does not expose archive, history or session state when the write-ahead outbox cannot commit', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    vi.spyOn(attemptOutbox, 'enqueue').mockRejectedValueOnce(new Error('outbox unavailable'));

    await expect(gradeCurrent(practice)).rejects.toThrow('outbox unavailable');

    expect((await archiveStore.load()).content.perPart).toHaveLength(0);
    expect(await historyLog.count()).toBe(0);
    expect((await guestSession())?.graded).toEqual([]);
    expect(practice.graded).toEqual([]);
  });

  it('retains the staged guest attempt when the renderer stops before the archive write', async () => {
    const { practice, progress } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    vi.spyOn(archiveStore, 'applyGrade').mockRejectedValueOnce(new Error('crash before archive'));

    await expect(gradeCurrent(practice)).rejects.toThrow('crash before archive');

    const [attempt] = await attemptOutbox.list(GUEST_ATTEMPT_OWNER);
    expect(attempt).toMatchObject({ questionId: 'q1', partId: 'q1-a', correct: true });
    expect((await archiveStore.load()).content.perPart).toHaveLength(0);
    expect(await historyLog.count()).toBe(0);
    expect((await guestSession())?.graded).toEqual([]);
    await expect(progress.claimGuestAttempts('recovered-user')).resolves.toBe(1);
    expect(await attemptOutbox.list('recovered-user')).toEqual([attempt]);
  });

  it('retains the staged guest attempt after the archive commits but before history', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const applyGrade = archiveStore.applyGrade.bind(archiveStore);
    vi.spyOn(archiveStore, 'applyGrade').mockImplementationOnce(async (input) => {
      await applyGrade(input);
      throw new Error('crash after archive');
    });

    await expect(gradeCurrent(practice)).rejects.toThrow('crash after archive');

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(0);
    expect((await guestSession())?.graded).toEqual([]);
  });

  it('retains the staged guest attempt after history commits but before the session snapshot', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const append = historyLog.append.bind(historyLog);
    vi.spyOn(historyLog, 'append').mockImplementationOnce(async (entry) => {
      await append(entry);
      throw new Error('crash after history');
    });

    await expect(gradeCurrent(practice)).rejects.toThrow('crash after history');

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect((await guestSession())?.graded).toEqual([]);
  });

  it('keeps one idempotent, claimable attempt after the session commits but before flushing', async () => {
    const { practice, progress } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    vi.spyOn(progress, 'flushStagedAttempt').mockRejectedValueOnce(new Error('crash after session'));

    await expect(gradeCurrent(practice)).rejects.toThrow('crash after session');

    const [attempt] = await attemptOutbox.list(GUEST_ATTEMPT_OWNER);
    expect(attempt).toBeDefined();
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect((await guestSession())?.graded).toEqual([
      expect.objectContaining({ clientAttemptId: attempt!.clientAttemptId }),
    ]);

    await progress.stageAttempt(attempt!, GUEST_ATTEMPT_OWNER);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    await expect(progress.claimGuestAttempts('recovered-user')).resolves.toBe(1);
    expect(await attemptOutbox.list('recovered-user')).toEqual([attempt]);
  });

  it('routes a guest answer enqueued after claim completion and keeps its session key fixed', async () => {
    const { practice, progress } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);

    let enteredStage!: () => void;
    const stageEntered = new Promise<void>((resolve) => {
      enteredStage = resolve;
    });
    let releaseStage!: () => void;
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const originalStage = progress.stageAttempt.bind(progress);
    vi.spyOn(progress, 'stageAttempt').mockImplementationOnce(async (attempt, owner) => {
      enteredStage();
      await stageGate;
      return originalStage(attempt, owner);
    });

    // The practice renderer has fixed the old guest generation, but has not
    // yet committed its write-ahead entry.
    const grading = gradeCurrent(practice);
    await stageEntered;

    // A second window completes redemption, moves the currently empty guest
    // bucket and clears its pending marker before the old enqueue resumes.
    await expect(progress.claimGuestAttempts('claimed-user')).resolves.toBe(0);
    expect(await attemptOutbox.pendingGuestClaim()).toBeUndefined();
    useAuthStore().session = {
      token: 'claimed-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'claimed-user', username: 'claimed' },
    };

    releaseStage();
    await grading;

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count('claimed-user')).toBe(1);
    expect((await guestSession())?.owner).toMatchObject({ userId: GUEST_ATTEMPT_OWNER });
    expect((await guestSession())?.graded).toHaveLength(1);
    await expect(
      storage.get(STORAGE.app, 'practice-session:claimed-user'),
    ).resolves.toBeUndefined();
  });
});

/**
 * „Programm üben" in the navigation means today's FSRS programme. A set the
 * user hand-picked in the Aufgaben list is a different thing that happens to
 * run on the same screen — resuming it there is the bug this guards.
 */
describe('session origin', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
    ]);
    await archiveStore.save(EMPTY_ARCHIVE);
    await questionCache.putMany([question('q1', 1), question('q2', 2)]);
  });

  it('tags a hand-picked set as manual and a recommendation as smart', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);
    expect(practice.origin).toBe('manual');
  });

  it('refuses to hand a left-over manual set back to the programme entry', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession(); // leaving the screen persists, never aborts

    // In memory (same tab, user tapped the nav entry right after leaving).
    await expect(practice.restoreSession('smart')).resolves.toBe(false);

    // And after a reload, from the durable snapshot.
    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession('smart')).resolves.toBe(false);
    expect(reloaded.practice.phase).toBe('idle');
  });

  it('does not hand back a programme saved on an earlier day', async () => {
    // „Programm starten" means TODAY's due reviews. Without a bound the same
    // half-finished list came back forever and FSRS never ran again.
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession();

    const stale = await storage.get<Record<string, unknown>>(
      STORAGE.app,
      'practice-session:guest',
    );
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    await storage.set(STORAGE.app, 'practice-session:guest', {
      ...stale,
      origin: 'smart',
      savedAt: yesterday,
    });

    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession('smart')).resolves.toBe(false);
    expect(reloaded.practice.phase).toBe('idle');
    // …and the stale snapshot is cleared rather than left to be re-offered.
    await expect(
      storage.get(STORAGE.app, 'practice-session:guest'),
    ).resolves.toBeUndefined();
  });

  it('still resumes a programme saved earlier the same day', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession();

    const saved = await storage.get<Record<string, unknown>>(
      STORAGE.app,
      'practice-session:guest',
    );
    await storage.set(STORAGE.app, 'practice-session:guest', {
      ...saved,
      origin: 'smart',
      savedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession('smart')).resolves.toBe(true);
    expect(reloaded.practice.phase).toBe('running');
  });

  it('retries the request the user actually made, not whatever the URL says', async () => {
    // The Aufgaben bulk handoff puts no ids in the URL, so a retry that
    // re-read the route silently swapped the hand-picked set for the FSRS
    // programme.
    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);
    expect(practice.origin).toBe('manual');

    await practice.retry();
    expect(practice.origin).toBe('manual');
    expect(practice.items.map((i) => i.questionId)).toEqual(['q1']);
  });

  it('still resumes that set for the Aufgaben handoff and for an unrestricted call', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession();

    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession()).resolves.toBe(true);
    expect(reloaded.practice.origin).toBe('manual');
    expect(reloaded.practice.current?.part.id).toBe('q1-a');
  });
});
