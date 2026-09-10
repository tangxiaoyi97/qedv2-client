import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import type {
  GradeResult,
  Grading,
  Question,
  QuestionPart,
  SelfAssessment,
  Submission,
} from '@qed2/core-logic';
import PartPlayer from '../src/practice/PartPlayer.vue';
import AnswerControl from '../src/question/AnswerControl.vue';
import type { PartPlayerDraft, PartPlayerState } from '../src/practice/part-player-types.js';
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
  it('keeps a restored numeric draft incomplete while a required blank is absent', async () => {
    const wrapper = mount(PartPlayer, { props: {
      part: {
        ...openPart,
        answer: { kind: 'numeric', blanks: [{ id: 'a', value: 1, tol: 0 }, { id: 'b', value: 2, tol: 0 }] },
      },
      chromeless: true,
      restoredAnswerDraft: { kind: 'numeric', values: { a: '1' } },
    } });
    expect(wrapper.findAll<HTMLInputElement>('input')[1]!.element.value).toBe('');
    expect(states(wrapper).at(-1)!.canSubmit).toBe(false);
    exposed(wrapper).submit();
    expect(wrapper.emitted('graded')).toBeUndefined();
    await wrapper.findAll('input')[1]!.setValue('2');
    expect(states(wrapper).at(-1)!.canSubmit).toBe(true);
  });

  it('keeps a restored matching draft incomplete while a required row is absent', () => {
    const wrapper = mount(PartPlayer, { props: {
      part: {
        ...openPart,
        answer: {
          kind: 'matching',
          left: [[{ t: 'text', v: 'First' }], [{ t: 'text', v: 'Second' }]],
          right: [[{ t: 'text', v: 'A' }], [{ t: 'text', v: 'B' }]],
          pairs: [[0, 0], [1, 1]],
        },
      },
      chromeless: true,
      restoredAnswerDraft: { kind: 'matching', matches: [0] },
    } });
    expect(states(wrapper).at(-1)!.canSubmit).toBe(false);
    exposed(wrapper).submit();
    expect(wrapper.emitted('graded')).toBeUndefined();
  });

  it('uses Enter between interval bounds without grading an unfinished IME candidate', async () => {
    const wrapper = mount(PartPlayer, { attachTo: document.body, props: { part: intervalPart, chromeless: true } });
    const inputs = wrapper.findAll<HTMLInputElement>('input');
    await inputs[0]!.setValue('-12');
    await inputs[1]!.setValue('-8');
    inputs[0]!.element.focus();
    inputs[0]!.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    await nextTick();
    expect(states(wrapper).at(-1)!.phase).toBe('answering');
    expect(document.activeElement).toBe(inputs[0]!.element);
    await inputs[0]!.trigger('keydown', { key: 'Enter' });
    expect(document.activeElement).toBe(inputs[1]!.element);
    expect(wrapper.emitted('graded')).toBeUndefined();
    await inputs[1]!.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('graded')).toHaveLength(1);
    wrapper.unmount();
  });

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

  it('does not pair another window\'s result with an unknown empty submission', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: choicePart, chromeless: true, command: null },
    });
    await wrapper.setProps({
      command: {
        id: 1,
        type: 'restore-review',
        result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
        submissionUnavailable: true,
      },
    });

    expect(wrapper.find('.q-part__control').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toContain('anderen Fenster');
    expect(states(wrapper).at(-1)!.phase).toBe('reviewed');
  });

  it('does not pair a restored correct result with an intentionally discarded answer', () => {
    const wrapper = mount(PartPlayer, {
      props: {
        part: choicePart,
        chromeless: true,
        restoredFirstResult: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
        restoredSubmissionUnavailable: true,
      },
    });

    expect(wrapper.find('.q-part__control').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toContain('anderen Fenster');
    expect(states(wrapper).at(-1)!.phase).toBe('reviewed');
  });

  it('restores and emits a local first-answer draft', async () => {
    const wrapper = mount(PartPlayer, {
      props: {
        part: openPart,
        chromeless: true,
        restoredAnswerDraft: { kind: 'open', text: 'Zwischengespeichert', selfAssessment: {} },
      },
    });

    expect(wrapper.get('textarea').element.value).toBe('Zwischengespeichert');
    await wrapper.get('textarea').setValue('Weitergeschrieben');
    await nextTick();
    expect(wrapper.emitted('answerDraft')?.at(-1)?.[0]).toMatchObject({
      kind: 'open',
      text: 'Weitergeschrieben',
    });
  });

  it('does not turn restored or edited drafts into a reactive save echo', async () => {
    const parentRevision = ref(0);
    let saves = 0;
    const wrapper = mount(PartPlayer, {
      props: {
        part: openPart,
        chromeless: true,
        restoredAnswerDraft: {
          kind: 'open',
          text: 'Alter Entwurf',
          selfAssessment: {},
        },
        onAnswerDraft: async () => {
          saves += 1;
          const observedRevision = parentRevision.value;
          await Promise.resolve();
          parentRevision.value = observedRevision + 1;
        },
      },
    });

    await nextTick();
    expect(saves).toBe(0);
    await wrapper.get('textarea').setValue('Nur diese Änderung speichern');
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
    await nextTick();

    expect(saves).toBe(1);
    expect(parentRevision.value).toBe(1);
    expect(wrapper.emitted('answerDraft')).toHaveLength(1);
  });

  it('exposes interval previews to the shell instead of rendering them in chromeless mode', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: intervalPart, chromeless: true },
    });

    expect(wrapper.find('.q-interval__preview').exists()).toBe(false);
    expect(states(wrapper).at(-1)!.answerPreview).toEqual({
      label: 'Ergebnis',
      value: '( −∞ ; ∞ )',
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
    const answer = wrapper.find('textarea');
    await answer.setValue('Mein eigener Lösungsweg');

    // open submissions are always complete ("answered on paper" allowed)
    expect(states(wrapper)[0]!.canSubmit).toBe(true);

    exposed(wrapper).submit();
    await nextTick();

    // no grade before the user self-assessed
    expect(wrapper.emitted('graded')).toBeUndefined();
    const selfState = states(wrapper).at(-1)!;
    expect(selfState.phase).toBe('self-assessing');
    expect(selfState.result).toBeNull();
    expect(wrapper.find('.q-answer-control').attributes('inert')).toBeDefined();
    await answer.setValue('Nach dem Öffnen der Lösung geändert');
    await nextTick();
    expect(states(wrapper).at(-1)!.submittedText).toBe('Mein eigener Lösungsweg');

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

    exposed(wrapper).confirmSelfAssessment();
    await nextTick();
    expect((wrapper.emitted('graded')!.at(-1)![0] as GradedPayload).result.breakdown).toEqual([
      { ref: '0', correct: true, awardedPoints: 1 },
      { ref: '1', correct: false, awardedPoints: 0 },
    ]);
  });

  it('updates suggested mastery with changed points until the learner explicitly chooses it', async () => {
    const wrapper = mount(PartPlayer, { props: { part: openPart, chromeless: true } });
    exposed(wrapper).submit();
    exposed(wrapper).setSelfAssessmentScore(0);
    await nextTick();
    expect(states(wrapper).at(-1)!.selfAssessment?.grading).toBe('baffled');
    exposed(wrapper).setSelfAssessmentScore(1);
    await nextTick();
    expect(states(wrapper).at(-1)!.selfAssessment?.grading).toBe('good');
    exposed(wrapper).setSelfAssessmentGrading('careless');
    exposed(wrapper).setSelfAssessmentScore(0);
    await nextTick();
    expect(states(wrapper).at(-1)!.selfAssessment?.grading).toBe('careless');
    exposed(wrapper).confirmSelfAssessment();
    expect((wrapper.emitted('graded')!.at(-1)![0] as GradedPayload).manualGrading).toBe('careless');
  });

  it('replaces criterion selection when a shell explicitly selects a rubric point total', async () => {
    const wrapper = mount(PartPlayer, { props: {
      part: { ...openPart, points: 3, scoring: { mode: 'rubric', criteria: [{ desc: 'Ansatz', points: 1 }, { desc: 'Rechnung', points: 2 }] } },
      chromeless: true,
    } });
    exposed(wrapper).submit();
    exposed(wrapper).setSelfAssessment({ criteriaMet: [true, false] });
    exposed(wrapper).setSelfAssessmentScore(3);
    await nextTick();
    expect(states(wrapper).at(-1)!.selfAssessment?.assessment.criteriaMet).toBeUndefined();
    exposed(wrapper).confirmSelfAssessment();
    expect((wrapper.emitted('graded')!.at(-1)![0] as GradedPayload).result).toMatchObject({ verdict: 'correct', awardedPoints: 3 });
  });

  it.each([null, 'careless'] as const)('restores %s mastery in a draft and keeps suggestions distinct from explicit choices', async (grading) => {
    const wrapper = mount(PartPlayer, { props: {
      part: openPart,
      chromeless: true,
      restoredDraft: {
        submission: { kind: 'open', text: 'Mein Entwurf', selfAssessment: {} },
        assessment: { awardedPoints: 0, overall: 'none' },
        selectedPoints: 0,
        grading,
        indeterminate: false,
        indeterminateMax: 1,
      },
    } });
    expect(states(wrapper).at(-1)!.selfAssessment?.grading).toBe(grading ?? 'baffled');
    exposed(wrapper).setSelfAssessmentScore(1);
    await nextTick();
    expect(states(wrapper).at(-1)!.selfAssessment?.grading).toBe(grading ?? 'good');
    expect((wrapper.emitted('draft')!.at(-1)![0] as PartPlayerDraft).grading).toBe(grading);
    exposed(wrapper).confirmSelfAssessment();
    expect((wrapper.emitted('graded')!.at(-1)![0] as GradedPayload).manualGrading).toBe(grading ?? 'good');
  });

  it('keeps an incorrect result read-only with no correction action or second grade', async () => {
    const wrapper = mount(PartPlayer, {
      props: { part: choicePart, chromeless: true },
    });
    const options = wrapper.findAll('button.q-choice__opt');
    await options[0]!.trigger('click');
    await options[2]!.trigger('click');
    exposed(wrapper).submit();
    await nextTick();
    expect(wrapper.emitted('graded')).toHaveLength(1);
    expect((wrapper.emitted('graded')![0]![0] as GradedPayload).result.verdict).toBe('incorrect');

    expect(wrapper.vm).not.toHaveProperty('startCorrection');
    expect(states(wrapper).at(-1)).not.toHaveProperty('attemptPhase');
    expect(wrapper.find('.q-part__correction').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Korrektur');

    // Even a stale control event or repeated primary action cannot edit the
    // answer after its original grade has been shown.
    wrapper.getComponent(AnswerControl).vm.$emit('update:modelValue', {
      kind: 'choice', selected: [1, 3],
    });
    exposed(wrapper).submit();
    await nextTick();

    expect(wrapper.emitted('graded')).toHaveLength(1);
    expect(wrapper.emitted('corrected')).toBeUndefined();
    expect(wrapper.emitted('correctionDraft')).toBeUndefined();
    expect(wrapper.getComponent(AnswerControl).props('modelValue')).toEqual({
      kind: 'choice', selected: [0, 2],
    });
    expect(states(wrapper).at(-1)).toMatchObject({
      phase: 'reviewed',
      result: { verdict: 'incorrect', awardedPoints: 0 },
      canSubmit: false,
    });
  });

  it('restores a reviewed first result without emitting a second grade', async () => {
    const restored: GradeResult = {
      verdict: 'incorrect',
      correct: false,
      awardedPoints: 0,
      maxPoints: 1,
    };
    const wrapper = mount(PartPlayer, {
      props: {
        part: choicePart,
        chromeless: true,
        restoredFirstResult: restored,
        restoredSubmission: { kind: 'choice', selected: [0, 2] },
      },
    });

    expect(states(wrapper).at(-1)).toMatchObject({
      phase: 'reviewed',
      result: { verdict: 'incorrect' },
    });
    expect(wrapper.emitted('graded')).toBeUndefined();

    exposed(wrapper).submit();
    await nextTick();
    expect(states(wrapper).at(-1)).toMatchObject({
      phase: 'reviewed',
      result: { verdict: 'incorrect', awardedPoints: 0 },
    });
    expect(wrapper.emitted('graded')).toBeUndefined();
    expect(wrapper.emitted('corrected')).toBeUndefined();
    expect(wrapper.getComponent(AnswerControl).props('modelValue')).toEqual({
      kind: 'choice', selected: [0, 2],
    });
  });

  it('restores an uncommitted self-assessment draft without grading or losing the answer', async () => {
    const draft: PartPlayerDraft = {
      submission: { kind: 'open', text: 'Mein eigener Ansatz', selfAssessment: {} },
      assessment: { criteriaMet: [true], awardedPoints: 1, overall: 'full' },
      selectedPoints: 1,
      grading: 'careless',
      indeterminate: false,
      indeterminateMax: 1,
    };
    const wrapper = mount(PartPlayer, {
      props: { part: openPart, chromeless: true, restoredDraft: draft },
    });

    expect(states(wrapper).at(-1)).toMatchObject({
      phase: 'self-assessing',
      submittedText: 'Mein eigener Ansatz',
      selfAssessment: {
        selectedPoints: 1,
        grading: 'careless',
        assessment: { criteriaMet: [true] },
      },
    });
    expect(wrapper.emitted('graded')).toBeUndefined();
    expect(wrapper.emitted('draft')).toBeUndefined();

    exposed(wrapper).confirmSelfAssessment();
    await nextTick();
    expect((wrapper.emitted('graded')?.[0]?.[0] as GradedPayload).submission).toMatchObject({
      kind: 'open',
      text: 'Mein eigener Ansatz',
    });
  });
});

describe('PartPlayer (default, non-chromeless — legacy behavior)', () => {
  it('keeps its own button, key hint, VerdictCard and SolutionPanel', async () => {
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

    // verdict card + solution panel rendered by the player itself after grading
    const verdict = wrapper.find('.q-verdict');
    expect(verdict.exists()).toBe(true);
    expect(verdict.text()).toContain('Richtig');
    expect(wrapper.find('.q-solution').exists()).toBe(true);
    expect(wrapper.emitted('graded')).toHaveLength(1);
  });
});
