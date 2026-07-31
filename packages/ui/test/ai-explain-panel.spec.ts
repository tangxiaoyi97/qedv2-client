import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AiExplainPanel from '../src/practice/AiExplainPanel.vue';

/**
 * The panel that shows a machine's reading of the user's answer. Two things
 * matter most: it costs nothing until asked, and it never passes itself off as
 * the official solution.
 */
describe('AiExplainPanel', () => {
  it('offers, rather than pretending to be an empty section', () => {
    // A heading with a rule above it and nothing underneath reads as content
    // that failed to load. Until the user asks, this is one row and no more.
    const wrapper = mount(AiExplainPanel);
    expect(wrapper.get('.q-aix__offer-label').text()).toBe('Warum?');
    expect(wrapper.find('.q-aix__title').exists()).toBe(false);
    expect(wrapper.find('.q-aix__body').exists()).toBe(false);
    expect(wrapper.find('.q-skeleton-list').exists()).toBe(false);
    expect(wrapper.get('.q-aix').classes()).toContain('q-aix--idle');
  });

  it('becomes a titled section only once there is something in it', () => {
    const answered = mount(AiExplainPanel, { props: { markdown: 'Text.' } });
    expect(answered.get('.q-aix__title').text()).toBe('Erklärung');
    expect(answered.find('.q-aix__offer').exists()).toBe(false);
    expect(answered.get('.q-aix').classes()).not.toContain('q-aix--idle');
  });

  it('asks only when the user presses the offer', async () => {
    const wrapper = mount(AiExplainPanel);
    expect(wrapper.emitted('ask')).toBeUndefined();
    await wrapper.get('.q-aix__offer').trigger('click');
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
    expect(foot).toContain('Generiert von KI');
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

  it('names the model only when the reader chose it', () => {
    // On the shared key the server picks the model; printing it tells the
    // user nothing they decided and leaks a deployment detail.
    const byo = mount(AiExplainPanel, { props: { markdown: 'x', model: 'gpt-5-mini', source: 'byo' } });
    expect(byo.get('.q-aix__foot').text()).toContain('gpt-5-mini');

    const pool = mount(AiExplainPanel, { props: { markdown: 'x', model: 'gemini-2.5-flash', source: 'pool' } });
    expect(pool.get('.q-aix__foot').text()).not.toContain('gemini');
    expect(pool.get('.q-aix__foot').text()).not.toContain('Kontingent');
    // The warning that it is machine-written stays either way.
    expect(pool.get('.q-aix__foot').text()).toContain('Generiert von KI');
  });
});
