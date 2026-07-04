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
  it('renders bracket toggles in interval notation order: ([ input ; input ])', async () => {
    const wrapper = mount(IntervalControl, {
      props: { answer, modelValue },
    });

    const toggles = wrapper.findAll('.q-interval__toggle');
    expect(toggles).toHaveLength(2);
    expect(toggles[0]!.findAll('button').map((button) => button.text())).toEqual(['(', '[']);
    expect(toggles[1]!.findAll('button').map((button) => button.text())).toEqual([']', ')']);

    await toggles[1]!.findAll('button')[0]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      ...modelValue,
      upperClosed: true,
    });

    await toggles[1]!.findAll('button')[1]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      ...modelValue,
      upperClosed: false,
    });
  });
});
