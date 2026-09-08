import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { IntervalAnswer, IntervalSubmission } from '@qed2/core-logic';
import IntervalControl from '../src/question/IntervalControl.vue';

const answer: IntervalAnswer = {
  kind: 'interval',
  lower: -12,
  upper: -8,
  lowerClosed: true,
  upperClosed: false,
};

const modelValue: IntervalSubmission = {
  kind: 'interval',
  lower: '-12',
  upper: '-8',
  lowerClosed: false,
  upperClosed: false,
};

describe('IntervalControl', () => {
  it('uses one interval row with accessible unbounded placeholders', () => {
    const wrapper = mount(IntervalControl, {
      props: { answer, modelValue, showPreview: true },
    });

    expect(wrapper.find('.q-interval__hint').exists()).toBe(false);
    expect(wrapper.findAll('input').map(input => input.attributes('placeholder'))).toEqual(['−∞', '∞']);
  });

  it('retains open and closed interval semantics through native bracket selectors', async () => {
    const wrapper = mount(IntervalControl, {
      props: { answer, modelValue },
    });

    const toggles = wrapper.findAll('select');
    expect(toggles).toHaveLength(2);
    expect(toggles[0]!.findAll('option').map((option) => option.text())).toEqual(['(', '[']);
    expect(toggles[1]!.findAll('option').map((option) => option.text())).toEqual([']', ')']);

    await toggles[1]!.setValue('true');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      ...modelValue,
      upperClosed: true,
    });

    await toggles[1]!.setValue('false');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      ...modelValue,
      upperClosed: false,
    });
  });
});
