import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AiExplainPanel from '../src/practice/AiExplainPanel.vue';

/**
 * The panel that shows a machine's reading of the user's answer. Two things
 * matter most: it costs nothing until asked, and it never passes itself off as
 * the official solution.
 */
describe('AiExplainPanel', () => {
  it('starts as a single button and fetches nothing', () => {
    const wrapper = mount(AiExplainPanel);
    expect(wrapper.find('.q-aix__ask').text()).toBe('Warum?');
    expect(wrapper.find('.q-aix__body').exists()).toBe(false);
    expect(wrapper.find('.q-skeleton-list').exists()).toBe(false);
  });

  it('asks only when the user presses the button', async () => {
    const wrapper = mount(AiExplainPanel);
    expect(wrapper.emitted('ask')).toBeUndefined();
    await wrapper.get('.q-aix__ask').trigger('click');
    expect(wrapper.emitted('ask')).toHaveLength(1);
  });

  it('shows a placeholder shaped like the text that replaces it', () => {
    const wrapper = mount(AiExplainPanel, { props: { loading: true } });
    expect(wrapper.find('.q-skeleton-list').exists()).toBe(true);
    expect(wrapper.find('.q-aix__ask').exists()).toBe(false);
  });

  it('renders markdown, not raw source', () => {
    const wrapper = mount(AiExplainPanel, {
      props: { markdown: 'Du hast **falsch** gerechnet.' },
    });
    expect(wrapper.find('.q-aix__body strong').text()).toBe('falsch');
    expect(wrapper.text()).not.toContain('**');
  });

  it('renders KaTeX rather than dollar signs', () => {
    // The model is asked for formulas in $…$; showing them literally would be
    // worse than having no explanation.
    const wrapper = mount(AiExplainPanel, { props: { markdown: 'Es gilt $x = 4$.' } });
    expect(wrapper.find('.q-aix__body .katex').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('$x = 4$');
  });

  it('renders display math on its own line', () => {
    const wrapper = mount(AiExplainPanel, {
      props: { markdown: 'Also:\n\n$$a^2 + b^2 = c^2$$' },
    });
    expect(wrapper.find('.q-md__mathblock').exists()).toBe(true);
  });

  it('survives a malformed formula instead of blanking the panel', () => {
    const wrapper = mount(AiExplainPanel, { props: { markdown: 'Kaputt: $\\frac{1}{$.' } });
    expect(wrapper.find('.q-aix__body').exists()).toBe(true);
    expect(wrapper.text()).toContain('Kaputt');
  });

  it('always says it is machine-written and not authoritative', () => {
    const wrapper = mount(AiExplainPanel, { props: { markdown: 'Text.', model: 'gpt-5-mini' } });
    expect(wrapper.find('.q-aix__badge').text()).toBe('KI');
    const foot = wrapper.get('.q-aix__foot').text();
    expect(foot).toContain('kann Fehler enthalten');
    expect(foot).toContain('offizielle');
    expect(foot).toContain('gpt-5-mini');
  });

  it('offers a retry on failure without losing the panel', async () => {
    const wrapper = mount(AiExplainPanel, { props: { error: 'Die KI war nicht erreichbar.' } });
    expect(wrapper.get('[role="alert"]').text()).toContain('nicht erreichbar');
    await wrapper.get('.q-aix__ask--retry').trigger('click');
    expect(wrapper.emitted('ask')).toHaveLength(1);
  });

  it('can be dismissed once there is something to dismiss', async () => {
    const idle = mount(AiExplainPanel);
    expect(idle.find('.q-aix__dismiss').exists()).toBe(false);

    const answered = mount(AiExplainPanel, { props: { markdown: 'Text.' } });
    await answered.get('.q-aix__dismiss').trigger('click');
    expect(answered.emitted('dismiss')).toHaveLength(1);
  });

  it('names whose key paid for it', () => {
    const pool = mount(AiExplainPanel, { props: { markdown: 'x', model: 'm', source: 'pool' } });
    expect(pool.get('.q-aix__foot').text()).toContain('Kontingent');
    const byo = mount(AiExplainPanel, { props: { markdown: 'x', model: 'm', source: 'byo' } });
    expect(byo.get('.q-aix__foot').text()).toContain('eigener Schlüssel');
  });
});
