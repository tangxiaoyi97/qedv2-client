import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { GRADING_HINTS, GRADING_LABELS, SELECTABLE_GRADINGS } from '@qed2/core-logic';
import GradingPicker from '../src/shared/GradingPicker.vue';
import { SELF_ASSESSMENT_GRADING_OPTIONS } from '../src/practice/self-assessment.js';

/**
 * The mastery states are named in one place. They used to be written out
 * three times — the popover, the self-assessment option list and this
 * picker — and the copies had already drifted apart in order.
 */
describe('grading vocabulary', () => {
  it('derives the self-assessment options from the shared source', () => {
    expect(SELF_ASSESSMENT_GRADING_OPTIONS.map((o) => o.grading)).toEqual([...SELECTABLE_GRADINGS]);
    for (const option of SELF_ASSESSMENT_GRADING_OPTIONS) {
      expect(option.label).toBe(GRADING_LABELS[option.grading]);
      expect(option.hint).toBe(GRADING_HINTS[option.grading]);
    }
  });

  it('never offers „unseen" — it is the absence of a record, not a choice', () => {
    expect(SELECTABLE_GRADINGS).not.toContain('unseen');
  });
});

describe('GradingPicker', () => {
  const mountPicker = (grading: (typeof SELECTABLE_GRADINGS)[number] | null = null) =>
    mount(GradingPicker, { props: { grading } });

  it('shows every state at once, each with its dot and its word', () => {
    const options = mountPicker().findAll('.q-gpick__opt');
    expect(options).toHaveLength(SELECTABLE_GRADINGS.length);
    options.forEach((option, i) => {
      const grading = SELECTABLE_GRADINGS[i]!;
      // Shape carries the meaning, colour only assists — but the word is
      // never dropped, so the cue is not icon-only either.
      expect(option.find('.q-grading-dot').exists()).toBe(true);
      expect(option.text()).toContain(GRADING_LABELS[grading]);
    });
  });

  it('marks exactly the current state as checked', () => {
    const wrapper = mountPicker('meh');
    const checked = wrapper
      .findAll('[role="radio"]')
      .filter((el) => el.attributes('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]!.text()).toContain(GRADING_LABELS.meh);
  });

  it('checks nothing until the user has picked', () => {
    const wrapper = mountPicker(null);
    expect(wrapper.findAll('[aria-checked="true"]')).toHaveLength(0);
  });

  it('emits the state that was pressed', async () => {
    const wrapper = mountPicker();
    await wrapper.findAll('.q-gpick__opt')[3]!.trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual([SELECTABLE_GRADINGS[3]]);
  });

  it('does not emit while disabled', async () => {
    const wrapper = mount(GradingPicker, { props: { grading: null, disabled: true } });
    await wrapper.findAll('.q-gpick__opt')[0]!.trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
  });
});
