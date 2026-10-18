import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { Submission, QuestionPart } from '@qed2/core-logic';
import { latexToMathjs } from '../../core-logic/src/grading/latex.js';
import PartPlayer from '../src/practice/PartPlayer.vue';
import AnswerControl from '../src/question/AnswerControl.vue';
import type { PartPlayerDraft, PartPlayerState } from '../src/practice/part-player-types.js';
import fixture from '../../core-logic/test/fixtures/rubric-bank-parts.json';

const records = fixture.records as unknown as Array<{ commit: string; part: QuestionPart }>;
type Exposed = { submit(): void; confirmSelfAssessment(): void };
const controls = (wrapper: ReturnType<typeof mount>) => wrapper.vm as unknown as Exposed;
const state = (wrapper: ReturnType<typeof mount>) => wrapper.emitted('state')?.at(-1)?.[0] as PartPlayerState;

function exactSubmission(part: QuestionPart): Submission {
  if (part.answer?.kind === 'numeric') {
    return { kind: 'numeric', values: Object.fromEntries(part.answer.blanks.map((blank) => [blank.id, String(blank.value)])) };
  }
  if (part.answer?.kind === 'expression') return { kind: 'expression', expr: latexToMathjs(part.answer.canonical) };
  throw new Error('Unexpected bank fixture answer kind');
}

describe('PartPlayer — real rubric questions with automatic answer controls', () => {
  it.each(records)('$commit / $part.id requires explicit criteria before emitting a durable grade', async ({ part }) => {
    if (part.scoring?.mode !== 'rubric') throw new Error('Expected rubric bank fixture');
    const wrapper = mount(PartPlayer, { props: { part } });
    const submission = exactSubmission(part);
    wrapper.findComponent(AnswerControl).vm.$emit('update:modelValue', submission);
    await nextTick();
    controls(wrapper).submit();
    await nextTick();

    expect(state(wrapper)).toMatchObject({ phase: 'self-assessing', result: null, indeterminate: false });
    expect(state(wrapper).selfAssessment?.selectedPoints).toBeNull();
    expect(wrapper.emitted('graded')).toBeUndefined();
    controls(wrapper).confirmSelfAssessment();
    expect(wrapper.emitted('graded')).toBeUndefined();
    for (const criterion of part.scoring.criteria) expect(wrapper.text()).toContain(criterion.desc);
    for (const button of wrapper.findAll('.q-selfassess__criterion')) await button.trigger('click');
    expect((wrapper.emitted('draft')?.at(-1)?.[0] as PartPlayerDraft).assessment.criteriaMet)
      .toEqual(part.scoring.criteria.map(() => true));

    controls(wrapper).confirmSelfAssessment();
    controls(wrapper).confirmSelfAssessment();
    await nextTick();
    const maxPoints = part.scoring.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
    expect(wrapper.emitted('graded')).toHaveLength(1);
    expect(wrapper.emitted('graded')?.[0]?.[0]).toMatchObject({
      partId: part.id, submission, selfAssessed: true, manualGrading: 'good',
      result: {
        verdict: 'correct', correct: true, awardedPoints: maxPoints, maxPoints,
        breakdown: part.scoring.criteria.map((criterion, index) => ({ ref: String(index), correct: true, awardedPoints: criterion.points })),
      },
    });
    expect(state(wrapper).phase).toBe('reviewed');
    wrapper.unmount();
  });

  it('restores a partial criterion selection without changing the numeric answer or awarding full points', async () => {
    const part = records.find((record) => record.part.id === '2022-ht-t2-01-a2')!.part;
    const submission = exactSubmission(part);
    const wrapper = mount(PartPlayer, { props: {
      part,
      restoredDraft: {
        submission, assessment: { criteriaMet: [true, false] }, selectedPoints: 0.5,
        grading: null, indeterminate: false, indeterminateMax: 1,
      },
    } });
    expect(wrapper.findAll('.q-selfassess__criterion').map((button) => button.attributes('aria-pressed'))).toEqual(['true', 'false']);
    expect(wrapper.emitted('graded')).toBeUndefined();
    controls(wrapper).confirmSelfAssessment();
    expect(wrapper.emitted('graded')?.[0]?.[0]).toMatchObject({
      submission, selfAssessed: true, manualGrading: 'meh',
      result: {
        verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 1,
        breakdown: [{ ref: '0', correct: true, awardedPoints: 0.5 }, { ref: '1', correct: false, awardedPoints: 0 }],
      },
    });
    wrapper.unmount();
  });

  it('records zero only after the learner explicitly selects no criteria', async () => {
    const part = records[0]!.part;
    const wrapper = mount(PartPlayer, { props: { part, restoredAnswerDraft: exactSubmission(part) } });
    controls(wrapper).submit();
    await nextTick();
    expect(wrapper.emitted('graded')).toBeUndefined();
    await wrapper.get('.q-selfassess__none').trigger('click');
    controls(wrapper).confirmSelfAssessment();
    expect(wrapper.emitted('graded')?.[0]?.[0]).toMatchObject({
      selfAssessed: true, manualGrading: 'baffled',
      result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
    });
    wrapper.unmount();
  });
});
