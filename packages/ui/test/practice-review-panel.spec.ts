import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Grading, SelfAssessment } from '@qed2/core-logic';
import type { PartPlayerState } from '../src/index.js';
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
  it('shows the official solution and assessment without repeating the submitted answer', () => {
    const view = mount(PracticeReviewPanel, { props: { state, solution, ready: true } });
    expect(view.text()).not.toContain('Meine Antwort');
    expect(view.text()).not.toContain('Meine eigene Begründung');
    expect(view.get('.practice-review__solution').text()).toContain('Die offizielle Begründung');
    expect(view.find('.q-solution button[aria-expanded]').exists()).toBe(false);
    expect(view.find('textarea, input').exists()).toBe(false);
    expect(view.get('.practice-review__assessment').text()).toContain('Selbstbewertung');
    expect(view.get('.q-selfassess__total').text()).toContain('– / 1');
    expect(view.text()).toContain('Beurteilungshinweis');
    expect(view.text()).toContain(solution[0]!.note);
  });

  it('keeps notes and assessment mounted below the answer measurement boundary without resetting owner state', async () => {
    const view = mount(PracticeReviewPanel, {
      props: {
        state, solution, ready: true, assistAvailable: true,
        rubric: [{ t: 'text', v: 'Begründung vollständig und nachvollziehbar.' }],
      },
    });
    const preview = view.get('[data-solution-preview]');
    expect(preview.text()).toBe('Die offizielle Begründung');
    expect(preview.find('[data-solution-detail]').exists()).toBe(false);
    const details = view.findAll('[data-solution-detail]');
    expect(details).toHaveLength(2);
    expect(details[0]!.text()).toContain(solution[0]!.note);
    expect(details[1]!.text()).toContain('Selbstbewertung');
    expect(details[1]!.find('[role="radiogroup"]').exists()).toBe(true);
    const noteElement = details[0]!.element;
    const assessmentElement = details[1]!.element;
    expect(view.emitted('assessmentUpdate')).toBeUndefined();
    expect(view.emitted('gradingSelect')).toBeUndefined();
    expect(view.text()).toContain(solution[0]!.note);
    expect(view.get('.practice-review__rubric').text()).toContain('Begründung vollständig und nachvollziehbar.');
    expect(view.find('.practice-review__assist').exists()).toBe(true);
    await view.get('.q-selfassess__segment:last-child').trigger('click');
    await view.get('.q-gpick__opt').trigger('click');
    const assessment = view.emitted('assessmentUpdate')![0]![0] as SelfAssessment;
    const grading = view.emitted('gradingSelect')![0]![0] as Grading;
    const gradingLabel = view.get('.q-gpick__opt').text();
    // The owner applies emitted choices; details remain mounted during updates.
    const assessedState: PartPlayerState = {
      ...state,
      selfAssessment: { ...state.selfAssessment!, assessment, selectedPoints: 1, grading },
    };
    await view.setProps({ state: assessedState });
    expect(view.get('.q-selfassess__segment[aria-checked="true"]').text()).toBe('1');
    expect(view.get('.q-gpick__opt[aria-checked="true"]').text()).toBe(gradingLabel);

    await view.setProps({ disabled: true });
    expect(view.get('.q-selfassess__segment[aria-checked="true"]').attributes('disabled')).toBeDefined();
    await view.setProps({ disabled: false });
    expect(view.findAll('[data-solution-detail]')[0]!.element).toBe(noteElement);
    expect(view.findAll('[data-solution-detail]')[1]!.element).toBe(assessmentElement);
    expect(assessedState.selfAssessment).toMatchObject({ assessment, selectedPoints: 1, grading });
    expect(view.get('.q-selfassess__total').text()).toContain('1 / 1');
    expect(view.get('.q-selfassess__segment[aria-checked="true"]').text()).toBe('1');
    expect(view.get('.q-gpick__opt[aria-checked="true"]').text()).toBe(gradingLabel);
    expect(view.emitted('assessmentUpdate')).toHaveLength(1);
    expect(view.emitted('gradingSelect')).toHaveLength(1);
  });

  it('provides a solution-only measurement fallback when the official answer is missing', () => {
    const view = mount(PracticeReviewPanel, { props: { state, ready: true } });
    const fallback = view.get('[data-solution-fallback]');
    expect(fallback.text()).toContain('Keine offizielle Lösung verfügbar.');
    expect(fallback.find('[data-solution-preview]').exists()).toBe(false);
    expect(fallback.find('[data-solution-detail]').exists()).toBe(false);
    expect(view.get('[data-solution-detail]').text()).toContain('Selbstbewertung');
  });

  it('does not reveal the solution before the submitted draft is durable', async () => {
    const view = mount(PracticeReviewPanel, { props: { state, solution, ready: false } });
    expect(view.text()).toContain('Antwort wird gesichert …');
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

});
