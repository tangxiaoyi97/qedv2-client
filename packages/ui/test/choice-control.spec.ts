import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { ChoiceAnswer, GradeResult } from '@qed2/core-logic';
import ChoiceControl from '../src/question/ChoiceControl.vue';

const answer: ChoiceAnswer = {
  kind: 'choice',
  options: [
    [{ t: 'text', v: 'Der Scheitelpunkt liegt bei ' }, { t: 'math', v: 'S=(2\\,|\\,-3)' }],
    [{ t: 'text', v: 'Die Funktion hat keine reellen Nullstellen.' }],
    [{ t: 'text', v: 'Der Graph ist nach oben geöffnet.' }],
    [{ t: 'text', v: 'Es gilt ' }, { t: 'math', v: 'f(0)=-3' }],
    [{ t: 'text', v: 'Streng monoton steigend.' }],
  ],
  correct: [0, 3],
  selectCount: 2,
};

const singleAnswer: ChoiceAnswer = { ...answer, correct: [2], selectCount: 1 };

function lastEmitted(wrapper: ReturnType<typeof mount>): unknown {
  const events = wrapper.emitted('update:modelValue');
  return events ? events[events.length - 1]![0] : undefined;
}

describe('ChoiceControl', () => {
  it('renders the "N aus M" chip, the singular-aware hint and lettered options', () => {
    const wrapper = mount(ChoiceControl, {
      props: { answer, modelValue: [0] },
    });
    expect(wrapper.text()).toContain('2 aus 5');
    expect(wrapper.text()).toContain('Wähle genau 2 Antworten');
    expect(wrapper.text()).toContain('1 gewählt');
    const options = wrapper.findAll('button.q-choice__opt');
    expect(options).toHaveLength(5);
    expect(options[0]!.text()).toContain('A');
    expect(options[4]!.text()).toContain('E');
    // KaTeX rendered inside option content
    expect(options[0]!.find('.katex').exists()).toBe(true);

    const single = mount(ChoiceControl, {
      props: { answer: singleAnswer, modelValue: [] },
    });
    expect(single.text()).toContain('Wähle genau 1 Antwort');
    expect(single.text()).toContain('0 gewählt');
  });

  it('selects up to the cap and ignores further picks of unselected options', async () => {
    const wrapper = mount(ChoiceControl, {
      props: { answer, modelValue: [] },
    });
    const options = wrapper.findAll('button.q-choice__opt');

    await options[0]!.trigger('click');
    expect(lastEmitted(wrapper)).toEqual([0]);

    await wrapper.setProps({ modelValue: [0] });
    await options[3]!.trigger('click');
    expect(lastEmitted(wrapper)).toEqual([0, 3]);

    // cap reached: clicking an unselected option is ignored…
    await wrapper.setProps({ modelValue: [0, 3] });
    const before = wrapper.emitted('update:modelValue')!.length;
    await options[1]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')!.length).toBe(before);
    // …and the unselected rest is aria-disabled as a cap hint
    expect(options[1]!.attributes('aria-disabled')).toBe('true');
    expect(options[0]!.attributes('aria-disabled')).toBeUndefined();

    // clicking a selected option still toggles it off
    await options[0]!.trigger('click');
    expect(lastEmitted(wrapper)).toEqual([3]);
  });

  it('replaces the selection when selectCount === 1 (radio semantics)', async () => {
    const wrapper = mount(ChoiceControl, {
      props: { answer: singleAnswer, modelValue: [2] },
    });
    const options = wrapper.findAll('button.q-choice__opt');
    expect(options[2]!.attributes('aria-pressed')).toBe('true');
    expect(options[4]!.attributes('aria-pressed')).toBe('false');

    await options[4]!.trigger('click');
    expect(lastEmitted(wrapper)).toEqual([4]);

    // radio circle, not checkbox square
    expect(wrapper.find('.q-choice__box--radio').exists()).toBe(true);
  });

  it('marks options from result.breakdown in review mode and becomes read-only', async () => {
    const result: GradeResult = {
      verdict: 'partial',
      correct: false,
      awardedPoints: 0.5,
      maxPoints: 1,
      breakdown: [
        { ref: '0', correct: true, note: 'correct-pick' },
        { ref: '1', correct: true },
        { ref: '2', correct: true },
        { ref: '3', correct: false, note: 'missed' },
        { ref: '4', correct: false, note: 'wrong-pick' },
      ],
    };
    const wrapper = mount(ChoiceControl, {
      props: { answer, modelValue: [0, 4], result },
    });
    const options = wrapper.findAll('button.q-choice__opt');

    expect(options[0]!.text()).toContain('Richtig · gewählt');
    expect(options[0]!.classes()).toContain('q-choice__opt--ok');
    expect(options[4]!.text()).toContain('Falsch · gewählt');
    expect(options[4]!.classes()).toContain('q-choice__opt--err');
    expect(options[3]!.text()).toContain('Richtig · verpasst');
    expect(options[3]!.classes()).toContain('q-choice__opt--missed');
    // untouched-incorrect options stay plain
    expect(options[1]!.classes()).not.toContain('q-choice__opt--ok');
    expect(options[1]!.classes()).not.toContain('q-choice__opt--err');
    expect(options[1]!.classes()).not.toContain('q-choice__opt--missed');

    // read-only: clicks emit nothing
    await options[1]!.trigger('click');
    await options[0]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(options[0]!.attributes('aria-disabled')).toBe('true');
  });
});
