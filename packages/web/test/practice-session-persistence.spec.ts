import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  accountStorageIdentity,
  DEFAULT_CONFIG,
  GUEST_ATTEMPT_OWNER,
  STORAGE,
  learningEventStorageKey,
  questionContentHash,
  type AtomicStoragePort,
  type AiAssessCacheLocator,
  type AiExplainCacheLocator,
  type LocalArchive,
  type Question,
  type CoreRuntimePort,
  type ShellPort,
  type LearningEvent,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  authStore as authStorage,
  historyLog,
  localProfileStore,
  questionCache,
  storage,
  ports,
} from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import {
  practiceSessionStorageKey,
  usePracticeStore,
  type SessionItem,
  type GradedRecord,
} from '../src/stores/practice.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const EMPTY_ARCHIVE: LocalArchive = {
  content: { perPart: [], perCompetency: [] },
  baseVersion: 0,
};
const originalCoreRuntime = ports.coreRuntime;
const originalShell = ports.shell;
const TEST_COMMIT = 'c'.repeat(40);
const atomicStorage = storage as typeof storage & AtomicStoragePort;

afterEach(() => {
  ports.coreRuntime = originalCoreRuntime;
  ports.shell = originalShell;
});

function desktopShell(windowKind: 'main' | 'practice'): ShellPort {
  return {
    capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
    windowKind,
    onCommand: () => () => undefined,
  };
}

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

function openQuestion(id: string, nr: number): Question {
  const base = question(id, nr);
  return {
    ...base,
    parts: [{
      ...base.parts[0]!,
      answer: { kind: 'open', rubric: [{ t: 'text', v: 'Begründung' }], grader: 'self' },
      solution: [{ result: [{ t: 'text', v: 'Musterlösung' }] }],
    }],
  };
}

function numericQuestion(id: string, nr: number): Question {
  const base = question(id, nr);
  return {
    ...base,
    parts: [{
      ...base.parts[0]!,
      answer: { kind: 'numeric', blanks: [{ id: 'v', value: 42, tol: 0 }] },
    }],
  };
}

function contentQuestion(q: Question, contentHash = 'd'.repeat(64)) {
  return { ...q, contentHash, wireHash: questionContentHash(q) };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubObjectUrls(value = 'blob:test'): {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  const NativeUrl = URL;
  const createObjectURL = vi.fn(() => value);
  const revokeObjectURL = vi.fn();
  class AssetTestUrl extends NativeUrl {}
  Object.defineProperties(AssetTestUrl, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: revokeObjectURL },
  });
  vi.stubGlobal('URL', AssetTestUrl);
  return { createObjectURL, revokeObjectURL };
}

async function seedImmutableOfflineQuestions(list: Question[]): Promise<void> {
  ports.coreRuntime = {
    capabilities: { localCore: true },
    getEndpoint: async () => ({
      baseUrl: 'http://core.offline.test',
      source: 'local',
      contentId: TEST_COMMIT,
    }),
  } satisfies CoreRuntimePort;
  await questionCache.putManyVerified(
    list.map((q) => ({
      question: q,
      contentHash: 'd'.repeat(64),
      wireHash: questionContentHash(q),
    })),
    TEST_COMMIT,
  );
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
  owner?: { userId: string; guestGeneration?: string; localProfileId?: string };
  index?: number;
  graded: Array<{ clientAttemptId: string }>;
} | undefined> {
  return storage.get(STORAGE.app, activeSessionKey());
}

