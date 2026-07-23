import { createApp } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import type { PartPlayerState } from '@qed2/ui';
import PracticeBottomBar from '../src/routes/practice/PracticeBottomBar.vue';

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
