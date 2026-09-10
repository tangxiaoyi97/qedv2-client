import 'fake-indexeddb/auto';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@qed2/core-logic';
import PracticeView from '../src/routes/PracticeView.vue';
import { usePracticeStore } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

function question(id: string): Question {
  return {
    id, schemaVersion: 3, status: 'reviewed', lang: 'de', title: `Question ${id}`, playable: true,
    source: { suite: 'srdp', year: 2026, term: 'haupttermin', part: 't1', nr: 1, file: `${id}.pdf` },
    parts: [{
      id: `${id}-a`, label: 'a', competencies: [{ code: 'AG 1.1' }], points: 1,
      scoring: { mode: 'allOrNothing', points: 1 },
      answer: { kind: 'choice', options: [[{ t: 'text', v: 'Ja' }], [{ t: 'text', v: 'Nein' }]], correct: [0], selectCount: 1 },
    }],
  };
}

function publishQuestions(ids: string[]): void {
  const questions = ids.map(question);
  usePracticeStore().$patch({
    phase: 'running', index: 0, graded: [],
    questions: new Map(questions.map(entry => [entry.id, entry])),
    items: questions.map(entry => ({ questionId: entry.id, partId: entry.parts[0]!.id, reason: 'manual' })),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let unmount: (() => void) | undefined;
async function mountPractice(path = '/practice'): Promise<HTMLElement> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/practice', component: PracticeView }] });
  await router.push(path);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = createApp({ render: () => h(RouterView) }).use(pinia).use(router);
  view.mount(host);
  unmount = () => view.unmount();
  await nextTick();
  return host;
}

let pinia: ReturnType<typeof createPinia>;
describe('practice question loading and replacement', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    pinia = createPinia();
    setActivePinia(pinia);
    await useProgressStore().init();
  });
  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows loading immediately during a history handoff without exposing the previous programme', async () => {
    const pending = deferred<void>();
    publishQuestions(['old', 'older']);
    const practice = usePracticeStore();
    const start = vi.spyOn(practice, 'startQuestions').mockImplementation(async () => {
      await pending.promise;
      publishQuestions(['new']);
    });
    const grade = vi.spyOn(practice, 'recordGraded');
    const host = await mountPractice('/practice?source=history&questions=new&focus=new&coreSource=remote&contentId=revision');
    expect(start).toHaveBeenCalledWith(['new'], 'remote', 'revision');
    expect(host.querySelector('.practice__loading[role="status"]')?.textContent).toContain('Aufgaben werden geladen');
    expect(host.querySelector('.practice__stage')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.practice__skeleton')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.textContent).not.toContain('Question old');
    expect(host.textContent).not.toContain('Aufgabe 1 von 2');
    expect(host.querySelector('.practice__content, .practice-bar, .practice__session-rail-shell')).toBeNull();

    pending.resolve();
    await vi.waitFor(() => expect(host.querySelector('.practice__content')?.textContent).toContain('Question new'));
    expect(host.querySelector('.practice__stage')?.getAttribute('aria-busy')).toBe('false');
    expect(host.textContent).not.toContain('Question old');
    expect(host.querySelectorAll('#practice-task-panel')).toHaveLength(1);
    expect(grade).not.toHaveBeenCalled();
  });

  it.each(['restored', 'missing', 'failed'] as const)('settles a %s prepared restore without leaving its loading state stuck', async outcome => {
    const pending = deferred<boolean>();
    publishQuestions(['old']);
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockImplementation(async () => {
      const restored = await pending.promise;
      if (restored) publishQuestions(['restored']);
      return restored;
    });
    const host = await mountPractice('/practice?prepared=selection');
    expect(host.querySelector('.practice__loading')).not.toBeNull();
    expect(host.textContent).not.toContain('Question old');
    if (outcome === 'failed') {
      practice.phase = 'loading';
      pending.reject(new Error('storage unavailable'));
    } else pending.resolve(outcome === 'restored');
    await vi.waitFor(() => expect(host.querySelector('.practice__stage')?.getAttribute('aria-busy')).toBe('false'));
    expect(host.textContent).toContain(outcome === 'restored' ? 'Question restored' : 'Auswahl nicht verfügbar');
    expect(host.textContent).not.toContain('Question old');
  });

  it('replaces only the incoming question while retaining the rail, then keeps that surface during answer edits', async () => {
    publishQuestions(['first', 'second']);
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
    const save = vi.spyOn(practice, 'saveAnswerDraft').mockResolvedValue({ status: 'saved' });
    const host = await mountPractice();
    await vi.waitFor(() => expect(host.querySelector('.practice__content')).not.toBeNull());
    const oldContent = host.querySelector('.practice__content')!;
    const rail = host.querySelector('.practice__session-rail-shell');
    practice.index = 1;
    await nextTick();
    const nextContent = host.querySelector('.practice__content')!;
    expect(nextContent).not.toBe(oldContent);
    expect(oldContent.isConnected).toBe(false);
    expect(nextContent.textContent).toContain('Question second');
    expect(nextContent.textContent).not.toContain('Question first');
    expect(host.querySelectorAll('.practice__content')).toHaveLength(1);
    expect(host.querySelector('.practice__session-rail-shell')).toBe(rail);
    expect(host.querySelector('.practice__stage')?.getAttribute('aria-busy')).toBe('false');
    nextContent.querySelector<HTMLButtonElement>('button.q-choice__select')!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(host.querySelector('.practice__content')).toBe(nextContent);
    expect(host.querySelector('.practice__session-rail-shell')).toBe(rail);
  });
});
