import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PartPlayerState } from '@qed2/ui';
import PracticeBottomBar from '../src/routes/practice/PracticeBottomBar.vue';

const reviewed = (verdict: 'correct' | 'partial' | 'incorrect'): PartPlayerState => ({
  phase: 'reviewed',
  canSubmit: false,
  result: { verdict, correct: verdict === 'correct', awardedPoints: verdict === 'correct' ? 1 : 0, maxPoints: 1 },
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  selfAssessment: null,
});

const answering: PartPlayerState = {
  phase: 'answering',
  canSubmit: false,
  result: null,
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  selfAssessment: null,
};

const selfAssessing: PartPlayerState = {
  phase: 'self-assessing',
  canSubmit: false,
  result: null,
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  selfAssessment: {
    maxPoints: 1,
    scoreOptions: [
      { points: 0, label: '0' },
      { points: 1, label: '1' },
    ],
    selectedPoints: null,
    grading: null,
    assessment: {},
  },
};

describe('PracticeBottomBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the dedicated self-assessment layout and Bewertung wording', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(PracticeBottomBar, {
      state: selfAssessing,
      answerPreview: null,
      answerKind: 'open',
      solutionOpen: true,
      grading: 'unseen',
      primaryLabel: 'Bewertung übernehmen',
      primaryDisabled: true,
    });
    app.mount(host);

    expect(host.querySelector('.practice-bar__row')?.classList).toContain('practice-bar__row--assessment');
    expect(host.querySelector('select')?.getAttribute('aria-label')).toBe('Bewertung');
    expect(host.textContent).toContain('Bewertung');

    app.unmount();
  });
});

/**
 * The bar was overflowing on a phone: grading capsule, verdict, Lösung toggle
 * and the primary button all competed for one row and overlapped. The verdict
 * moved into the solution sheet and survives in the bar only as colour.
 */
describe('PracticeBottomBar verdict presentation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** Props are readonly, so the state is driven from a parent, as in the app. */
  function mountBar(state: PartPlayerState): {
    host: HTMLElement;
    unmount: () => void;
    setState: (s: PartPlayerState) => Promise<void>;
  } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const current = ref(state);
    const app = createApp({
      render: () =>
        h(PracticeBottomBar, {
          state: current.value,
          answerPreview: null,
          answerKind: 'choice',
          solutionOpen: false,
          grading: 'unseen',
          primaryLabel: 'Weiter →',
          primaryDisabled: false,
          solution: [],
        }),
    });
    app.mount(host);
    return {
      host,
      unmount: () => app.unmount(),
      setState: async (s) => {
        current.value = s;
        await nextTick();
      },
    };
  }

  it('keeps the verdict text out of the action row and inside the sheet', () => {
    const { host, unmount } = mountBar(reviewed('incorrect'));
    const row = host.querySelector('.practice-bar__row');
    expect(row?.textContent).not.toContain('Falsch');
    expect(host.querySelector('.q-ssheet__verdict')?.textContent).toContain('Falsch');
    expect(host.querySelector('.q-ssheet__verdict')?.textContent).toContain('0 / 1 P');
    unmount();
  });

  it('paints the bar and the sheet with the verdict tone', () => {
    const { host, unmount } = mountBar(reviewed('correct'));
    expect(host.querySelector('.practice-bar__tint')?.classList).toContain(
      'practice-bar__tint--correct',
    );
    expect(host.querySelector('.q-ssheet-wrap')?.classList).toContain('q-ssheet-wrap--correct');
    unmount();
  });

  it('shows no tint and no grab handle while the question is unanswered', () => {
    const { host, unmount } = mountBar(answering);
    expect(host.querySelector('.practice-bar__tint')).toBeNull();
    expect(host.querySelector('.q-ssheet__handle')).toBeNull();
    unmount();
  });

  it('drains the tint away instead of dropping it when the part advances', async () => {
    vi.useFakeTimers();
    const { host, setState, unmount } = mountBar(reviewed('correct'));
    const before = host.querySelector('.practice-bar__tint');

    await setState(answering); // „Weiter" → next part, verdict cleared
    const tint = host.querySelector('.practice-bar__tint');
    // Same node, now clipping itself away — a replaced node would have no
    // start value and the transition would not run at all.
    expect(tint).toBe(before);
    expect(tint, 'the old tint must outlive the verdict long enough to animate').not.toBeNull();
    expect(tint?.classList).toContain('practice-bar__tint--draining');

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(host.querySelector('.practice-bar__tint')).toBeNull();

    unmount();
    vi.useRealTimers();
  });
});
