import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { OpenAnswer, OpenSubmission } from '@qed2/core-logic';
import OpenControl from '../src/question/OpenControl.vue';

const answer: OpenAnswer = {
  kind: 'open',
  rubric: [{ t: 'text', v: 'Nachvollziehbarer Rechenweg' }],
  grader: 'self',
};

function submission(text: string): OpenSubmission {
  return { kind: 'open', text, selfAssessment: {} };
}

describe('OpenControl', () => {
  it('inserts formula syntax at the current selection and keeps the plain-text contract', async () => {
    const wrapper = mount(OpenControl, {
      props: { answer, modelValue: submission('x+1') },
    });
    const textarea = wrapper.get<HTMLTextAreaElement>('textarea');
    textarea.element.setSelectionRange(0, 3);

    await wrapper.get('button[aria-label="Formel markieren ($…$)"]').trigger('click');

    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(submission('$x+1$'));
  });

  it('renders live math previews for formula-only and mixed prose answers', async () => {
    const wrapper = mount(OpenControl, {
      props: { answer, modelValue: submission('N = P/(0.75*1.2)') },
    });

    expect(wrapper.find('.q-open__preview .katex').exists()).toBe(true);

    await wrapper.setProps({ modelValue: submission('Damit gilt $x^2+1$.') });
    expect(wrapper.find('.q-open__preview').text()).toContain('Damit gilt');
    expect(wrapper.find('.q-open__preview .katex').exists()).toBe(true);
  });

  it('hides editing tools in review mode while retaining the rendered answer', () => {
    const wrapper = mount(OpenControl, {
      props: {
        answer,
        modelValue: submission('$x^2$'),
        result: {
          verdict: 'correct',
          correct: true,
          awardedPoints: 1,
          maxPoints: 1,
        },
      },
    });

    expect(wrapper.find('.q-open__toolbar').exists()).toBe(false);
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined();
    expect(wrapper.find('.q-open__preview .katex').exists()).toBe(true);
  });
});
