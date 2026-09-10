import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { PartPlayerState } from '../src/index.js';
import { formatIntervalSubmissionPreview } from '../src/question/submission-preview.js';
import PracticeReviewPanel from '../src/practice/PracticeReviewPanel.vue';

const state: PartPlayerState = {
  phase: 'self-assessing', canSubmit: false, result: null,
  indeterminate: false, unplayable: false, answerPreview: null,
  submittedText: 'Meine eigene Begründung',
  selfAssessment: {
    maxPoints: 1, scoreOptions: [{ points: 0, label: '0' }, { points: 1, label: '1' }],
    selectedPoints: null, grading: null, assessment: {},
  },
};
const solution = [{ result: [{ t: 'text' as const, v: 'Die offizielle Begründung' }], note: 'Ein Punkt für die Begründung.' }];

describe('PracticeReviewPanel', () => {
  it('separates the submitted answer from the official solution and assessment', () => {
    const view = mount(PracticeReviewPanel, { props: { state, solution, ready: true } });
    expect(view.get('.practice-review__answer').text()).toContain('Meine eigene Begründung');
    expect(view.get('.practice-review__answer').text()).not.toContain('Die offizielle Begründung');
    expect(view.get('.practice-review__solution').text()).toContain('Die offizielle Begründung');
    expect(view.find('.q-solution button[aria-expanded]').exists()).toBe(false);
    expect(view.find('textarea, input').exists()).toBe(false);
    expect(view.get('.practice-review__assessment').text()).toContain('Selbstbewertung');
    expect(view.get('.q-selfassess__total').text()).toContain('– / 1');
  });

  it('does not reveal the solution before the submitted draft is durable', async () => {
    const view = mount(PracticeReviewPanel, { props: { state, solution, ready: false } });
    expect(view.text()).toContain('Meine eigene Begründung');
    expect(view.text()).not.toContain('Die offizielle Begründung');
    expect(view.find('.q-selfassess').exists()).toBe(false);
    await view.setProps({ ready: true });
    expect(view.text()).toContain('Die offizielle Begründung');
  });

  it('keeps point selection and confidence under learner control', async () => {
    const view = mount(PracticeReviewPanel, { props: { state, solution, ready: true, assistAvailable: true } });
    await view.get('.q-selfassess__segment:last-child').trigger('click');
    expect(view.emitted('assessmentUpdate')).toEqual([[expect.objectContaining({ awardedPoints: 1 })]]);
    await view.get('.q-gpick__opt').trigger('click');
    expect(view.emitted('gradingSelect')).toHaveLength(1);
    await view.get('.practice-review__assist').trigger('click');
    expect(view.emitted('assist')).toHaveLength(1);
    expect(view.emitted('graded')).toBeUndefined();
  });

  it('distinguishes a missing saved answer from an answer made on paper', () => {
    const view = mount(PracticeReviewPanel, { props: { state: { ...state, submittedText: '' }, ready: true, submissionUnavailable: true } });
    expect(view.text()).toContain('Deine gespeicherte Antwort ist auf diesem Gerät nicht verfügbar.');
    expect(view.text()).not.toContain('Keine schriftliche Antwort');
  });

  it.each([
    { lower: '1', upper: '2', lowerClosed: false, upperClosed: true, expected: '( 1 ; 2 ]' },
    { lower: '', upper: '2', lowerClosed: true, upperClosed: false, expected: '( −∞ ; 2 )' },
  ])('preserves interval endpoints in the submitted answer: $expected', (example) => {
    const preview = formatIntervalSubmissionPreview({ kind: 'interval', ...example });
    const view = mount(PracticeReviewPanel, { props: {
      state: { ...state, submittedText: '1 … 2', answerPreview: { label: 'Ergebnis', value: preview } }, ready: true,
    } });
    expect(view.get('.practice-review__submitted').text()).toBe(example.expected);
  });

});
