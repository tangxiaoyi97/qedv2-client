import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type {
  GradeResult,
  Grading,
  Question,
  QuestionPart,
  SelfAssessment,
  Submission,
} from '@qed2/core-logic';
import PartPlayer from '../src/practice/PartPlayer.vue';
import type { PartPlayerState } from '../src/practice/part-player-types.js';
import fixture from '../../core-logic/test/fixtures/sample-questions.json';

const questions = (fixture as unknown as { questions: Question[] }).questions;

function partOf(questionId: string): QuestionPart {
  const q = questions.find((x) => x.id === questionId);
  if (!q || !q.parts[0]) throw new Error(`fixture question ${questionId} missing`);
  return q.parts[0];
}

// choice "2 aus 5", correct [1, 3], allOrNothing 1 P
const choicePart = partOf('2019-ht-t1-01');
const intervalPart = partOf('2019-ht-t1-03');
// open (Konstruktionsformat) with rubric, allOrNothing 1 P
const openPart = partOf('2019-ht-t1-04');

type Exposed = {
  submit: () => void;
  confirmSelfAssessment: () => void;
  setSelfAssessmentScore: (points: number) => void;
  setSelfAssessmentGrading: (grading: Grading) => void;
  setSelfAssessment: (value: SelfAssessment) => void;
};

function exposed(wrapper: ReturnType<typeof mount>): Exposed {
  return wrapper.vm as unknown as Exposed;
}

function states(wrapper: ReturnType<typeof mount>): PartPlayerState[] {
  return (wrapper.emitted('state') ?? []).map((args) => args[0] as PartPlayerState);
}

type GradedPayload = {
  partId: string;
  result: GradeResult;
  submission: Submission;
  selfAssessed: boolean;
  manualGrading?: Grading;
};

