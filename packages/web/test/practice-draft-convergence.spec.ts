import 'fake-indexeddb/auto';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@qed2/core-logic';
import PracticeView from '../src/routes/PracticeView.vue';
import { usePracticeStore, type GradedRecord } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

const question: Question = {
  id: 'q1',
  schemaVersion: 3,
  status: 'reviewed',
  lang: 'de',
  source: {
    suite: 'srdp',
    year: 2026,
    term: 'haupttermin',
    part: 't1',
    nr: 1,
    file: 'q1.yaml',
  },
  title: 'Fensterkonflikt',
  playable: true,
  parts: [{
    id: 'q1-a',
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

const winner: GradedRecord = {
  clientAttemptId: '3b241101-e2bb-4255-8caf-4136c566a962',
  questionId: 'q1',
  partId: 'q1-a',
  reason: 'manual',
  result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
  gradedAt: '2026-08-24T08:00:00.000Z',
  elapsedMs: 1000,
};

const openQuestion: Question = {
  ...question,
  id: 'q-open',
  title: 'Papierlösung',
  parts: [{
    ...question.parts[0]!,
    id: 'q-open-a',
    answer: {
      kind: 'open',
      rubric: [{ t: 'text', v: 'Ansatz und Ergebnis vergleichen.' }],
      grader: 'self',
    },
    solution: [{ result: [{ t: 'math', v: 'x=3' }], figures: [] }],
  }],
};

describe('practice draft winner convergence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows the review saved by another window instead of a permanent draft retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    const pinia = createPinia();
    setActivePinia(pinia);
    await useProgressStore().init();
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
    const save = vi.spyOn(practice, 'saveAnswerDraft').mockImplementation(async () => {
      practice.$patch({ graded: [winner] });
      return { status: 'superseded-by-grade', record: winner };
    });
    practice.$patch({
      phase: 'running',
      items: [{
        questionId: question.id,
        partId: question.parts[0]!.id,
        reason: 'manual',
        clientAttemptId: winner.clientAttemptId,
      }],
      questions: new Map([[question.id, question]]),
      index: 0,
      graded: [],
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/practice', component: PracticeView },
        { path: '/', component: { template: '<div />' } },
      ],
    });
    await router.push('/practice');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({ render: () => h(RouterView) });
    app.use(pinia);
    app.use(router);
    app.mount(host);
    await nextTick();
    const answer = host.querySelector<HTMLButtonElement>('button.q-choice__opt');
    expect(answer).not.toBeNull();
    answer!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    await nextTick();
    await nextTick();

    expect(host.textContent).toContain('anderen Fenster');
    expect(host.textContent).not.toContain('Speichern wiederholen');
    expect(practice.currentReview).toMatchObject({ result: { verdict: 'correct' } });
    app.unmount();
  });

  it('opens the submitted solution at default height and preserves manual expansion while scoring', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    const pinia = createPinia();
    setActivePinia(pinia);
    await useProgressStore().init();
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
    const save = vi.spyOn(practice, 'saveSelfAssessmentDraft').mockResolvedValue(true);
    const grade = vi.spyOn(practice, 'recordGraded').mockResolvedValue(undefined);
    let now = Date.now();
    // Keep synthetic clicks newer than Vue's freshly mounted listener stamps.
    vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    practice.$patch({
      phase: 'running',
      items: [{
        questionId: openQuestion.id,
        partId: openQuestion.parts[0]!.id,
        reason: 'manual',
        clientAttemptId: '5dd4e83e-e4a4-4d49-b108-87727b1f645c',
      }],
      questions: new Map([[openQuestion.id, openQuestion]]),
      index: 0,
      graded: [],
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/practice', component: PracticeView },
        { path: '/', component: { template: '<div />' } },
      ],
    });
    await router.push('/practice');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({ render: () => h(RouterView) });
    app.use(pinia);
    app.use(router);
    app.mount(host);
    await nextTick();
    expect(host.querySelector('.q-ssheet')?.getAttribute('aria-hidden')).toBe('true');
    const submit = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Prüfen');
    expect(submit).toBeDefined();
    submit!.click();

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(host.textContent).toContain('Offizieller Lösungsweg'));
    expect(save.mock.calls[0]?.[0]).toBe('q-open-a');
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      submission: { kind: 'open', text: '' },
    });
    expect(host.textContent).not.toContain('Speichert …');
    expect(host.querySelector('.q-ssheet')?.getAttribute('aria-hidden')).toBe('false');
    expect(host.querySelector('.practice-bar--full')).toBeNull();

    host.querySelector<HTMLButtonElement>('.q-ssheet__handle')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await nextTick();
    expect(host.querySelector('.practice-bar--full')).not.toBeNull();
    [...host.querySelectorAll<HTMLButtonElement>('.q-selfassess__segment')]
      .find((button) => button.textContent?.trim() === '1')!.click();
    await vi.waitFor(() => expect(host.querySelector('.q-selfassess__segment[aria-checked="true"]')?.textContent?.trim()).toBe('1'));
    let gradingButton: HTMLButtonElement | undefined;
    await vi.waitFor(() => {
      gradingButton = [...host.querySelectorAll<HTMLButtonElement>('.practice-review__mastery .q-gpick__opt')]
        .find((button) => button.querySelector('.q-gpick__label')?.textContent?.trim() === 'Gut');
      expect(gradingButton).toBeDefined();
      expect(gradingButton!.disabled).toBe(false);
    });
    gradingButton!.click();
    await vi.waitFor(() => expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ selectedPoints: 1, grading: 'good' }));
    expect(host.querySelector('.practice-bar--full')).not.toBeNull();
    expect(grade).not.toHaveBeenCalled();

    // Pass the primary button's accidental double-tap guard.
    now += 1000;
    let confirm: HTMLButtonElement | undefined;
    await vi.waitFor(() => {
      confirm = [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Bewertung übernehmen');
      expect(confirm).toBeDefined();
      expect(confirm!.disabled).toBe(false);
    });
    confirm!.click();
    await vi.waitFor(() => expect(grade).toHaveBeenCalledTimes(1));
    expect(grade.mock.calls[0]?.[0]).toMatchObject({
      part: { id: 'q-open-a' },
      result: { verdict: 'correct', awardedPoints: 1, maxPoints: 1 },
      submission: { kind: 'open', text: '', selfAssessment: { awardedPoints: 1 } },
      manualGrading: 'good',
    });
    await nextTick();
    expect(host.querySelector('.practice-bar--full')).toBeNull();
    expect(host.querySelector('.q-ssheet')?.getAttribute('aria-hidden')).toBe('false');
    expect(host.textContent).not.toContain('Der Versuch wurde nicht gespeichert.');
    app.unmount();
  });

  it.each(['draft', 'review'] as const)('restores a saved %s at default height without submitting it again', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    const pinia = createPinia();
    setActivePinia(pinia);
    await useProgressStore().init();
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
    const grade = vi.spyOn(practice, 'recordGraded');
    const save = vi.spyOn(practice, 'saveSelfAssessmentDraft');
    if (kind === 'draft') {
      vi.spyOn(practice, 'currentSelfAssessmentDraft', 'get').mockReturnValue({
        version: 1, revision: 1, partId: 'q-open-a', savedAt: new Date().toISOString(),
        submission: { kind: 'open', text: 'Gespeicherter Ansatz', selfAssessment: { awardedPoints: 1 } },
        assessment: { awardedPoints: 1 }, selectedPoints: 1, grading: 'good',
        indeterminate: false, indeterminateMax: 1,
      });
    }
    practice.$patch({
      phase: 'running',
      items: [{ questionId: openQuestion.id, partId: 'q-open-a', reason: 'manual', clientAttemptId: winner.clientAttemptId }],
      questions: new Map([[openQuestion.id, openQuestion]]), index: 0,
      graded: kind === 'review' ? [{ ...winner, partId: 'q-open-a', questionId: openQuestion.id,
        pendingSubmission: { kind: 'open', text: 'Gespeicherter Ansatz', selfAssessment: { awardedPoints: 1 } },
      }] : [],
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/practice', component: PracticeView }] });
    await router.push('/practice');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({ render: () => h(RouterView) }).use(pinia).use(router);
    app.mount(host);
    try {
      await vi.waitFor(() => expect(host.textContent).toContain('Offizieller Lösungsweg'));
      expect(host.querySelector('.q-ssheet')?.getAttribute('aria-hidden')).toBe('false');
      expect(host.querySelector('.practice-bar--full')).toBeNull();
      expect(grade).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      if (kind === 'draft') {
        expect(host.querySelector('.q-selfassess__segment[aria-checked="true"]')?.textContent?.trim()).toBe('1');
        expect(host.querySelector('.practice-review__mastery [aria-checked="true"] .q-gpick__label')?.textContent?.trim()).toBe('Gut');
      }
    } finally {
      app.unmount();
    }
  });

  it('starts a fresh player when a new interaction reuses the same part', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    const pinia = createPinia();
    setActivePinia(pinia);
    await useProgressStore().init();
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
    vi.spyOn(practice, 'saveSelfAssessmentDraft').mockResolvedValue(true);
    practice.$patch({
      phase: 'running',
      items: [{ questionId: openQuestion.id, partId: openQuestion.parts[0]!.id, reason: 'manual', learningInteractionId: '11111111-1111-4111-8111-111111111111' }],
      questions: new Map([[openQuestion.id, openQuestion]]), index: 0, graded: [],
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/practice', component: PracticeView }] });
    await router.push('/practice');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({ render: () => h(RouterView) }).use(pinia).use(router);
    app.mount(host);
    try {
      await nextTick();
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === 'Prüfen')!.click();
      await vi.waitFor(() => expect(host.textContent).toContain('Offizieller Lösungsweg'));
      expect(host.querySelector('.q-selfassess')).not.toBeNull();
      practice.items = [{ ...practice.items[0]!, learningInteractionId: '22222222-2222-4222-8222-222222222222' }];
      await nextTick();
      await nextTick();
      expect(host.querySelector('.q-selfassess')).toBeNull();
      expect(host.querySelector('.q-ssheet')?.getAttribute('aria-hidden')).toBe('true');
      expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).some(button => button.textContent?.trim() === 'Prüfen')).toBe(true);
      expect(host.textContent).not.toContain('Bewertung übernehmen');
    } finally {
      app.unmount();
    }
  });
});
