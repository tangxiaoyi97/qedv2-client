import { createApp } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import type { PartPlayerState } from '@qed2/ui';
import PracticeBottomBar from '../src/routes/practice/PracticeBottomBar.vue';

const reviewed = (verdict: 'correct' | 'partial' | 'incorrect'): PartPlayerState => ({
  phase: 'reviewed',
  canSubmit: false,
  result: {
    verdict,
    correct: verdict === 'correct',
    awardedPoints: verdict === 'correct' ? 1 : 0,
    maxPoints: 1,
  },
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

function mountBar(state: PartPlayerState, extra: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(PracticeBottomBar, {
    state,
    answerPreview: null,
    solutionDetent: 'collapsed',
    grading: 'unseen',
    primaryLabel: 'Weiter →',
    primaryDisabled: false,
    solution: [],
    ...extra,
  });
  app.mount(host);
  return { host, unmount: () => app.unmount() };
}

describe('PracticeBottomBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the dedicated self-assessment layout and Bewertung wording', () => {
    const { host, unmount } = mountBar(selfAssessing, {
      solutionDetent: 'default',
      primaryLabel: 'Bewertung übernehmen',
      primaryDisabled: true,
    });

    expect(host.querySelector('.practice-bar__row')?.classList).toContain(
      'practice-bar__row--assessment',
    );
    expect(host.querySelector('select')?.getAttribute('aria-label')).toBe('Bewertung');
    expect(host.textContent).toContain('Bewertung');
    unmount();
  });

  it('says nothing at all while the question is untouched', () => {
    // The bar used to nag „Antwort oben auswählen …" into the empty slot.
    // An empty slot is the correct amount of instruction.
    const { host, unmount } = mountBar(answering);
    expect(host.textContent).not.toContain('Antwort oben');
    expect(host.querySelector('.practice-bar__hint')).toBeNull();
    unmount();
  });

  it('keeps the verdict out of the action row and inside the sheet', () => {
    const { host, unmount } = mountBar(reviewed('incorrect'), { solutionDetent: 'default' });
    expect(host.querySelector('.practice-bar__row')?.textContent).not.toContain('Falsch');
    const verdict = host.querySelector('.q-ssheet__verdict');
    expect(verdict?.textContent).toContain('Falsch');
    expect(verdict?.textContent).toContain('0 / 1 P');
    unmount();
  });

  it('never colours the bar or the drawer by the result', () => {
    for (const verdict of ['correct', 'partial', 'incorrect'] as const) {
      const { host, unmount } = mountBar(reviewed(verdict), { solutionDetent: 'default' });
      expect(host.querySelector('.practice-bar__tint'), verdict).toBeNull();
      expect(host.querySelector('.q-ssheet-wrap')?.className, verdict).toBe('q-ssheet-wrap');
      unmount();
      document.body.innerHTML = '';
    }
  });

  it('shows the grab handle only once there is something to reveal', () => {
    const before = mountBar(answering);
    expect(before.host.querySelector('.q-ssheet__handle')).toBeNull();
    before.unmount();
    document.body.innerHTML = '';

    const after = mountBar(reviewed('correct'));
    expect(after.host.querySelector('.q-ssheet__handle')).not.toBeNull();
    after.unmount();
  });
});
