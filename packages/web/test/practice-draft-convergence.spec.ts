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

  it('persists the first self-assessment draft before revealing the solution', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    const pinia = createPinia();
    setActivePinia(pinia);
    await useProgressStore().init();
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
    const save = vi.spyOn(practice, 'saveSelfAssessmentDraft').mockResolvedValue(true);
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
    app.unmount();
  });
});
