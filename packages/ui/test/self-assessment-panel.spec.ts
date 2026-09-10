import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { SelfAssessment } from '@qed2/core-logic';
import SelfAssessmentPanel from '../src/question/SelfAssessmentPanel.vue';

describe('SelfAssessmentPanel', () => {
  it('replaces a previous zero-point assessment when the learner checks a criterion', async () => {
    const wrapper = mount(SelfAssessmentPanel, {
      props: { maxPoints: 3, scoring: { mode: 'rubric', criteria: [{ desc: 'Ansatz', points: 1 }, { desc: 'Rechnung', points: 2 }] }, modelValue: {} },
    });
    await wrapper.get('.q-selfassess__none').trigger('click');
    await wrapper.setProps({ modelValue: wrapper.emitted('update:modelValue')!.at(-1)![0] as SelfAssessment });
    await wrapper.get('.q-selfassess__criterion').trigger('click');
    await wrapper.setProps({ modelValue: wrapper.emitted('update:modelValue')!.at(-1)![0] as SelfAssessment });
    expect(wrapper.get('.q-selfassess__total').text()).toContain('1 / 3');
  });

  it('distinguishes an untouched assessment from an explicit zero and restores an overall selection', async () => {
    const wrapper = mount(SelfAssessmentPanel, { props: { maxPoints: 1, modelValue: {} } });
    expect(wrapper.findAll('[aria-checked="true"]')).toHaveLength(0);
    expect(wrapper.get('.q-selfassess__total').text()).toContain('– / 1');
    await wrapper.setProps({ modelValue: { awardedPoints: 0 } });
    expect(wrapper.get('[aria-checked="true"]').text()).toBe('0');
    expect(wrapper.get('.q-selfassess__total').text()).toContain('0 / 1');
    await wrapper.setProps({ modelValue: { overall: 'full' } });
    expect(wrapper.get('[aria-checked="true"]').text()).toBe('1');
  });

  it('shows one clear score label without repeating instructions', () => {
    const wrapper = mount(SelfAssessmentPanel, {
      props: {
        maxPoints: 1,
        modelValue: {},
      },
    });

    expect(wrapper.text()).not.toContain('Vergleiche mit der Lösung');
    expect(wrapper.text()).not.toContain('Meine Punkte');
    expect(wrapper.text().match(/Deine Punkte/gu)).toHaveLength(1);
    expect(wrapper.get('.q-selfassess__total').text()).toContain('– / 1');
  });
});
