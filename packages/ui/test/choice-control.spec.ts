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
  it('does not pick an option while swiping its formula, but accepts the next deliberate tap', async () => {
    const wrapper = mount(ChoiceControl, { props: { answer, modelValue: [] } });
    const option = wrapper.get('button.q-choice__opt');
    await option.trigger('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 150, clientY: 100 });
    await option.trigger('pointermove', { pointerId: 1, clientX: 95, clientY: 103 });
    await option.trigger('pointerup', { pointerId: 1, clientX: 95, clientY: 103 });
    option.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await option.trigger('pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100 });
    await option.trigger('pointerup', { pointerId: 2, clientX: 102, clientY: 101 });
    option.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(lastEmitted(wrapper)).toEqual([0]);
  });

  it('keeps native text selection from changing the answer and preserves keyboard activation', async () => {
    const wrapper = mount(ChoiceControl, { attachTo: document.body, props: { answer, modelValue: [] } });
    const option = wrapper.get('button.q-choice__opt');
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(option.get('.q-choice__content').element);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      option.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(wrapper.emitted('update:modelValue')).toBeUndefined();
      option.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      expect(lastEmitted(wrapper)).toEqual([0]);
    } finally {
      selection.removeAllRanges();
      wrapper.unmount();
    }
  });

  it('ignores the trailing click from a cancelled touch gesture', async () => {
    const wrapper = mount(ChoiceControl, { props: { answer, modelValue: [] } });
    const option = wrapper.get('button.q-choice__opt');
    await option.trigger('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100 });
    await option.trigger('pointercancel');
    option.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('renders one count chip, a compact selection status and lettered options', () => {
    const wrapper = mount(ChoiceControl, {
      props: { answer, modelValue: [0] },
    });
    expect(wrapper.text()).toContain('2 aus 5');
    expect(wrapper.text()).not.toContain('Wähle genau');
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
    expect(single.text()).toContain('1 aus 5');
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
    // Keep the visible cap hint short without losing the spoken recovery
    // instruction when a learner tries to select an extra answer.
    const status = wrapper.get('[role="status"]');
    expect(status.get('[aria-hidden="true"]').text()).toBe('Maximal 2');
    expect(status.get('.q-choice__sr-only').text()).toBe('Maximal 2 — erst eine abwählen');

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

    // Verdict word only — picked vs. missed is carried by the row's own
    // styling (solid/filled vs. dashed), so the label must not repeat it.
    expect(options[0]!.text()).toContain('Richtig');
    expect(options[0]!.get('.q-choice__mark-label').attributes('aria-hidden')).toBeUndefined();
    expect(options[0]!.text()).not.toContain('gewählt');
    expect(options[0]!.classes()).toContain('q-choice__opt--ok');
    expect(options[4]!.text()).toContain('Falsch');
    expect(options[4]!.text()).not.toContain('gewählt');
    expect(options[4]!.classes()).toContain('q-choice__opt--err');
    expect(options[3]!.text()).toContain('Richtig');
    expect(options[3]!.text()).not.toContain('verpasst');
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
