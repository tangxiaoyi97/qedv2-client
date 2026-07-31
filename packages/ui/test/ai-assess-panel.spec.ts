import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AiAssessPanel, { type AssessedCriterion } from '../src/practice/AiAssessPanel.vue';

/**
 * The panel that puts a machine's verdict next to a human's decision. What it
 * must never do is look authoritative — the grade feeds the FSRS schedule, so
 * a wrong tick distorts months of revision without anyone noticing.
 */
const LABELS = ['x korrekt berechnet', 'Rechenweg gezeigt'];

const crit = (over: Partial<AssessedCriterion> = {}): AssessedCriterion => ({
  index: 0,
  met: true,
  confidence: 0.9,
  quote: 'x = 4',
  reason: 'korrekt eingesetzt',
  quoteVerified: true,
  ...over,
});

describe('AiAssessPanel', () => {
  it('costs nothing until asked', () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: LABELS } });
    expect(wrapper.find('.q-aia__ask').exists()).toBe(true);
    expect(wrapper.find('.q-aia__list').exists()).toBe(false);
  });

  it('emits ask on the button, and only then', async () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: LABELS } });
    expect(wrapper.emitted('ask')).toBeUndefined();
    await wrapper.get('.q-aia__ask').trigger('click');
    expect(wrapper.emitted('ask')).toHaveLength(1);
  });

  it('shows the criterion text, the quote and the confidence', () => {
    const wrapper = mount(AiAssessPanel, {
      props: { labels: LABELS, criteria: [crit()], model: 'gpt-5-mini' },
    });
    const item = wrapper.get('.q-aia__item');
    expect(item.text()).toContain('x korrekt berechnet');
    expect(item.text()).toContain('x = 4');
    expect(item.text()).toContain('90%');
  });

  it('marks a quote it could not find in the answer', () => {
    // This is the failure that would otherwise inflate a grade: words the
    // model produced that the student never wrote.
    const wrapper = mount(AiAssessPanel, {
      props: { labels: LABELS, criteria: [crit({ quoteVerified: false })] },
    });
    expect(wrapper.get('.q-aia__quote-warn').text()).toContain('nicht wörtlich');
    expect(wrapper.get('.q-aia__item').classes()).toContain('q-aia__item--shaky');
  });

  it('flags a low-confidence verdict for a human to look at', () => {
    const wrapper = mount(AiAssessPanel, {
      props: { labels: LABELS, criteria: [crit({ confidence: 0.4 })] },
    });
    expect(wrapper.get('.q-aia__item').classes()).toContain('q-aia__item--shaky');
  });

  it('leaves a confident, evidenced verdict unflagged', () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: LABELS, criteria: [crit()] } });
    expect(wrapper.get('.q-aia__item').classes()).not.toContain('q-aia__item--shaky');
  });

  it('says the ticks are not saved yet', () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: LABELS, criteria: [crit()] } });
    expect(wrapper.get('.q-aia__foot').text()).toContain('nicht gespeichert');
    expect(wrapper.get('.q-aia__foot').text()).toContain('Bewertung übernehmen');
  });

  it('explains itself when the server refused to vouch for the reply', () => {
    const wrapper = mount(AiAssessPanel, {
      props: { labels: LABELS, criteria: [crit()], advisoryOnly: true },
    });
    expect(wrapper.get('.q-aia__head-text').text()).toContain('Nur als Hinweis');
    expect(wrapper.get('.q-aia__foot').text()).toContain('Nichts wurde vorausgewählt');
  });

  it('always identifies itself as a machine', () => {
    const idle = mount(AiAssessPanel, { props: { labels: LABELS } });
    expect(idle.get('.q-aia__badge').text()).toBe('KI');
    const done = mount(AiAssessPanel, { props: { labels: LABELS, criteria: [crit()] } });
    expect(done.get('.q-aia__badge').text()).toBe('KI');
  });

  it('offers a retry after a failure', async () => {
    const wrapper = mount(AiAssessPanel, {
      props: { labels: LABELS, error: 'Die KI war nicht erreichbar.' },
    });
    expect(wrapper.get('[role="alert"]').text()).toContain('nicht erreichbar');
    await wrapper.get('.q-aia__retry').trigger('click');
    expect(wrapper.emitted('ask')).toHaveLength(1);
  });

  it('falls back to a numbered label if the rubric text is missing', () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: [], criteria: [crit({ index: 1 })] } });
    expect(wrapper.get('.q-aia__criterion').text()).toBe('Kriterium 2');
  });
});
