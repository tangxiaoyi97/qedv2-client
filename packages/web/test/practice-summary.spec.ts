/**
 * The programme result screen. It used to scatter three differently sized
 * boxes, a chip row and a sync line down the middle of an empty screen, under
 * a heading that only repeated the top bar.
 */
import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GradeResult } from '@qed2/core-logic';
import PracticeView from '../src/routes/PracticeView.vue';
import { usePracticeStore, type GradedRecord } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

function record(partId: string, verdict: GradeResult['verdict'], awarded: number): GradedRecord {
  return {
    clientAttemptId: `a-${partId}`,
    partId,
    questionId: `q-${partId}`,
    result: { verdict, correct: verdict === 'correct', awardedPoints: awarded, maxPoints: 1 },
    reason: 'manual',
    gradedAt: '2026-07-28T10:00:00.000Z',
    elapsedMs: 1000,
  };
}

async function mountSummary(graded: GradedRecord[]): Promise<{
  host: HTMLElement;
  unmount: () => void;
}> {
  const pinia = createPinia();
  setActivePinia(pinia);
  await useProgressStore().init();
  const practice = usePracticeStore();
  // The view would otherwise ask the core for a fresh programme on mount.
  vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
  practice.$patch({
    phase: 'summary',
    items: graded.map((g) => ({ questionId: g.questionId, partId: g.partId, reason: 'manual' })),
    graded,
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
  const app = createApp(PracticeView);
  app.use(pinia);
  app.use(router);
  app.mount(host);
  await nextTick();
  await nextTick();
  return { host, unmount: () => app.unmount() };
}

describe('programme summary', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('is reachable only through Zurück — the second CTA is gone', async () => {
    const { host, unmount } = await mountSummary([record('p1', 'incorrect', 0)]);
    expect(host.textContent).not.toContain('Noch ein Programm');
    const buttons = [...host.querySelectorAll('.practice__summary button, .practice__summary-cta')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Zurück']);
    unmount();
  });

  it('leads with the score and always shows all three verdict counts', async () => {
    const { host, unmount } = await mountSummary([
      record('p1', 'correct', 1),
      record('p2', 'partial', 0.5),
      record('p3', 'incorrect', 0),
    ]);

    expect(host.querySelector('.practice__result-points')?.textContent).toBe('1,5');
    expect(host.querySelector('.practice__result-max')?.textContent).toContain('3');
    // Every count present even at zero, so the row never changes shape.
    const counts = [...host.querySelectorAll('.practice__result-verdict-num')].map(
      (el) => el.textContent,
    );
    expect(counts).toEqual(['1', '1', '1']);
    const labels = [...host.querySelectorAll('.practice__result-verdict-label')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Richtig', 'Teilweise', 'Falsch']);
    unmount();
  });

  it('fills the meter by the share of points earned', async () => {
    const { host, unmount } = await mountSummary([
      record('p1', 'correct', 1),
      record('p2', 'incorrect', 0),
    ]);
    expect(host.querySelector('.practice__result-meter-fill')?.getAttribute('style')).toContain(
      'width: 50%',
    );
    unmount();
  });

  it('says how many tasks were done, in the right number', async () => {
    const one = await mountSummary([record('p1', 'correct', 1)]);
    expect(one.host.querySelector('.practice__result-count')?.textContent).toContain('1 Aufgabe ');
    one.unmount();
    document.body.innerHTML = '';

    const two = await mountSummary([record('p1', 'correct', 1), record('p2', 'correct', 1)]);
    expect(two.host.querySelector('.practice__result-count')?.textContent).toContain('2 Aufgaben');
    two.unmount();
  });
});
