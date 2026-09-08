import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  GUEST_ATTEMPT_OWNER,
  STORAGE,
  hasAtomicStorage,
  historyEventRowKey,
  historyStorageKey,
  learningEventStorageKey,
  questionContentHash,
  type Question,
  type LocalProfileId,
  type StoredHistoryEvent,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  historyLog,
  learningEventStore,
  localProfileStore,
  ports,
  questionCache,
  storage,
} from '../src/services.js';
import { useProgressStore } from '../src/stores/progress.js';
import { practiceSessionStorageKey, usePracticeStore, type GradedRecord } from '../src/stores/practice.js';

const originalRuntime = ports.coreRuntime;
const COMMIT = 'c'.repeat(40);
const SAVE_WARNING = 'Die Lernempfehlung konnte lokal nicht gespeichert werden.';

function question(id: string): Question {
  return {
    id,
    schemaVersion: 3,
    status: 'reviewed',
    lang: 'de',
    source: { suite: 'srdp', year: 2026, term: 'haupttermin', part: 't1', nr: 1, file: `${id}.pdf` },
    title: id,
    playable: true,
    parts: [{
      id: `${id}-a`,
      label: 'a',
      competencies: [{ code: 'AG 1.1' }],
      answer: {
        kind: 'choice',
        options: [[{ t: 'text', v: 'richtig' }], [{ t: 'text', v: 'falsch' }]],
        correct: [0],
        selectCount: 1,
      },
      scoring: { mode: 'allOrNothing', points: 1 },
      points: 1,
    }],
  };
}

async function freshPractice() {
  setActivePinia(createPinia());
  await useProgressStore().init();
  return usePracticeStore();
}

async function failedFirstEvent() {
  const practice = await freshPractice();
  await practice.startQuestions(['q1', 'q2']);
  vi.spyOn(learningEventStore, 'recordFirst').mockRejectedValueOnce(
    new DOMException('The learning object store is missing', 'NotFoundError'),
  );
  const record = await practice.recordGraded({
    part: practice.current!.part,
    submission: { kind: 'choice', selected: [1] },
    result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    hintLevel: 2,
  });
  expect(record).toBeDefined();
  expect(practice.warning).toBe(SAVE_WARNING);
  return { practice, record: record!, profile: localProfileStore.current() };
}

async function durableGradeState() {
  return {
    archive: await archiveStore.load(),
    history: await historyLog.list(),
    outbox: await attemptOutbox.list(GUEST_ATTEMPT_OWNER),
  };
}

async function useLegacyProfileHistory(record: GradedRecord, profile: LocalProfileId) {
  const eventKey = historyEventRowKey(record.clientAttemptId, profile);
  const history = (await storage.get<StoredHistoryEvent>(STORAGE.history, eventKey))!;
  await storage.set(STORAGE.history, historyStorageKey(profile), [history.entry]);
  await storage.delete(STORAGE.history, eventKey);
  return history;
}