function activeSessionKey(windowKind?: string): string {
  return practiceSessionStorageKey(localProfileStore.current(), windowKind);
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
      storage.clear(STORAGE.learning),
      storage.clear(STORAGE.auth),
    ]);
    await localProfileStore.initialize();
    await archiveStore.save(EMPTY_ARCHIVE);
    await seedImmutableOfflineQuestions([
      question('q1', 1),
      question('q2', 2),
      openQuestion('q3', 3),
      numericQuestion('q4', 4),
    ]);
  });

  it('hands off the exact durable selection in click order, including after reload', async () => {
    const { practice } = await freshStores();
    const preparedId = await practice.startPrepared(['q2', 'q1', 'q2']);
    expect(preparedId).toBe(practice.items[0]!.clientAttemptId);
    expect(practice.items.map((item) => item.questionId)).toEqual(['q2', 'q1']);
    await expect(practice.restoreSession('manual', preparedId)).resolves.toBe(true);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession('manual', preparedId)).resolves.toBe(true);
    expect(restored.practice.items.map((item) => item.questionId)).toEqual(['q2', 'q1']);
    expect(restored.practice.current?.question.id).toBe('q2');
    expect(restored.practice.contentId).toBe(TEST_COMMIT);
  });

  it('does not hand off a new selection when its first durable write fails', async () => {
    const { practice } = await freshStores();
    await practice.startPrepared(['q1']);
    const previous = await guestSession();
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (request.mutations.some((mutation) => mutation.collection === STORAGE.app
        && mutation.key === activeSessionKey())) throw new Error('simulated disk failure');
      return commit(request);
    });

    await expect(practice.startPrepared(['q2'])).rejects.toThrow();
    expect(await guestSession()).toEqual(previous);
    expect(practice.sessionIdentityDurable).toBe(false);
  });

  it('rejects incomplete cached selections without replacing the saved programme', async () => {
    const { practice } = await freshStores();
    await practice.startPrepared(['q1']);
    const previous = await guestSession();

    await expect(practice.startPrepared(['q2', 'missing'])).rejects.toThrow('Aufgabenbank');
    expect(practice.phase).toBe('error');
    expect(await guestSession()).toEqual(previous);
  });

  it('keeps the saved programme when every selected part is excluded', async () => {
    const { practice, progress } = await freshStores();
    await practice.startPrepared(['q1']);
    const previous = await guestSession();
    await progress.setGrading({ partId: 'q2-a', grading: 'excluded' });
    await progress.setGrading({ partId: 'q3-a', grading: 'excluded' });

    await expect(practice.startPrepared(['q2', 'q3'])).rejects.toThrow('Keine passenden Aufgaben.');
    expect(await guestSession()).toEqual(previous);
  });

  it('restores first-answer drafts across item changes and reload, then tombstones them with the grade', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q3', 'q4']);
    await expect(first.practice.saveAnswerDraft('q3-a', {
      kind: 'open',
      text: 'mein angefangener Lösungsweg',
      selfAssessment: {},
    })).resolves.toEqual({ status: 'saved' });
    first.practice.jumpTo(1);
    await expect(first.practice.saveAnswerDraft('q4-a', {
      kind: 'numeric',
      values: { v: '41,5' },
    })).resolves.toEqual({ status: 'saved' });
    first.practice.jumpTo(0);
    expect(first.practice.currentAnswerDraft).toMatchObject({
      kind: 'open',
      text: 'mein angefangener Lösungsweg',
    });
    await first.practice.finishSession();

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.currentAnswerDraft).toMatchObject({
      kind: 'open',
      text: 'mein angefangener Lösungsweg',
    });
    restored.practice.jumpTo(1);
    expect(restored.practice.currentAnswerDraft).toEqual({
      kind: 'numeric',
      values: { v: '41,5' },
    });
    await restored.practice.recordGraded({
      part: restored.practice.current!.part,
      submission: { kind: 'numeric', values: { v: '42' } },
      result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
    });

    expect(restored.practice.currentAnswerDraft).toBeUndefined();
    const durable = await storage.get<{ items: SessionItem[] }>(STORAGE.app, activeSessionKey());
    expect(durable?.items[1]?.answerDraft?.submission).toBeUndefined();
    expect(JSON.stringify(await archiveStore.load())).not.toContain('41,5');
    expect(JSON.stringify(await historyLog.list())).not.toContain('41,5');
    expect(JSON.stringify(await attemptOutbox.list(GUEST_ATTEMPT_OWNER))).not.toContain('41,5');
  });

  it('keeps one window draft and never lets a stale draft reappear after another window grades', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    await useProgressStore().init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    await useProgressStore().init();
    const second = usePracticeStore();
    await second.restoreSession();

    setActivePinia(firstPinia);
    await expect(first.saveAnswerDraft('q1-a', { kind: 'choice', selected: [0] }))
      .resolves.toEqual({ status: 'saved' });
    setActivePinia(secondPinia);
    await expect(second.saveAnswerDraft('q1-a', { kind: 'choice', selected: [1] }))
      .resolves.toEqual({ status: 'failed' });

    setActivePinia(firstPinia);
    await gradeCurrent(first);
    setActivePinia(secondPinia);
    await expect(second.saveAnswerDraft('q1-a', { kind: 'choice', selected: [1] }))
      .resolves.toMatchObject({ status: 'superseded-by-grade', record: { partId: 'q1-a' } });

    const durable = await storage.get<{ items: SessionItem[] }>(STORAGE.app, activeSessionKey());
    expect(durable?.items[0]?.answerDraft?.submission).toBeUndefined();
    expect(durable?.items[0]?.answerDraft?.revision).toBeGreaterThan(0);
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
  });

  it('converges a paused draft writer onto the grade committed by another window', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    await useProgressStore().init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    await useProgressStore().init();
    const second = usePracticeStore();
    await second.restoreSession();

    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => { markPaused = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (
        !held
        && request.mutations.some((mutation) =>
          mutation.collection === STORAGE.app
          && mutation.operation === 'set'
          && JSON.stringify(mutation.value).includes('"selected":[1]'))
      ) {
        held = true;
        markPaused();
        await gate;
      }
      return commit(request);
    });

    setActivePinia(secondPinia);
    const staleSaving = second.saveAnswerDraft('q1-a', { kind: 'choice', selected: [1] });
    await paused;
    setActivePinia(firstPinia);
    await gradeCurrent(first);
    release();
    await expect(staleSaving).resolves.toMatchObject({
      status: 'superseded-by-grade',
      record: { partId: 'q1-a', result: { verdict: 'correct' } },
    });

    expect(second.currentReview).toMatchObject({ partId: 'q1-a', result: { verdict: 'correct' } });
    expect(second.currentAnswerDraft).toBeUndefined();
    expect(second.graded).toHaveLength(1);
    expect((await attemptOutbox.list(GUEST_ATTEMPT_OWNER))).toHaveLength(1);
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
  });

  it('restores an account-scoped self-assessment draft and clears it in the atomic grade', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q3']);
    await expect(first.practice.saveSelfAssessmentDraft('q3-a', {
      submission: { kind: 'open', text: 'privater Entwurf', selfAssessment: {} },
      assessment: { awardedPoints: 0, overall: 'none' },
      selectedPoints: 0,
      grading: 'baffled',
      indeterminate: false,
      indeterminateMax: 1,
    })).resolves.toBe(true);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.currentSelfAssessmentDraft).toMatchObject({
      partId: 'q3-a',
      submission: { kind: 'open', text: 'privater Entwurf' },
      selectedPoints: 0,
      grading: 'baffled',
    });
    const current = restored.practice.current!;
    await restored.practice.recordGraded({
      part: current.part,
      submission: { kind: 'open', text: 'privater Entwurf', selfAssessment: { awardedPoints: 0, overall: 'none' } },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
      manualGrading: 'baffled',
    });

    expect(restored.practice.currentSelfAssessmentDraft).toBeUndefined();
    const durable = await storage.get<Record<string, unknown>>(STORAGE.app, activeSessionKey());
    expect(durable).not.toHaveProperty('selfAssessmentDraft');
    expect(JSON.stringify(await archiveStore.load())).not.toContain('privater Entwurf');
    expect(JSON.stringify(await historyLog.list())).not.toContain('privater Entwurf');
    expect(JSON.stringify(await attemptOutbox.list(GUEST_ATTEMPT_OWNER))).not.toContain('privater Entwurf');
  });

  it('does not let a stale second window overwrite a self-assessment draft', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    const firstProgress = useProgressStore();
    await firstProgress.init();
    const first = usePracticeStore();
    await first.startQuestions(['q3']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    const secondProgress = useProgressStore();
    await secondProgress.init();
    const second = usePracticeStore();
    await second.restoreSession();

    setActivePinia(firstPinia);
    await expect(first.saveSelfAssessmentDraft('q3-a', {
      submission: { kind: 'open', text: 'Fenster A', selfAssessment: {} },
      assessment: {},
      selectedPoints: null,
      grading: null,
      indeterminate: false,
      indeterminateMax: 1,
    })).resolves.toBe(true);
    setActivePinia(secondPinia);
    await expect(second.saveSelfAssessmentDraft('q3-a', {
      submission: { kind: 'open', text: 'Fenster B', selfAssessment: {} },
      assessment: {},
      selectedPoints: null,
      grading: null,
      indeterminate: false,
      indeterminateMax: 1,
    })).resolves.toBe(false);

    const durable = await storage.get<{ selfAssessmentDraft?: { submission?: { text?: string } } }>(
      STORAGE.app,
      activeSessionKey(),
    );
    expect(durable?.selfAssessmentDraft?.submission?.text).toBe('Fenster A');
  });

  it.each(['hint', 'assessment'] as const)(
    'saves a manual assessment after receiving AI %s, then restores the committed review',
    async (mode) => {
      const { practice } = await freshStores();
      await practice.startQuestions(['q3', 'q1']);
      const submission = { kind: 'open' as const, text: 'Meine Begründung', selfAssessment: {} };
      await practice.saveAnswerDraft('q3-a', submission);
      await practice.saveSelfAssessmentDraft('q3-a', {
        submission,
        assessment: {},
        selectedPoints: null,
        grading: null,
        indeterminate: false,
        indeterminateMax: 1,
      });
      const common = {
        version: 1 as const,
        cacheKey: `v2:${'a'.repeat(64)}`,
        partId: 'q3-a',
        attemptPhase: 'first' as const,
        taskVersion: `${mode}.v1`,
        promptVersion: 'ai-v2',
        source: 'byo' as const,
        savedAt: new Date().toISOString(),
      };
      if (mode === 'hint') {
        await practice.recordAiHelp('q3-a', { ...common, mode: 'hint', hintLevel: 2 }, 2);
      } else {
        await practice.recordCachedAiAssessment('q3-a', {
          ...common,
          requestDigest: `v2:${'b'.repeat(64)}`,
          contentSource: 'local',
          contentId: TEST_COMMIT,
        } satisfies AiAssessCacheLocator);
      }
      await expect(practice.saveSelfAssessmentDraft('q3-a', {
        submission,
        assessment: { awardedPoints: 0, overall: 'none' },
        selectedPoints: 0,
        grading: 'baffled',
        indeterminate: false,
        indeterminateMax: 1,
      })).resolves.toBe(true);

      const record = await practice.recordGraded({
        part: practice.current!.part,
        submission: { ...submission, selfAssessment: { awardedPoints: 0, overall: 'none' } },
        result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
        manualGrading: 'baffled',
        ...(mode === 'hint' ? { hintLevel: 2 as const } : {}),
      });

      expect(record?.result.verdict).toBe('incorrect');
      expect(practice.currentSelfAssessmentDraft).toBeUndefined();
      expect(await attemptOutbox.list(GUEST_ATTEMPT_OWNER)).toHaveLength(1);
      expect(await historyLog.count()).toBe(1);
      expect((await archiveStore.load()).content.perPart).toHaveLength(1);
      const restored = await freshStores();
      await expect(restored.practice.restoreSession()).resolves.toBe(true);
      expect(restored.practice.currentReview?.clientAttemptId).toBe(record!.clientAttemptId);
      expect(restored.practice.currentReview?.pendingSubmission).toMatchObject({ text: submission.text });
      expect(restored.practice.current!.item[mode === 'hint' ? 'cachedAiHint' : 'cachedAiAssessment'])
        .toMatchObject({ cacheKey: common.cacheKey });
      await restored.practice.completeReviewAndNext();
      await gradeCurrent(restored.practice);
      expect(await attemptOutbox.list(GUEST_ATTEMPT_OWNER)).toHaveLength(2);
      expect(await historyLog.count()).toBe(2);
    },
  );

  it('can grade the next part after storing an AI diagnosis for an earlier review', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await gradeCurrent(practice);
    await practice.recordAiHelp('q1-a', {
      version: 1,
      cacheKey: `v2:${'d'.repeat(64)}`,
      mode: 'diagnosis',
      partId: 'q1-a',
      attemptPhase: 'first',
      taskVersion: 'diagnosis.v1',
      promptVersion: 'ai-v2',
      source: 'byo',
      savedAt: new Date().toISOString(),
    });
    await practice.completeReviewAndNext();
    await gradeCurrent(practice);

    expect(practice.graded).toHaveLength(2);
    expect(await attemptOutbox.list(GUEST_ATTEMPT_OWNER)).toHaveLength(2);
    expect(await historyLog.count()).toBe(2);
  });

  it('restores legacy AI help and grades while another part retains a manual grading pick', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await expect(practice.savePendingGrading('q1-a', 'good')).resolves.toBe(true);
    practice.jumpTo(1);
    await practice.finishSession();
    const key = activeSessionKey();
    const snapshot = (await storage.get<{ items: SessionItem[] }>(STORAGE.app, key))!;
    snapshot.items[1]!.cachedAiHelp = {
      version: 1,
      cacheKey: `v2:${'e'.repeat(64)}`,
      mode: 'hint',
      hintLevel: 1,
      partId: 'q2-a',
      attemptPhase: 'first',
      taskVersion: 'hint.v1',
      promptVersion: 'ai-v2',
      source: 'byo',
      savedAt: new Date().toISOString(),
    };
    snapshot.items[1]!.deliveredHintLevel = 1;
    await storage.set(STORAGE.app, key, snapshot);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.current!.item.cachedAiHint).toMatchObject({
      cacheKey: snapshot.items[1]!.cachedAiHelp.cacheKey,
    });
    await gradeCurrent(restored.practice);

    expect(restored.practice.graded).toHaveLength(1);
    expect(await attemptOutbox.list(GUEST_ATTEMPT_OWNER)).toHaveLength(1);
    expect((await storage.get<{ items: SessionItem[] }>(STORAGE.app, key))!.items[0]!.pendingGrading?.grading)
      .toBe('good');
  });

  it('keeps a correct written answer private through reload and profile switching, then removes it on next', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q3', 'q1']);
    const text = 'Meine richtige private Begründung';
    const record = await practice.recordGraded({
      part: practice.current!.part,
      submission: { kind: 'open', text, selfAssessment: { awardedPoints: 1, overall: 'full' } },
      result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
      manualGrading: 'good',
    });

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.currentReview?.clientAttemptId).toBe(record!.clientAttemptId);
    expect(restored.practice.currentReview?.pendingSubmission).toMatchObject({ text });
    expect(JSON.stringify(await archiveStore.load())).not.toContain(text);
    expect(JSON.stringify(await historyLog.list())).not.toContain(text);
    expect(JSON.stringify(await attemptOutbox.list(GUEST_ATTEMPT_OWNER))).not.toContain(text);

    await restored.progress.activateUserProfile('profile-b');
    useAuthStore().session = {
      token: 'profile-b-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'profile-b', username: 'profile-b' },
    };
    expect(restored.practice.sessionAccessible).toBe(false);
    expect(restored.practice.currentReview).toBeUndefined();
    await restored.progress.activateGuestProfile();
    useAuthStore().session = undefined;
    expect(restored.practice.currentReview?.pendingSubmission).toMatchObject({ text });

    await restored.practice.completeReviewAndNext();
    const snapshot = await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, activeSessionKey());
    expect(snapshot!.graded[0]!.pendingSubmission).toBeUndefined();
    expect(snapshot!.graded[0]!.reviewClosedAt).toBeDefined();
    const reopened = await freshStores();
    await expect(reopened.practice.restoreSession()).resolves.toBe(true);
    expect(reopened.practice.current!.part.id).toBe('q1-a');
    expect(JSON.stringify(await storage.get(STORAGE.app, activeSessionKey()))).not.toContain(text);
    expect(await historyLog.count()).toBe(1);
    expect(await attemptOutbox.list(GUEST_ATTEMPT_OWNER)).toHaveLength(1);
  });

  it('keeps an older correct attempt without an answer closed instead of inventing a review', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await gradeCurrent(practice);
    const key = activeSessionKey();
    const snapshot = (await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, key))!;
    delete snapshot.graded[0]!.pendingSubmission;
    await storage.set(STORAGE.app, key, snapshot);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.current!.part.id).toBe('q2-a');
    expect(restored.practice.graded[0]!.pendingSubmission).toBeUndefined();
    expect(await historyLog.count()).toBe(1);
  });

  it('keeps a higher paid hint paired with its locator when a slower window commits later', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    const firstProgress = useProgressStore();
    await firstProgress.init();
    const first = usePracticeStore();
    await first.startQuestions(['q1']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    const secondProgress = useProgressStore();
    await secondProgress.init();
    const second = usePracticeStore();
    await second.restoreSession();

    const locator = (level: 1 | 2, key: string, savedAt: string): AiExplainCacheLocator => ({
      version: 1,
      cacheKey: `v2:${key.repeat(64)}`,
      mode: 'hint',
      hintLevel: level,
      partId: 'q1-a',
      attemptPhase: 'first',
      taskVersion: 'hint.v1',
      promptVersion: 'ai-v2',
      source: 'byo',
      savedAt,
    });
    await second.recordAiHelp('q1-a', locator(2, '2', '2026-08-24T00:00:01.000Z'), 2);
    await first.recordAiHelp('q1-a', locator(1, '1', '2026-08-24T00:00:02.000Z'), 1);

    const durable = await storage.get<{
      items: Array<{ deliveredHintLevel?: number; cachedAiHint?: AiExplainCacheLocator }>;
    }>(STORAGE.app, activeSessionKey());
    expect(durable?.items[0]?.deliveredHintLevel).toBe(2);
    expect(durable?.items[0]?.cachedAiHint).toMatchObject({ hintLevel: 2, cacheKey: `v2:${'2'.repeat(64)}` });
  });

  it('hides an old profile session immediately and restores it without deleting the draft', async () => {
    const { practice, progress } = await freshStores();
    const ownerProfile = localProfileStore.current();
    const ownerKey = practiceSessionStorageKey(ownerProfile);
    await practice.startQuestions(['q3']);
    await practice.saveAnswerDraft('q3-a', {
      kind: 'open',
      text: 'erster Entwurf nur für Profil A',
      selfAssessment: {},
    });
    await practice.saveSelfAssessmentDraft('q3-a', {
      submission: { kind: 'open', text: 'nur für Profil A', selfAssessment: {} },
      assessment: { awardedPoints: 0, overall: 'none' },
      selectedPoints: 0,
      grading: 'baffled',
      indeterminate: false,
      indeterminateMax: 1,
    });

    await progress.activateUserProfile('profile-b');
    useAuthStore().session = {
      token: 'profile-b-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'profile-b', username: 'profile-b' },
    };

    expect(practice.sessionAccessible).toBe(false);
    expect(practice.current).toBeUndefined();
    expect(practice.currentReview).toBeUndefined();
    expect(practice.currentAnswerDraft).toBeUndefined();
    expect(practice.currentSelfAssessmentDraft).toBeUndefined();
    await expect(storage.get(STORAGE.app, ownerKey)).resolves.toMatchObject({
      items: [expect.objectContaining({
        answerDraft: expect.objectContaining({
          submission: expect.objectContaining({ text: 'erster Entwurf nur für Profil A' }),
        }),
      })],
      selfAssessmentDraft: { submission: { text: 'nur für Profil A' } },
    });

    await progress.activateGuestProfile();
    useAuthStore().session = undefined;

    expect(localProfileStore.current()).toBe(ownerProfile);
    expect(practice.sessionAccessible).toBe(true);
    expect(practice.current?.part.id).toBe('q3-a');
    expect(practice.currentAnswerDraft).toMatchObject({
      kind: 'open',
      text: 'erster Entwurf nur für Profil A',
    });
    expect(practice.currentSelfAssessmentDraft?.submission).toMatchObject({
      kind: 'open',
      text: 'nur für Profil A',
    });
  });

  it('finishes the profile-bound draft queued before another account becomes active', async () => {
    const { practice, progress } = await freshStores();
    const ownerProfile = localProfileStore.current();
    const ownerKey = practiceSessionStorageKey(ownerProfile);
    await practice.startQuestions(['q3']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (
        !paused
        && request.mutations.some((mutation) =>
          mutation.collection === STORAGE.app
          && mutation.operation === 'set'
          && JSON.stringify(mutation.value).includes('letzte Eingabe von A'))
      ) {
        paused = true;
        markEntered();
        await gate;
      }
      return commit(request);
    });

    const saving = practice.saveAnswerDraft('q3-a', {
      kind: 'open',
      text: 'letzte Eingabe von A',
      selfAssessment: {},
    });
    await entered;
    await progress.activateUserProfile('profile-b');
    useAuthStore().session = {
      token: 'profile-b-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'profile-b', username: 'profile-b' },
    };
    expect(practice.sessionAccessible).toBe(false);
    release();
    await expect(saving).resolves.toEqual({ status: 'saved' });
    expect(practice.current).toBeUndefined();

    await progress.activateGuestProfile();
    useAuthStore().session = undefined;
    expect(practice.sessionAccessible).toBe(true);
    expect(practice.currentAnswerDraft).toMatchObject({ text: 'letzte Eingabe von A' });
    await expect(storage.get(STORAGE.app, ownerKey)).resolves.toMatchObject({
      items: [expect.objectContaining({
        answerDraft: expect.objectContaining({
          submission: expect.objectContaining({ text: 'letzte Eingabe von A' }),
        }),
      })],
    });
  });

  it('lets an already queued draft survive view/store disposal and restore', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q3']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (
        !paused
        && request.mutations.some((mutation) =>
          mutation.collection === STORAGE.app
          && mutation.operation === 'set'
          && JSON.stringify(mutation.value).includes('überlebt den Unmount'))
      ) {
        paused = true;
        markEntered();
        await gate;
      }
      return commit(request);
    });

    const saving = practice.saveAnswerDraft('q3-a', {
      kind: 'open',
      text: 'überlebt den Unmount',
      selfAssessment: {},
    });
    await entered;
    practice.$dispose();
    release();
    await expect(saving).resolves.toEqual({ status: 'saved' });

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.currentAnswerDraft).toMatchObject({ text: 'überlebt den Unmount' });
  });

  it('coalesces a burst behind one in-flight draft and persists only the latest text', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q3']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => { markPaused = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    let draftCommits = 0;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      const writesDraft = request.mutations.some((mutation) =>
        mutation.collection === STORAGE.app
        && mutation.operation === 'set'
        && JSON.stringify(mutation.value).includes('Eingabe '));
      if (writesDraft) {
        draftCommits += 1;
        if (!held) {
          held = true;
          markPaused();
          await gate;
        }
      }
      return commit(request);
    });

    const saves = [practice.saveAnswerDraft('q3-a', {
      kind: 'open',
      text: 'Eingabe 0',
      selfAssessment: {},
    })];
    await paused;
    for (let index = 1; index <= 100; index += 1) {
      saves.push(practice.saveAnswerDraft('q3-a', {
        kind: 'open',
        text: `Eingabe ${index}`,
        selfAssessment: {},
      }));
    }
    release();
    const outcomes = await Promise.all(saves);

    expect(outcomes.every((outcome) => outcome.status === 'saved')).toBe(true);
    expect(draftCommits).toBeLessThanOrEqual(2);
    expect(practice.currentAnswerDraft).toMatchObject({ text: 'Eingabe 100' });
    await expect(storage.get(STORAGE.app, activeSessionKey())).resolves.toMatchObject({
      items: [expect.objectContaining({
        answerDraft: expect.objectContaining({
          submission: expect.objectContaining({ text: 'Eingabe 100' }),
        }),
      })],
    });
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

  it('advances an in-memory paused session after deliberately closing the review', async () => {
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
    await practice.closeCurrentReview();
    await practice.finishSession();

    await expect(practice.restoreSession()).resolves.toBe(true);
    expect(practice.graded.map((record) => record.partId)).toEqual(['q1-a']);
    expect(practice.current?.part.id).toBe('q2-a');
  });

  it('restores the original wrong result without exposing correction writers or duplicating progress', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const current = first.practice.current!;
    const firstRecord = await first.practice.recordGraded({
      part: current.part,
      submission: { kind: 'choice', selected: [1] },
      result: {
        verdict: 'incorrect',
        correct: false,
        awardedPoints: 0,
        maxPoints: 1,
      },
    });
    await first.practice.finishSession();

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);

    expect(restored.practice.phase).toBe('running');
    expect(restored.practice.current?.part.id).toBe('q1-a');
    expect(restored.practice.currentReview).toMatchObject({
      clientAttemptId: firstRecord?.clientAttemptId,
      result: { verdict: 'incorrect' },
    });
    expect(restored.practice.currentReview?.correctionOutcome).toBeUndefined();
    expect('recordCorrection' in restored.practice).toBe(false);
    expect('saveCorrectionDraft' in restored.practice).toBe(false);
    expect(restored.practice.summary).not.toHaveProperty('corrections');
    await restored.practice.completeReviewAndNext();
    expect(restored.practice.graded).toHaveLength(1);
    expect(restored.practice.graded[0]?.result.verdict).toBe('incorrect');
    expect(restored.practice.graded[0]?.correctionOutcome).toBeUndefined();
    expect(restored.practice.graded[0]?.correctionClosedAt).toBeUndefined();
    expect(restored.practice.current?.part.id).toBe('q2-a');
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
  });

  it('replaces the same durable review after reload without advancing FSRS twice', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const current = first.practice.current!;
    await first.practice.recordGraded({
      part: current.part,
      submission: { kind: 'choice', selected: [1] },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    expect((await archiveStore.load()).content.perPart[0]?.fsrs.reps).toBe(1);
    await first.practice.finishSession();

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.currentReview).toMatchObject({ gradingBaseCaptured: true });
    await restored.practice.overrideGrading('q1-a', 'good');

    const archive = await archiveStore.load();
    expect(archive.content.perPart[0]).toMatchObject({
      grading: 'good',
      fsrs: expect.objectContaining({ reps: 1 }),
    });
    expect(await historyLog.count()).toBe(1);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
  });

  it('never treats a legacy reviewed session without a captured FSRS base as the same review', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    await first.practice.recordGraded({
      part: first.practice.current!.part,
      submission: { kind: 'choice', selected: [1] },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    const key = activeSessionKey();
    const snapshot = await storage.get<Record<string, unknown> & { graded: Array<Record<string, unknown>> }>(
      STORAGE.app,
      key,
    );
    expect(snapshot).toBeDefined();
    await storage.set(STORAGE.app, key, {
      ...snapshot,
      version: 5,
      graded: snapshot!.graded.map(({ gradingBaseCaptured: _captured, preAnswerFsrs: _base, ...record }) => record),
    });

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    await expect(restored.practice.overrideGrading('q1-a', 'good')).rejects.toThrow(
      'ältere Bewertung',
    );
    expect((await archiveStore.load()).content.perPart[0]?.fsrs.reps).toBe(1);
    expect(await historyLog.count()).toBe(1);
  });

  it('preserves a legacy correction draft without replacing the original answer or reopening editing', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const record = await first.practice.recordGraded({
      part: first.practice.current!.part,
      submission: { kind: 'choice', selected: [1] },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    const key = activeSessionKey();
    const snapshot = (await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, key))!;
    const legacyDraft = { submission: { kind: 'choice' as const, selected: [0] }, savedAt: new Date().toISOString() };
    snapshot.graded[0]!.correctionDraft = legacyDraft;
    await storage.set(STORAGE.app, key, snapshot);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.currentReview?.correctionDraft?.submission).toEqual({
      kind: 'choice',
      selected: [0],
    });
    expect(restored.practice.currentReview).toMatchObject({
      clientAttemptId: record!.clientAttemptId,
      result: { verdict: 'incorrect' },
      pendingSubmission: { kind: 'choice', selected: [1] },
    });
    await restored.practice.completeReviewAndNext();
    await restored.practice.finishSession();
    const durable = await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, key);
    expect(durable?.graded[0]?.correctionDraft).toEqual(legacyDraft);
    expect(durable?.graded[0]?.pendingSubmission).toBeUndefined();
    expect(durable?.graded[0]?.reviewClosedAt).toBeDefined();
    expect(durable?.graded[0]?.correctionClosedAt).toBeUndefined();
    expect(await historyLog.count()).toBe(1);
    expect((await archiveStore.load()).content.perPart[0]?.fsrs.reps).toBe(1);
  });

  it('does not resurrect a closed result review or its answer from another window', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    await useProgressStore().init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);
    await first.recordGraded({
      part: first.current!.part,
      submission: { kind: 'choice', selected: [1] },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    await useProgressStore().init();
    const second = usePracticeStore();
    await second.restoreSession();
    expect(second.currentReview?.pendingSubmission).toBeDefined();

    setActivePinia(firstPinia);
    await first.closeCurrentReview();
    setActivePinia(secondPinia);
    await second.finishSession();
    const durable = await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, activeSessionKey());
    expect(durable?.graded[0]?.pendingSubmission).toBeUndefined();
    expect(durable?.graded[0]?.reviewClosedAt).toBeDefined();
    expect(durable?.graded[0]?.correctionClosedAt).toBeUndefined();

    const restored = await freshStores();
    await restored.practice.restoreSession();
    expect(restored.practice.current?.part.id).toBe('q2-a');
    expect(restored.practice.graded).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect((await archiveStore.load()).content.perPart[0]?.fsrs.reps).toBe(1);
  });

  it.each(['before-write', 'after-write'] as const)('handles review close failure %s without assuming an old grade proves the close', async (failure) => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.recordGraded({
      part: practice.current!.part,
      submission: { kind: 'choice', selected: [1] },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementationOnce(async (request) => {
      if (failure === 'after-write') await commit(request);
      throw new Error('local write interrupted');
    });
    if (failure === 'before-write') {
      await expect(practice.completeReviewAndNext()).rejects.toThrow('local write interrupted');
      expect(practice.current?.part.id).toBe('q1-a');
      expect(practice.currentReview?.pendingSubmission).toBeDefined();
      expect(practice.currentReview?.reviewClosedAt).toBeUndefined();
    } else {
      await expect(practice.completeReviewAndNext()).resolves.toBeUndefined();
      expect(practice.current?.part.id).toBe('q2-a');
      expect(practice.graded[0]?.pendingSubmission).toBeUndefined();
      expect(practice.graded[0]?.reviewClosedAt).toBeDefined();
    }
    await practice.finishSession();
    const durable = await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, activeSessionKey());
    expect(Boolean(durable?.graded[0]?.reviewClosedAt)).toBe(failure === 'after-write');
    expect(await historyLog.count()).toBe(1);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
  });

  it('uses the merged closed-review marker when another window closes during restoration', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    await useProgressStore().init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);
    await first.recordGraded({
      part: first.current!.part,
      submission: { kind: 'choice', selected: [1] },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    await useProgressStore().init();
    const second = usePracticeStore();
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => { markPaused = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (!held && request.mutations.some((mutation) =>
        mutation.collection === STORAGE.app && mutation.operation === 'set'
        && mutation.key === activeSessionKey())) {
        held = true;
        markPaused();
        await gate;
      }
      return commit(request);
    });
    const restoring = second.restoreSession();
    await paused;
    setActivePinia(firstPinia);
    await first.closeCurrentReview();
    setActivePinia(secondPinia);
    release();
    await expect(restoring).resolves.toBe(true);
    expect(second.current?.part.id).toBe('q2-a');
    expect(second.graded[0]?.reviewClosedAt).toBeDefined();
    expect(second.graded[0]?.pendingSubmission).toBeUndefined();
    expect(await historyLog.count()).toBe(1);
  });

  it('preserves legacy correction outcomes and timestamps on session restoration', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.recordGraded({
      part: practice.current!.part,
      submission: { kind: 'choice', selected: [1] },
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    const key = activeSessionKey();
    const snapshot = (await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, key))!;
    const legacy = {
      ...snapshot.graded[0]!,
      correctionOutcome: 'correct' as const,
      correctedAt: new Date().toISOString(),
      correctionDraft: { submission: { kind: 'choice' as const, selected: [0] }, savedAt: new Date().toISOString() },
    };
    snapshot.graded[0] = legacy;
    await storage.set(STORAGE.app, key, snapshot);
    const restored = await freshStores();
    await restored.practice.restoreSession();
    expect(restored.practice.currentReview).toEqual(legacy);
    expect(restored.practice.summary.points).toBe(0);
    expect(restored.practice.summary).not.toHaveProperty('corrections');
    expect((await storage.get<{ graded: GradedRecord[] }>(STORAGE.app, key))?.graded[0]).toEqual(legacy);
  });

  it('keeps a pre-answer grading as a declaration until the answer consumes it atomically', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await expect(practice.savePendingGrading('q1-a', 'meh')).resolves.toBe(true);
    practice.jumpTo(1);
    practice.jumpTo(0);
    expect(practice.currentPendingGrading).toBe('meh');

    await practice.recordGraded({
      part: practice.current!.part,
      submission: { kind: 'choice', selected: [0] },
      result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
      manualGrading: practice.currentPendingGrading ?? undefined,
    });

    expect((await archiveStore.load()).content.perPart[0]).toMatchObject({
      grading: 'meh',
      fsrs: expect.objectContaining({ reps: 1 }),
    });
    expect(await historyLog.count()).toBe(1);
    await expect(storage.get(STORAGE.app, activeSessionKey())).resolves.toMatchObject({
      items: [expect.objectContaining({
        pendingGrading: expect.objectContaining({ grading: null }),
      }), expect.anything()],
    });
  });

  it('does not resurrect a stale pending grading after another window graded the part', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    await useProgressStore().init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    await useProgressStore().init();
    const second = usePracticeStore();
    await second.restoreSession();

    setActivePinia(firstPinia);
    await gradeCurrent(first);
    setActivePinia(secondPinia);
    await expect(second.savePendingGrading('q1-a', 'meh')).resolves.toBe(false);

    const durable = await storage.get<{ items: SessionItem[] }>(STORAGE.app, activeSessionKey());
    expect(durable?.items[0]?.pendingGrading?.grading).toBeNull();
    const restored = await freshStores();
    await restored.practice.restoreSession();
    expect(restored.practice.currentPendingGrading).toBeNull();
    expect((await archiveStore.load()).content.perPart[0]?.fsrs.reps).toBe(1);
  });

  it('retains legacy correction evidence without using it to change the first result or navigation', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const current = first.practice.current!;
    const record = await first.practice.recordGraded({
      part: current.part,
      submission: { kind: 'choice', selected: [1] },
      result: {
        verdict: 'incorrect',
        correct: false,
        awardedPoints: 0,
        maxPoints: 1,
      },
    });
    const key = learningEventStorageKey(localProfileStore.current());
    const document = (await storage.get<{ rows: Array<{ event: LearningEvent }> }>(STORAGE.learning, key))!;
    document.rows[0]!.event.correctionOutcome = 'correct';
    await storage.set(STORAGE.learning, key, document);
    const before = await atomicStorage.readBatch([{ collection: STORAGE.learning, key }]);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);
    expect(restored.practice.current?.part.id).toBe('q1-a');
    expect(restored.practice.graded[0]).toMatchObject({
      clientAttemptId: record?.clientAttemptId,
      result: { verdict: 'incorrect' },
    });
    expect(restored.practice.graded[0]?.correctionOutcome).toBeUndefined();
    expect(await atomicStorage.readBatch([{ collection: STORAGE.learning, key }])).toEqual(before);
  });

  it('removes the durable snapshot only when a session is deliberately aborted', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    first.practice.abort();

    await vi.waitFor(async () => {
      expect(await storage.get(STORAGE.app, activeSessionKey())).toBeUndefined();
    });
    const restored = await freshStores();

    await expect(restored.practice.restoreSession()).resolves.toBe(false);
    expect(restored.practice.phase).toBe('idle');
  });

  it.each([
    { label: 'v2', version: 2, dropOwner: true, dropSource: true },
    { label: 'v3', version: 3, dropOwner: false, dropSource: true },
    { label: 'incomplete v4', version: 4, dropOwner: false, dropSource: false },
  ])('keeps a $label snapshot untouched and contacts no Core before explicit consent', async ({
    version,
    dropOwner,
    dropSource,
  }) => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const key = activeSessionKey();
    const saved = await storage.get<Record<string, unknown>>(STORAGE.app, key);
    expect(saved).toBeDefined();
    const legacy: Record<string, unknown> = { ...(saved ?? {}), version };
    delete legacy.contentId;
    if (dropOwner) delete legacy.owner;
    if (dropSource) delete legacy.contentSource;
    await storage.set(STORAGE.app, key, legacy);

    const getEndpoint = vi.fn(async () => ({
      baseUrl: 'http://core.must-not-be-contacted.test',
      source: 'local' as const,
      contentId: TEST_COMMIT,
    }));
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint,
    } satisfies CoreRuntimePort;
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('must not fetch')));
    vi.stubGlobal('fetch', fetchSpy);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);

    expect(restored.practice.phase).toBe('provenance-choice');
    expect(getEndpoint).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(storage.get(STORAGE.app, key)).resolves.toMatchObject({
      ...legacy,
      version: 6,
      owner: expect.objectContaining({ localProfileId: localProfileStore.current() }),
    });
  });

  it('upgrades an unprovenanced snapshot only after choosing the current bank', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const key = activeSessionKey();
    const saved = await storage.get<Record<string, unknown>>(STORAGE.app, key);
    expect(saved).toBeDefined();
    const legacy: Record<string, unknown> = { ...(saved ?? {}), version: 3 };
    delete legacy.contentSource;
    delete legacy.contentId;
    await storage.set(STORAGE.app, key, legacy);

    const getEndpoint = vi.fn(async () => ({
      baseUrl: 'http://core.current-choice.test',
      source: 'local' as const,
      contentId: TEST_COMMIT,
    }));
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint,
    } satisfies CoreRuntimePort;
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('offline')));
    vi.stubGlobal('fetch', fetchSpy);

    const restored = await freshStores();
    useAppStore().coreEndpointSource = 'local';
    await restored.practice.restoreSession();
    expect(restored.practice.phase).toBe('provenance-choice');

    await restored.practice.resumeWithCurrentContent();

    expect(restored.practice.phase).toBe('running');
    expect(restored.practice.items.map((item) => item.questionId)).toEqual(['q1', 'q2']);
    expect(getEndpoint).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(storage.get(STORAGE.app, key)).resolves.toMatchObject({
      version: 6,
      contentSource: 'local',
      contentId: TEST_COMMIT,
    });
  });

  it('exposes none of outbox, archive, history, session or memory when the atomic batch fails', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (request.mutations.some(
        (mutation) => mutation.collection === STORAGE.app
          && mutation.key === activeSessionKey(),
      )) {
        throw new Error('simulated disk failure');
      }
      return commit(request);
    });

    await expect(gradeCurrent(practice)).rejects.toThrow('simulated disk failure');

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect((await archiveStore.load()).content.perPart).toHaveLength(0);
    expect(await historyLog.count()).toBe(0);
    expect((await guestSession())?.graded).toEqual([]);
    expect(practice.graded).toEqual([]);
  });

  it('retries a CAS conflict, publishes the grade batch, then records learning evidence', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    const commitSpy = vi.spyOn(atomicStorage, 'commitBatch')
      .mockResolvedValueOnce({ committed: false })
      .mockImplementation(commit);

    await expect(gradeCurrent(practice)).resolves.toBeUndefined();

    const [attempt] = await attemptOutbox.list(GUEST_ATTEMPT_OWNER);
    expect(attempt).toMatchObject({ questionId: 'q1', partId: 'q1-a', correct: true });
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect((await guestSession())?.graded).toEqual([
      expect.objectContaining({ clientAttemptId: attempt!.clientAttemptId }),
    ]);
    expect(practice.graded).toHaveLength(1);
    expect(commitSpy).toHaveBeenCalledTimes(3);
  });

  it('merges concurrent grades from two tabs into the same durable session', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    const firstProgress = useProgressStore();
    await firstProgress.init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    const secondProgress = useProgressStore();
    await secondProgress.init();
    const second = usePracticeStore();
    await second.restoreSession();
    second.jumpTo(1);
    await vi.waitFor(async () => {
      expect(await guestSession()).toMatchObject({ index: 1 });
    });

    setActivePinia(firstPinia);
    const firstGrade = gradeCurrent(first);
    setActivePinia(secondPinia);
    const secondGrade = gradeCurrent(second);
    await Promise.all([firstGrade, secondGrade]);

    const session = await guestSession();
    expect(new Set(session?.graded.map((record) => record.clientAttemptId)).size).toBe(2);
    expect(new Set(
      (await historyLog.list()).map((entry) => entry.clientAttemptId),
    ).size).toBe(2);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(2);
    expect((await archiveStore.load()).content.perPart.map((part) => part.partId).sort()).toEqual([
      'q1-a',
      'q2-a',
    ]);
  });

  it('does not let a stale cross-tab position save erase a committed grade', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    const firstProgress = useProgressStore();
    await firstProgress.init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    const secondProgress = useProgressStore();
    await secondProgress.init();
    const second = usePracticeStore();
    await second.restoreSession();

    const originalCommit = atomicStorage.commitBatch.bind(atomicStorage);
    let releasePosition!: () => void;
    const positionGate = new Promise<void>((resolve) => { releasePosition = resolve; });
    let positionEntered!: () => void;
    const entered = new Promise<void>((resolve) => { positionEntered = resolve; });
    let delayed = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      const sessionMutation = request.mutations.find(
        (mutation) => mutation.collection === STORAGE.app
          && mutation.key === activeSessionKey(),
      );
      const position = sessionMutation?.operation === 'set'
        && typeof sessionMutation.value === 'object'
        && sessionMutation.value !== null
        ? (sessionMutation.value as { index?: unknown }).index
        : undefined;
      if (!delayed && request.mutations.length === 1 && position === 1) {
        delayed = true;
        positionEntered();
        await positionGate;
      }
      return originalCommit(request);
    });

    setActivePinia(secondPinia);
    second.jumpTo(1);
    await entered;
    setActivePinia(firstPinia);
    await gradeCurrent(first);
    releasePosition();

    await vi.waitFor(async () => {
      expect(await guestSession()).toMatchObject({
        index: 1,
        graded: [expect.objectContaining({ clientAttemptId: expect.any(String) })],
      });
    });
    expect(await historyLog.count()).toBe(1);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
  });

  it('reloads durable markers when COMMIT succeeds but its IPC response is lost', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementationOnce(async (request) => {
      await commit(request);
      throw new Error('simulated IPC response loss');
    });

    await expect(gradeCurrent(practice)).resolves.toBeUndefined();

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect((await guestSession())?.graded).toHaveLength(1);
    expect(practice.graded).toHaveLength(1);
  });

  it('keeps one idempotent, claimable attempt after the session commits but before flushing', async () => {
    const { practice, progress } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    vi.spyOn(progress, 'flushStagedAttempt').mockRejectedValueOnce(new Error('crash after session'));

    // Network upload is deliberately background work: the durable local
    // commit must not hold the answer UI hostage to a dead server.
    await expect(gradeCurrent(practice)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(progress.flushStagedAttempt).toHaveBeenCalledTimes(1));

    const [attempt] = await attemptOutbox.list(GUEST_ATTEMPT_OWNER);
    expect(attempt).toMatchObject({
      contentSource: 'local',
      contentId: TEST_COMMIT,
    });
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

  it('retries against a concurrent guest claim and keeps its session key fixed', async () => {
    const { practice } = await freshStores();
    const guestKey = practiceSessionStorageKey(localProfileStore.current());
    await practice.startQuestions(['q1', 'q2']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let raced = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (!raced) {
        raced = true;
        await expect(localProfileStore.claimGuestForUser('claimed-user')).resolves.toMatchObject({
          activeProfileId: 'user:claimed-user',
        });
        useAuthStore().session = {
          token: 'claimed-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'claimed-user', username: 'claimed' },
        };
      }
      return commit(request);
    });

    await gradeCurrent(practice);

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count('claimed-user')).toBe(1);
    const guestSnapshot = await storage.get<{
      owner?: { userId?: string };
      graded?: unknown[];
    }>(STORAGE.app, guestKey);
    expect(guestSnapshot?.owner).toMatchObject({ userId: GUEST_ATTEMPT_OWNER });
    expect(guestSnapshot?.graded).toHaveLength(1);
    await expect(
      storage.get(STORAGE.app, practiceSessionStorageKey('user:claimed-user')),
    ).resolves.toBeUndefined();
  });

  it('restores an explicitly claimed guest session for only its destination account', async () => {
    const first = await freshStores();
    const guestProfile = localProfileStore.current();
    const guestKey = practiceSessionStorageKey(guestProfile);
    await first.practice.startQuestions(['q1', 'q2']);

    await first.progress.beginGuestAttemptClaim('created-account');
    await first.progress.claimGuestProfile('created-account');
    await first.progress.recoverGuestAttemptClaim('created-account');

    const destination = await freshStores();
    useAuthStore().session = {
      token: 'created-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'created-account', username: 'created' },
    };
    await expect(destination.practice.restoreSession()).resolves.toBe(true);
    expect(destination.practice.items.map((item) => item.questionId)).toEqual(['q1', 'q2']);
    await expect(storage.get(STORAGE.app, guestKey)).resolves.toMatchObject({
      owner: expect.objectContaining({
        userId: GUEST_ATTEMPT_OWNER,
        localProfileId: guestProfile,
      }),
    });
    await expect(
      storage.get(STORAGE.app, practiceSessionStorageKey('user:created-account')),
    ).resolves.toBeUndefined();

    // Continuing the restored programme resolves its old guest generation to
    // the account that explicitly claimed it.
    await gradeCurrent(destination.practice);
    expect(await attemptOutbox.count('created-account')).toBe(1);
  });

  it('rejects a claimed v5 guest session from a different guest generation', async () => {
    const first = await freshStores();
    const guestProfile = localProfileStore.current();
    const guestKey = practiceSessionStorageKey(guestProfile);
    await first.practice.startQuestions(['q1', 'q2']);
    const snapshot = await storage.get<Record<string, unknown>>(STORAGE.app, guestKey);
    expect(snapshot).toBeDefined();

    await first.progress.beginGuestAttemptClaim('generation-owner');
    await first.progress.claimGuestProfile('generation-owner');
    await first.progress.recoverGuestAttemptClaim('generation-owner');
    await storage.set(STORAGE.app, guestKey, {
      ...snapshot,
      owner: {
        ...((snapshot?.owner ?? {}) as Record<string, unknown>),
        guestGeneration: 'different-generation',
      },
    });

    const destination = await freshStores();
    await destination.progress.activateUserProfile('generation-owner');
    useAuthStore().session = {
      token: 'generation-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'generation-owner', username: 'generation' },
    };
    await expect(destination.practice.restoreSession()).resolves.toBe(false);
  });

  it('recovers and safely scopes a pre-2.2 guest session after a registration crash', async () => {
    const first = await freshStores();
    const sourceProfile = localProfileStore.current();
    const scopedSourceKey = practiceSessionStorageKey(sourceProfile);
    await first.practice.startQuestions(['q1', 'q2']);
    const snapshot = await storage.get<Record<string, unknown>>(STORAGE.app, scopedSourceKey);
    expect(snapshot).toBeDefined();
    const legacyOwner = { ...((snapshot?.owner ?? {}) as Record<string, unknown>) };
    delete legacyOwner.localProfileId;
    await storage.set(STORAGE.app, 'practice-session:guest', {
      ...snapshot,
      version: 4,
      owner: legacyOwner,
    });
    await storage.delete(STORAGE.app, scopedSourceKey);

    await first.progress.beginGuestAttemptClaim(
      accountStorageIdentity(DEFAULT_CONFIG.serverBaseUrl, 'crash-account'),
    );
    await authStorage.setSession({
      token: 'crash-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'crash-account', username: 'crash' },
      serverBaseUrl: DEFAULT_CONFIG.serverBaseUrl,
    });

    // Restart after the auth write but before profile/outbox claim completion.
    setActivePinia(createPinia());
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'crash-account', username: 'crash' })));
    const restartedAuth = useAuthStore();
    await restartedAuth.init();
    const restartedPractice = usePracticeStore();
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let migrationReplyLost = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      const migratesLegacy = request.mutations.some(
        (mutation) => mutation.collection === STORAGE.app
          && mutation.key === 'practice-session:guest'
          && mutation.operation === 'delete',
      );
      if (migratesLegacy && !migrationReplyLost) {
        migrationReplyLost = true;
        await commit(request);
        throw new Error('simulated migration response loss');
      }
      return commit(request);
    });

    await expect(restartedPractice.restoreSession()).resolves.toBe(true);
    expect(migrationReplyLost).toBe(true);
    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toBeUndefined();
    await expect(storage.get(STORAGE.app, scopedSourceKey)).resolves.toMatchObject({
      version: 6,
      owner: expect.objectContaining({ localProfileId: sourceProfile }),
    });
  });

  it('keeps the rotated guest separate from the session claimed by an account', async () => {
    const first = await freshStores();
    const claimedGuestProfile = localProfileStore.current();
    const claimedKey = practiceSessionStorageKey(claimedGuestProfile);
    await first.practice.startQuestions(['q1', 'q2']);
    await first.progress.beginGuestAttemptClaim('owner-account');
    await first.progress.claimGuestProfile('owner-account');
    await first.progress.recoverGuestAttemptClaim('owner-account');

    useAuthStore().session = undefined;
    await first.progress.activateGuestProfile();
    const rotatedGuestProfile = localProfileStore.current();
    expect(rotatedGuestProfile).not.toBe(claimedGuestProfile);

    const nextGuest = await freshStores();
    useAuthStore().session = undefined;
    await expect(nextGuest.practice.restoreSession()).resolves.toBe(false);
    await nextGuest.practice.startQuestions(['q2']);

    await expect(storage.get(STORAGE.app, claimedKey)).resolves.toBeDefined();
    await expect(
      storage.get(STORAGE.app, practiceSessionStorageKey(rotatedGuestProfile)),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ questionId: 'q2' })],
      owner: expect.objectContaining({ localProfileId: rotatedGuestProfile }),
    });
  });

  it('does not give an ownerless v2 guest session to a later guest generation', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const scopedKey = activeSessionKey();
    const saved = await storage.get<Record<string, unknown>>(STORAGE.app, scopedKey);
    const legacy: Record<string, unknown> = { ...(saved ?? {}), version: 2 };
    delete legacy.owner;
    await storage.set(STORAGE.app, 'practice-session:guest', legacy);
    await storage.delete(STORAGE.app, scopedKey);

    await first.progress.beginGuestAttemptClaim('claimed-account');
    useAuthStore().session = undefined;
    await first.progress.activateGuestProfile();

    const laterGuest = await freshStores();
    useAuthStore().session = undefined;
    await expect(laterGuest.practice.restoreSession()).resolves.toBe(false);
    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toEqual(legacy);
  });

  it('keeps practice sessions isolated while switching between existing accounts', async () => {
    const first = await freshStores();
    await first.progress.activateUserProfile('account-a');
    useAuthStore().session = {
      token: 'token-a',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'account-a', username: 'a' },
    };
    await first.practice.startQuestions(['q1']);
    const accountAKey = practiceSessionStorageKey('user:account-a');

    await first.progress.activateUserProfile('account-b');
    useAuthStore().session = {
      token: 'token-b',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'account-b', username: 'b' },
    };
    expect(first.practice.sessionAccessible).toBe(false);
    expect(first.practice.current).toBeUndefined();
    first.practice.abort();
    await expect(storage.get(STORAGE.app, accountAKey)).resolves.toBeDefined();
    const second = await freshStores();
    useAuthStore().session = {
      token: 'token-b',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'account-b', username: 'b' },
    };
    await expect(second.practice.restoreSession()).resolves.toBe(false);
    await second.practice.startQuestions(['q2']);
    const accountBKey = practiceSessionStorageKey('user:account-b');

    await second.progress.activateUserProfile('account-a');
    const restoredA = await freshStores();
    useAuthStore().session = {
      token: 'token-a',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'account-a', username: 'a' },
    };
    await expect(restoredA.practice.restoreSession()).resolves.toBe(true);
    expect(restoredA.practice.items.map((item) => item.questionId)).toEqual(['q1']);
    await expect(storage.get(STORAGE.app, accountAKey)).resolves.toBeDefined();
    await expect(storage.get(STORAGE.app, accountBKey)).resolves.toMatchObject({
      items: [expect.objectContaining({ questionId: 'q2' })],
    });
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
    await localProfileStore.initialize();
    await archiveStore.save(EMPTY_ARCHIVE);
    await seedImmutableOfflineQuestions([question('q1', 1), question('q2', 2)]);
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

    const key = activeSessionKey();
    const stale = await storage.get<Record<string, unknown>>(STORAGE.app, key);
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    await storage.set(STORAGE.app, key, {
      ...stale,
      origin: 'smart',
      savedAt: yesterday,
    });

    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession('smart')).resolves.toBe(false);
    expect(reloaded.practice.phase).toBe('idle');
    // …and the stale snapshot is cleared rather than left to be re-offered.
    await expect(
      storage.get(STORAGE.app, key),
    ).resolves.toBeUndefined();
  });

  it('still resumes a programme saved earlier the same day', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession();

    const key = activeSessionKey();
    const saved = await storage.get<Record<string, unknown>>(STORAGE.app, key);
    await storage.set(STORAGE.app, key, {
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

  it('pins the active Core source at the start action even if another window changes it', async () => {
    const { practice, progress } = await freshStores();
    const app = useAppStore();
    app.coreEndpointSource = 'local';
    const getEndpoint = vi.fn(async (source: 'local' | 'remote' = 'remote') => ({
      baseUrl: source === 'local' ? 'http://127.0.0.1:1122/__qed2_core/local' : 'https://core.example',
      source,
      ...(source === 'local' ? { contentId: TEST_COMMIT } : {}),
    }));
    ports.coreRuntime = {
      capabilities: { localCore: false },
      getEndpoint,
    } satisfies CoreRuntimePort;

    let captureEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      captureEntered = resolve;
    });
    let releaseCapture!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const originalCapture = progress.captureAttemptOwner.bind(progress);
    vi.spyOn(progress, 'captureAttemptOwner').mockImplementationOnce(async () => {
      captureEntered();
      await gate;
      return originalCapture();
    });

    const starting = practice.startQuestions(['q1']);
    await entered;
    app.coreEndpointSource = 'remote';
    releaseCapture();
    await starting;

    expect(getEndpoint).toHaveBeenCalledWith('local');
    expect(practice.contentSource).toBe('local');
    expect(practice.phase).toBe('running');
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

describe('practice content revision integrity', () => {
  const commitA = 'a'.repeat(40);
  const commitB = 'b'.repeat(40);

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
    ]);
    await localProfileStore.initialize();
    await archiveStore.save(EMPTY_ARCHIVE);
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async (source = 'remote') => ({
        baseUrl: 'http://core.integrity.test',
        source,
      }),
    } satisfies CoreRuntimePort;
  });

  function reply(body: unknown): object {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    };
  }

  function notFound(): object {
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Cannot GET route' } }),
    };
  }

  async function verifiedPng(contents: string): Promise<Response> {
    const bytes = new TextEncoder().encode(contents);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': 'image/png',
        etag: `"${hash}"`,
      },
    });
  }

  it('admits a batch only after its hashes and post-download revision agree', async () => {
    const q1 = question('q1', 1);
    const rawHash = '1'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: commitA, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('running');
    expect(practice.contentId).toBe(commitA);
    await expect(questionCache.get('q1', commitA)).resolves.toEqual(q1);
  });

  it('rejects and never caches a question whose manifest hash does not match', async () => {
    const expected = question('q1', 1);
    const tampered = { ...expected, title: 'manipuliert' };
    const rawHash = '2'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: commitA, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({
          questions: [{ ...tampered, contentHash: rawHash, wireHash: questionContentHash(expected) }],
          missing: [],
        });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('Übertragungs-Prüfsumme');
    expect(practice.questions.size).toBe(0);
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
    await expect(questionCache.get('q1')).resolves.toBeUndefined();
  });

  it('fails closed when the deployment changes between manifest and batch', async () => {
    const q1 = question('q1', 1);
    const rawHash = '3'.repeat(64);
    let manifestCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) {
        manifestCalls += 1;
        const commit = manifestCalls === 1 ? commitA : commitB;
        return reply({ commit, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('während des Ladens aktualisiert');
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
  });

  it('never admits a successful batch or legacy cache after the manifest request fails', async () => {
    const old = { ...question('q1', 1), title: 'legacy' };
    const fresh = { ...question('q1', 1), title: 'network' };
    const batchCalls = vi.fn();
    await questionCache.put(old);
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async () => ({
        baseUrl: 'http://core.integrity.test',
        source: 'remote',
        contentId: commitA,
      }),
    } satisfies CoreRuntimePort;
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) throw new TypeError('offline');
      if (path.endsWith('/content/questions/batch')) {
        batchCalls();
        return reply({ questions: [contentQuestion(fresh)], missing: [] });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('error');
    expect(practice.questions.size).toBe(0);
    expect(batchCalls).not.toHaveBeenCalled();
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
    await expect(questionCache.get('q1')).resolves.toEqual(old);
  });

  it('uses an atomic revision/raw-hash/wire-hash cache envelope on a later offline local start', async () => {
    const q1 = question('q1', 1);
    const rawHash = '4'.repeat(64);
    await questionCache.putManyVerified([
      { question: q1, contentHash: rawHash, wireHash: questionContentHash(q1) },
    ], commitA);
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async () => ({
        baseUrl: 'http://core.integrity.test',
        source: 'local',
        contentId: commitA,
      }),
    } satisfies CoreRuntimePort;
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'local', commitA);

    expect(practice.phase).toBe('running');
    expect(practice.current?.question).toEqual(q1);
  });

  it('pins remote figures to blobs before confirming the same deployment', async () => {
    const q1: Question = {
      ...question('q1', 1),
      prompt: [{ t: 'fig', src: 'assets/fig/q1.png', alt: 'q1' }],
    };
    const rawHash = '5'.repeat(64);
    let deployment = commitA;
    const assetFetches: string[] = [];
    stubObjectUrls('blob:q1-commit-a');
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: deployment, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      if (path === `/content/revisions/${commitA}/assets/fig/q1.png`) {
        assetFetches.push(deployment);
        return verifiedPng(`image-${deployment}`);
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');
    deployment = commitB;

    expect(practice.phase).toBe('running');
    expect(assetFetches).toEqual([commitA]);
    expect(practice.assetUrl('assets/fig/q1.png')).toBe('blob:q1-commit-a');
  });

  it('rejects an asset snapshot when the deployment switches during its download', async () => {
    const q1: Question = {
      ...question('q1', 1),
      prompt: [{ t: 'fig', src: 'assets/fig/q1.png' }],
    };
    const rawHash = '6'.repeat(64);
    let deployment = commitA;
    const { createObjectURL } = stubObjectUrls();
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: deployment, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      if (path === `/content/revisions/${commitA}/assets/fig/q1.png`) {
        deployment = commitB;
        return verifiedPng('new-deployment-image');
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('während des Ladens aktualisiert');
    expect(createObjectURL).not.toHaveBeenCalled();
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
  });

  it('restores an old question and figure through the immutable revision API', async () => {
    const oldQuestion: Question = {
      ...question('q1', 1),
      title: 'Historische Aufgabe',
      prompt: [{ t: 'fig', src: 'assets/fig/old.png', alt: 'historisch' }],
    };
    const oldRawHash = '9'.repeat(64);
    const liveBatch = vi.fn();
    const { createObjectURL } = stubObjectUrls('blob:historical-asset');
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path === '/content/manifest/v2') return notFound();
      if (path === '/content/manifest') {
        return reply({ commit: commitB, items: { q1: '8'.repeat(64) } });
      }
      if (path === `/content/revisions/${commitA}/manifest`) {
        return reply({ commit: commitA, items: { q1: oldRawHash } });
      }
      if (path === `/content/revisions/${commitA}/questions/batch`) {
        return reply({ questions: [contentQuestion(oldQuestion, oldRawHash)], missing: [] });
      }
      if (path === `/content/revisions/${commitA}/assets/fig/old.png`) {
        return verifiedPng('old-image');
      }
      if (path === '/content/questions/batch') liveBatch();
      throw new Error(`unexpected request ${path}`);
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote', commitA);

    expect(practice.phase).toBe('running');
    expect(practice.contentId).toBe(commitA);
    expect(practice.contentMode).toBe('revision');
    expect(practice.current?.question.title).toBe('Historische Aufgabe');
    expect(practice.assetUrl('assets/fig/old.png')).toBe('blob:historical-asset');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(liveBatch).not.toHaveBeenCalled();
    await expect(questionCache.getVerified('q1', commitA, oldRawHash)).resolves.toEqual(oldQuestion);
    await expect(questionCache.get('q1')).resolves.toBeUndefined();
  });

  it('does not resume a revision-pinned remote bank when that revision cannot be confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    setActivePinia(createPinia());
    const app = useAppStore();

    await expect(app.pinCoreContent('remote', commitA)).rejects.toThrow(
      'ursprüngliche Version dieser Aufgaben ist nicht verfügbar',
    );
  });

  it('moves an already-running remote session to a fail-closed error when restore goes offline', async () => {
    const q1 = question('q1', 1);
    const rawHash = '7'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) return reply({ commit: commitA, items: { q1: rawHash } });
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));
    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');
    expect(practice.phase).toBe('running');

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await expect(practice.restoreSession()).resolves.toBe(true);

    expect(practice.phase).toBe('error');
    expect(practice.questions.size).toBe(0);
    expect(practice.error).toContain('ursprüngliche Version dieser Aufgaben');
  });

  it('backfills the first confirmed commit so retry cannot drift to a newer deployment', async () => {
    const q1 = question('q1', 1);
    const rawHash = '8'.repeat(64);
    let deployment = commitA;
    let batchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest/v2')) return notFound();
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: deployment, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        batchCalls += 1;
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));
    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');
    expect(practice.phase).toBe('running');
    expect(practice.contentId).toBe(commitA);

    deployment = commitB;
    await practice.retry();

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('ursprüngliche Version dieser Aufgaben');
    expect(batchCalls).toBe(1);
  });
});