describe('PartPlayer (chromeless shell contract)', () => {
  it('emits state on mount and tracks canSubmit while the user answers', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: choicePart, label: 'Teil a', chromeless: true },
    });

    // initial state fired without any interaction
    const initial = states(wrapper)[0];
    expect(initial).toBeDefined();
    expect(initial).toMatchObject({
      phase: 'answering',
      canSubmit: false,
      result: null,
      indeterminate: false,
      unplayable: false,
    });

    // chromeless practice owns format + points in the surrounding header.
    expect(wrapper.text()).toContain('Teil a');
    expect(wrapper.find('.q-part__head .q-chip').exists()).toBe(false);
    expect(wrapper.find('.q-part__points').exists()).toBe(false);

    // one pick of two → still incomplete
    const options = wrapper.findAll('button.q-choice__opt');
    expect(options).toHaveLength(5);
    await options[1]!.trigger('click');
    await nextTick();
    expect(states(wrapper).at(-1)!.canSubmit).toBe(false);

    // second pick completes the submission → canSubmit flips true
    await options[3]!.trigger('click');
    await nextTick();
    const afterPicks = states(wrapper).at(-1)!;
    expect(afterPicks.phase).toBe('answering');
    expect(afterPicks.canSubmit).toBe(true);
  });

  it('exposed submit() grades, emits graded (selfAssessed:false) and state(reviewed)', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: choicePart, label: 'Teil a', chromeless: true },
    });
    const options = wrapper.findAll('button.q-choice__opt');
    await options[1]!.trigger('click');
    await options[3]!.trigger('click');

    exposed(wrapper).submit();
    await nextTick();

    const graded = wrapper.emitted('graded');
    expect(graded).toHaveLength(1);
    const payload = graded![0]![0] as GradedPayload;
    expect(payload.partId).toBe(choicePart.id);
    expect(payload.selfAssessed).toBe(false);
    expect(payload.result.verdict).toBe('correct');
    expect(payload.result.awardedPoints).toBe(1);
    expect(payload.result.maxPoints).toBe(1);
    expect(payload.submission).toEqual({ kind: 'choice', selected: [1, 3] });

    const last = states(wrapper).at(-1)!;
    expect(last.phase).toBe('reviewed');
    expect(last.result?.verdict).toBe('correct');

    // review mode reaches the control (marks rendered), but NO chrome of its own
    expect(wrapper.find('.q-choice__opt--ok').exists()).toBe(true);
    expect(wrapper.find('.q-result-banner').exists()).toBe(false);
    expect(wrapper.find('.q-solution').exists()).toBe(false);
  });

  it('renders no own action buttons or key hints in chromeless mode', () => {
    const wrapper = mount(PartPlayer, {
      props: { part: choicePart, label: 'Teil a', chromeless: true },
    });
    expect(wrapper.find('.q-part__actions').exists()).toBe(false);
    expect(wrapper.find('.q-part__actions button').exists()).toBe(false);
    expect(wrapper.find('.q-part__key-hint').exists()).toBe(false);
  });

  it('accepts explicit shell commands without relying on a component ref', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: openPart, chromeless: true, command: null },
    });

    await wrapper.setProps({ command: { id: 1, type: 'submit' } });
    expect(states(wrapper).at(-1)!.phase).toBe('self-assessing');

    await wrapper.setProps({ command: { id: 2, type: 'set-score', points: 1 } });
    await wrapper.setProps({ command: { id: 3, type: 'set-grading', grading: 'good' } });
    await wrapper.setProps({ command: { id: 4, type: 'confirm-self-assessment' } });
    expect(wrapper.emitted('graded')).toHaveLength(1);
  });

  it('exposes interval previews to the shell instead of rendering them in chromeless mode', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: intervalPart, chromeless: true },
    });

    expect(wrapper.find('.q-interval__preview').exists()).toBe(false);
    expect(states(wrapper).at(-1)!.answerPreview).toEqual({
      label: 'Ergebnis',
      value: '( −∞ ; ∞ )',
      hint: 'leer oder ∞ = unbeschränkt · Komma oder Punkt',
    });

    const inputs = wrapper.findAll('input.q-interval__input');
    expect(inputs).toHaveLength(2);
    await inputs[0]!.setValue('-12');
    await inputs[1]!.setValue('-8');
    await nextTick();

    expect(states(wrapper).at(-1)!.answerPreview?.value).toBe('[ -12 ; -8 ]');
  });

  it('open part: submit() → self-assessing (no grade yet), confirmSelfAssessment() emits selfAssessed:true', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: openPart, label: 'Teil a', chromeless: true },
    });

    // open submissions are always complete ("answered on paper" allowed)
    expect(states(wrapper)[0]!.canSubmit).toBe(true);

    exposed(wrapper).submit();
    await nextTick();

    // no grade before the user self-assessed
    expect(wrapper.emitted('graded')).toBeUndefined();
    const selfState = states(wrapper).at(-1)!;
    expect(selfState.phase).toBe('self-assessing');
    expect(selfState.result).toBeNull();

    // The shell owns self-assessment controls in chromeless mode.
    expect(wrapper.find('.q-selfassess').exists()).toBe(false);
    expect(selfState.selfAssessment?.scoreOptions.map((option) => option.points)).toEqual([0, 1]);
    expect(selfState.selfAssessment?.selectedPoints).toBeNull();
    // The solution + confirm button belong to the shell (SolutionSheet auto-opens there)
    expect(wrapper.find('.q-solution').exists()).toBe(false);
    expect(wrapper.find('.q-part__actions').exists()).toBe(false);

    // The shell picks the score/mastery controls, then confirms.
    exposed(wrapper).setSelfAssessmentScore(1);
    exposed(wrapper).setSelfAssessmentGrading('good');
    exposed(wrapper).confirmSelfAssessment();
    await nextTick();

    const graded = wrapper.emitted('graded');
    expect(graded).toHaveLength(1);
    const payload = graded![0]![0] as GradedPayload;
    expect(payload.partId).toBe(openPart.id);
    expect(payload.selfAssessed).toBe(true);
    expect(payload.result.verdict).toBe('correct');
    expect(payload.result.awardedPoints).toBe(1);
    expect(payload.manualGrading).toBe('good');
    expect(payload.submission.kind).toBe('open');
    expect((payload.submission as { selfAssessment: { awardedPoints?: number; overall?: string } }).selfAssessment.awardedPoints).toBe(1);
    expect((payload.submission as { selfAssessment: { awardedPoints?: number; overall?: string } }).selfAssessment.overall).toBe('full');

    expect(states(wrapper).at(-1)!.phase).toBe('reviewed');
  });

  it('accepts criterion-by-criterion rubric state from a chromeless shell', async () => {
    const rubricPart: QuestionPart = {
      ...openPart,
      scoring: {
        mode: 'rubric',
        criteria: [
          { desc: 'Ansatz', points: 1 },
          { desc: 'Begründung', points: 2 },
        ],
      },
      points: 3,
    };
    const wrapper = mount(PartPlayer, { props: { part: rubricPart, chromeless: true } });

    exposed(wrapper).submit();
    exposed(wrapper).setSelfAssessment({ criteriaMet: [true, false] });
    await nextTick();

    const self = states(wrapper).at(-1)!.selfAssessment;
    expect(self?.assessment.criteriaMet).toEqual([true, false]);
    expect(self?.selectedPoints).toBe(1);
    expect(self?.grading).toBe('meh');
  });
});

describe('PartPlayer (default, non-chromeless — legacy behavior)', () => {
  it('keeps its own button, key hint, ResultBanner and SolutionPanel', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: choicePart, label: 'Teil a' },
    });

    // own footer chrome present while answering
    expect(wrapper.find('.q-part__key-hint').exists()).toBe(true);
    const button = wrapper.find('.q-part__actions button');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain('Überprüfen');

    const options = wrapper.findAll('button.q-choice__opt');
    await options[1]!.trigger('click');
    await options[3]!.trigger('click');
    await wrapper.find('.q-part__actions button').trigger('click');

    // banner + solution panel rendered by the player itself after grading
    const banner = wrapper.find('.q-result-banner');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('Richtig');
    expect(wrapper.find('.q-solution').exists()).toBe(true);
    expect(wrapper.emitted('graded')).toHaveLength(1);
  });
});
