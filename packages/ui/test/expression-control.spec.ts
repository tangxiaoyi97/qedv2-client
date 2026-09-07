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
  it('keeps the notation hint compact', () => {
    const wrapper = mount(ExpressionControl, {
      props: { answer, modelValue: '' },
    });

    expect(wrapper.get('.q-expr__hint').text()).toBe('^ · * · / · sqrt() · , oder .');
    expect(wrapper.find('[aria-label="Potenz einfügen"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Wurzel einfügen"]').exists()).toBe(true);
  });
});
