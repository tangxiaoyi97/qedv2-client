import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { ExpressionAnswer } from '@qed2/core-logic';
import ExpressionControl from '../src/question/ExpressionControl.vue';

const answer: ExpressionAnswer = {
  kind: 'expression',
  canonical: 'x',
  vars: ['x'],
  checker: 'cas',
};

describe('ExpressionControl', () => {
  it('uses a native full-keyboard input without symbol controls or hints', () => {
    const wrapper = mount(ExpressionControl, {
      props: { answer, modelValue: '' },
    });

    expect(wrapper.find('[role="toolbar"]').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.get('input').attributes('inputmode')).toBe('text');
    expect(wrapper.get('input').attributes('autocorrect')).toBe('off');
  });

  it('preserves pasted notation and does not publish unfinished IME composition', async () => {
    const wrapper = mount(ExpressionControl, { props: { answer, modelValue: '' } });
    const input = wrapper.get<HTMLInputElement>('input');
    input.element.value = '−2,5*x + sqrt(3)';
    input.element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await input.trigger('compositionend');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['−2,5*x + sqrt(3)']);
  });
});
