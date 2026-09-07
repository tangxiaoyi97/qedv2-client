import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SelfAssessmentPanel from '../src/question/SelfAssessmentPanel.vue';

describe('SelfAssessmentPanel', () => {
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
    expect(wrapper.get('.q-selfassess__total').text()).toContain('0 / 1');
  });
});