async function rawProgressState() {
  const addresses = (await Promise.all([STORAGE.archive, STORAGE.history].map(async (collection) =>
    (await storage.keys(collection)).sort().map((key) => ({ collection, key })),
  ))).flat();
  return storage.readBatch!(addresses);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
  await Promise.all([
    STORAGE.app, STORAGE.questions, STORAGE.archive, STORAGE.history, STORAGE.learning, STORAGE.auth,
  ].map((collection) => storage.clear(collection)));
  await localProfileStore.initialize();
  await archiveStore.save({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
  ports.coreRuntime = {
    capabilities: { localCore: true },
    getEndpoint: async () => ({ baseUrl: 'http://core.offline.test', source: 'local', contentId: COMMIT }),
  };
  await questionCache.putManyVerified(['q1', 'q2'].map((id) => {
    const value = question(id);
    return { question: value, contentHash: 'd'.repeat(64), wireHash: questionContentHash(value) };
  }), COMMIT);
});

afterEach(() => {
  ports.coreRuntime = originalRuntime;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('practice learning evidence recovery', () => {
  it('restores an exact v4 session and diagnoses it using unmigrated profile history without rewriting progress', async () => {
    const { record, profile } = await failedFirstEvent();
    const currentKey = practiceSessionStorageKey(profile);
    const snapshot = (await storage.get<{
      version: number;
      owner: { localProfileId?: LocalProfileId };
    }>(STORAGE.app, currentKey))!;
    snapshot.version = 4;
    delete snapshot.owner.localProfileId;
    await storage.set(STORAGE.app, 'practice-session:guest', snapshot);
    await storage.delete(STORAGE.app, currentKey);
    await useLegacyProfileHistory(record, profile);
    const before = await rawProgressState();
    const listHistory = vi.spyOn(historyLog, 'list');
    if (!hasAtomicStorage(storage)) throw new Error('WebStorage must support atomic commits');
    const commit = vi.spyOn(storage, 'commitBatch');
    const set = vi.spyOn(storage, 'set');
    const remove = vi.spyOn(storage, 'delete');
    const restored = await freshPractice();
    await expect(restored.restoreSession()).resolves.toBe(true);
    expect(restored.currentReview?.clientAttemptId).toBe(record.clientAttemptId);
    expect(restored.warning).toBeUndefined();
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toMatchObject({ contentId: COMMIT });
    await restored.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    expect(restored.warning).toBeUndefined();
    expect(await learningEventStore.event(profile, record.clientAttemptId))
      .toMatchObject({ errorCode: 'algebra' });
    expect(await rawProgressState()).toEqual(before);
    expect(listHistory).not.toHaveBeenCalled();
    expect(commit.mock.calls.flatMap(([batch]) => batch.mutations)
      .filter((mutation) => mutation.collection === STORAGE.archive || mutation.collection === STORAGE.history))
      .toEqual([]);
    for (const spy of [set, remove]) {
      expect(spy.mock.calls.filter(([collection]) => collection === STORAGE.archive || collection === STORAGE.history))
        .toEqual([]);
    }
  });

  it.each(['duplicate', 'wrong-revision', 'unscoped'] as const)('rejects %s legacy history for recovery', async (reason) => {
    const { record, profile } = await failedFirstEvent();
    const history = await useLegacyProfileHistory(record, profile);
    const key = historyStorageKey(profile);
    if (reason === 'duplicate') {
      await storage.set(STORAGE.history, key, [history.entry, { ...history.entry, contentId: 'a'.repeat(40) }]);
    } else if (reason === 'wrong-revision') {
      await storage.set(STORAGE.history, key, [{ ...history.entry, contentId: 'a'.repeat(40) }]);
    } else {
      await storage.delete(STORAGE.history, key);
      // A different profile's copy cannot establish this attempt's ownership.
      await storage.set(STORAGE.history, historyStorageKey('user:someone-else'), [history.entry]);
    }
    const before = await rawProgressState();
    const restored = await freshPractice();
    await restored.restoreSession();
    await restored.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    expect(restored.warning).toBe('Die Fehlerdiagnose konnte lokal nicht gespeichert werden.');
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toBeUndefined();
    expect(await rawProgressState()).toEqual(before);
  });

  it('never hides a corrupt modern history row behind valid legacy history', async () => {
    const { record, profile } = await failedFirstEvent();
    await useLegacyProfileHistory(record, profile);
    await storage.set(STORAGE.history, historyEventRowKey(record.clientAttemptId, profile), { version: 2 });
    const restored = await freshPractice();
    await restored.restoreSession();
    expect(restored.warning).toBe(SAVE_WARNING);
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toBeUndefined();
  });

  it('repairs the current saved review without replaying its grade or retaining its answer', async () => {
    const { record, profile } = await failedFirstEvent();
    const before = await durableGradeState();
    const restored = await freshPractice();
    await expect(restored.restoreSession()).resolves.toBe(true);
    expect(restored.warning).toBeUndefined();
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toEqual({
      version: 1, partId: 'q1-a', outcome: 'incorrect', hintLevel: 2, contentId: COMMIT, at: record.gradedAt,
    });
    await restored.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    expect(restored.warning).toBeUndefined();
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toMatchObject({
      outcome: 'incorrect', errorCode: 'algebra',
    });
    expect(await durableGradeState()).toEqual(before);
    const document = await storage.get<{ rows: unknown[] }>(STORAGE.learning, learningEventStorageKey(profile));
    expect(document?.rows).toHaveLength(1);
    expect(JSON.stringify(document)).not.toContain('submission');
    expect(JSON.stringify(document)).not.toContain('selected');
  });

  it('repairs a missing event on an explicit diagnosis without reload', async () => {
    const { practice, record, profile } = await failedFirstEvent();
    const before = await durableGradeState();
    await practice.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toMatchObject({
      contentId: COMMIT,
      errorCode: 'algebra',
    });
    expect(await durableGradeState()).toEqual(before);
  });

  it('preserves enriched evidence and does not call recordFirst on repeated restoration', async () => {
    const { record, profile } = await failedFirstEvent();
    const restored = await freshPractice();
    await restored.restoreSession();
    await restored.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    const before = await storage.readBatch!([{ collection: STORAGE.learning, key: learningEventStorageKey(profile) }]);
    const recordFirst = vi.spyOn(learningEventStore, 'recordFirst');
    recordFirst.mockClear();
    const again = await freshPractice();
    await again.restoreSession();
    expect(recordFirst).not.toHaveBeenCalled();
    expect(await storage.readBatch!([{ collection: STORAGE.learning, key: learningEventStorageKey(profile) }])).toEqual(before);
  });

  it('accepts a concurrent matching insert without overwriting its diagnosis', async () => {
    const { record, profile } = await failedFirstEvent();
    const insert = learningEventStore.recordFirst.bind(learningEventStore);
    vi.spyOn(learningEventStore, 'recordFirst').mockImplementationOnce(async (...args) => {
      await insert(...args);
      await learningEventStore.recordDiagnosis(profile, record.clientAttemptId, 'algebra');
      throw new Error('Learning-event identity was reused');
    });
    const restored = await freshPractice();
    await restored.restoreSession();
    expect(restored.warning).toBeUndefined();
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toMatchObject({ errorCode: 'algebra' });
  });

  it('does not repopulate missing evidence for other saved attempts', async () => {
    const { record, profile } = await failedFirstEvent();
    const key = practiceSessionStorageKey(profile);
    const snapshot = (await storage.get<{
      items: Array<{ clientAttemptId: string }>;
      graded: GradedRecord[];
    }>(STORAGE.app, key))!;
    const other = {
      ...snapshot.graded[0]!,
      clientAttemptId: snapshot.items[1]!.clientAttemptId,
      partId: 'q2-a',
      questionId: 'q2',
    };
    snapshot.graded.push(other);
    await storage.set(STORAGE.app, key, snapshot);
    const history = (await storage.get<StoredHistoryEvent>(
      STORAGE.history, historyEventRowKey(record.clientAttemptId, profile),
    ))!;
    await storage.set(STORAGE.history, historyEventRowKey(other.clientAttemptId, profile), {
      ...history,
      entry: { ...history.entry, clientAttemptId: other.clientAttemptId, partId: 'q2-a', questionId: 'q2' },
    });
    const restored = await freshPractice();
    await restored.restoreSession();
    expect(restored.currentReview?.clientAttemptId).toBe(record.clientAttemptId);
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toBeDefined();
    expect(await learningEventStore.event(profile, other.clientAttemptId)).toBeUndefined();
  });

  it('does not repair a previous profile after an account switch', async () => {
    const { practice, record, profile } = await failedFirstEvent();
    await localProfileStore.activateUser('someone-else');
    await practice.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    expect(practice.warning).toBe('Die Fehlerdiagnose konnte lokal nicht gespeichert werden.');
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toBeUndefined();
    expect(await learningEventStore.event(localProfileStore.current(), record.clientAttemptId)).toBeUndefined();
  });

  it.each(['unprovenanced', 'wrong-profile'] as const)('does not reconstruct from %s original history', async (reason) => {
    const { record, profile } = await failedFirstEvent();
    const key = historyEventRowKey(record.clientAttemptId, profile);
    const row = (await storage.get<StoredHistoryEvent>(STORAGE.history, key))!;
    if (reason === 'unprovenanced') delete row.entry.contentId;
    else row.profileId = 'user:someone-else';
    await storage.set(STORAGE.history, key, row);
    const restored = await freshPractice();
    await restored.restoreSession();
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toBeUndefined();
    await restored.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    expect(restored.warning).toBe('Die Fehlerdiagnose konnte lokal nicht gespeichert werden.');
    expect(await learningEventStore.event(profile, record.clientAttemptId)).toBeUndefined();
  });

  it('keeps real storage failures visible while the first grade remains durable', async () => {
    const { record } = await failedFirstEvent();
    const before = await durableGradeState();
    vi.spyOn(learningEventStore, 'recordFirst').mockRejectedValue(new Error('storage unavailable'));
    const restored = await freshPractice();
    await restored.restoreSession();
    expect(restored.warning).toBe(SAVE_WARNING);
    await restored.recordDiagnosis(record.clientAttemptId, record.partId, 'algebra');
    expect(restored.warning).toBe('Die Fehlerdiagnose konnte lokal nicht gespeichert werden.');
    expect(await storage.get(STORAGE.app, practiceSessionStorageKey(localProfileStore.current())))
      .toMatchObject({ graded: [{ result: { verdict: 'incorrect' } }] });
    expect(await durableGradeState()).toEqual(before);
  });
});
