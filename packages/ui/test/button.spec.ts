import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import QButton from '../src/shared/QButton.vue';

import buttonSource from '../src/shared/QButton.vue?raw';

describe('QButton theme contract', () => {
  it('uses explicit transitions without hover movement', () => {
    expect(buttonSource).not.toContain('transition: all');
    expect(buttonSource).not.toContain('translateY(');
  });
  it('keeps the action label while busy and prevents a duplicate activation', async () => {
    const wrapper = mount(QButton, { props: { loading: true }, slots: { default: 'Speichern' } });
    expect(wrapper.attributes('aria-busy')).toBe('true');
    expect(wrapper.get('.q-btn__content').text()).toBe('Speichern');
    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toBeUndefined();
    await wrapper.setProps({ loading: false });
    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });
});
