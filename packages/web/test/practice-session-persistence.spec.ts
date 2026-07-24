import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { STORAGE, type LocalArchive, type Question } from '@qed2/core-logic';
import { archiveStore, questionCache, storage } from '../src/services.js';
import { usePracticeStore } from '../src/stores/practice.js';
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
});
