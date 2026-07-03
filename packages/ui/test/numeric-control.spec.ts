import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { GradeResult, NumericAnswer } from '@qed2/core-logic';
import NumericControl from '../src/question/NumericControl.vue';

const multiAnswer: NumericAnswer = {
  kind: 'numeric',
  blanks: [
    { id: 'x1', value: -2, tol: 0.1 },
    { id: 'x2', value: 4.5, tol: 0.1, unit: 'cm' },
  ],
};

const singleAnswer: NumericAnswer = {
  kind: 'numeric',
  blanks: [{ id: 'f3', value: 1, tol: 0 }],
};

describe('NumericControl', () => {
  it('renders one decimal text input per blank with labels and unit chip', () => {
    const wrapper = mount(NumericControl, {
      props: { answer: multiAnswer, modelValue: { x1: '', x2: '' } },
    });
    const inputs = wrapper.findAll('input');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.attributes('type')).toBe('text'); // NOT type=number
      expect(input.attributes('inputmode')).toBe('decimal');
    }
    // labels only in multi-blank mode
    const labels = wrapper.findAll('label');
    expect(labels).toHaveLength(2);
    expect(labels[0]!.text()).toBe('x1 =');
    expect(labels[1]!.text()).toBe('x2 =');
    // unit chip only where declared
    expect(wrapper.find('.q-numeric__unit').exists()).toBe(true);
    expect(wrapper.find('.q-numeric__unit').text()).toBe('cm');
    // hint line
    expect(wrapper.text()).toContain('Komma oder Punkt erlaubt · Tab wechselt Felder');
  });

  it('renders a single blank without label, full-width', () => {
    const wrapper = mount(NumericControl, {
      props: { answer: singleAnswer, modelValue: { f3: '' } },
    });
    expect(wrapper.findAll('input')).toHaveLength(1);
    expect(wrapper.findAll('label')).toHaveLength(0);
    expect(wrapper.find('.q-numeric__unit').exists()).toBe(false);
  });

  it('passes raw decimal input through unchanged (comma AND point, no normalization)', async () => {
    const wrapper = mount(NumericControl, {
      props: { answer: multiAnswer, modelValue: { x1: '', x2: '' } },
    });
    const inputs = wrapper.findAll('input');

    await inputs[0]!.setValue('3,14');
    expect(wrapper.emitted('update:modelValue')![0]![0]).toEqual({ x1: '3,14', x2: '' });

    await wrapper.setProps({ modelValue: { x1: '3,14', x2: '' } });
    await inputs[1]!.setValue('-2.5');
    const events = wrapper.emitted('update:modelValue')!;
    expect(events[events.length - 1]![0]).toEqual({ x1: '3,14', x2: '-2.5' });
  });

  it('marks blanks per breakdown in review mode with the expected value on error', () => {
    const result: GradeResult = {
      verdict: 'partial',
      correct: false,
      awardedPoints: 1,
      maxPoints: 2,
      breakdown: [
        { ref: 'x1', correct: true },
        { ref: 'x2', correct: false, note: 'out-of-tolerance' },
      ],
    };
    const wrapper = mount(NumericControl, {
      props: { answer: multiAnswer, modelValue: { x1: '-2', x2: '9' }, result },
    });
    const inputs = wrapper.findAll('input');
    expect(inputs[0]!.classes()).toContain('q-numeric__input--ok');
    expect(inputs[1]!.classes()).toContain('q-numeric__input--err');
    // read-only
    expect(inputs[0]!.attributes('disabled')).toBeDefined();
    expect(inputs[1]!.attributes('disabled')).toBeDefined();
    // icon + text, never color-only
    expect(wrapper.text()).toContain('Richtig');
    expect(wrapper.text()).toContain('Falsch');
    // expected value with unit + tolerance, German comma (de-AT)
    expect(wrapper.find('.q-numeric__expected').exists()).toBe(true);
    expect(wrapper.find('.q-numeric__expected').text()).toContain('Richtig: 4,5 cm (±0,1)');
    // hint hidden in review
    expect(wrapper.text()).not.toContain('Tab wechselt Felder');
  });
});