describe('desktop practice window isolation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
    ]);
    await localProfileStore.initialize();
    await archiveStore.save(EMPTY_ARCHIVE);
    await seedImmutableOfflineQuestions([question('q1', 1), question('q2', 2)]);
  });

  it('keeps main and native-practice snapshots in independent durable keys', async () => {
    ports.shell = desktopShell('main');
    const main = await freshStores();
    await main.practice.startQuestions(['q1', 'q2']);

    ports.shell = desktopShell('practice');
    const native = await freshStores();
    await native.practice.startQuestions(['q2']);

    expect(await storage.get<{ items: SessionItem[] }>(STORAGE.app, activeSessionKey('main')))
      .toMatchObject({ items: [expect.objectContaining({ questionId: 'q1' }), expect.objectContaining({ questionId: 'q2' })] });
    expect(await storage.get<{ items: SessionItem[] }>(STORAGE.app, activeSessionKey('practice')))
      .toMatchObject({ items: [expect.objectContaining({ questionId: 'q2' })] });
    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toBeUndefined();
  });

  it('atomically migrates a pre-upgrade snapshot into the first Desktop window', async () => {
    ports.shell = originalShell;
    const oldWebSession = await freshStores();
    await oldWebSession.practice.startQuestions(['q1', 'q2']);
    const scopedWebKey = activeSessionKey();
    const oldSnapshot = await storage.get(STORAGE.app, scopedWebKey);
    expect(oldSnapshot).toBeDefined();
    await storage.set(STORAGE.app, 'practice-session:guest', oldSnapshot);
    await storage.delete(STORAGE.app, scopedWebKey);

    ports.shell = desktopShell('practice');
    const desktop = await freshStores();
    await expect(desktop.practice.restoreSession()).resolves.toBe(true);

    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toBeUndefined();
    await expect(storage.get(STORAGE.app, activeSessionKey('practice'))).resolves.toBeDefined();
  });
});
