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

  it('sends an unconfigured user to setup without making a paid grading request', async () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: LABELS, needsSetup: true } });
    expect(wrapper.text()).toBe('KI einrichten');
    await wrapper.get('.q-aia__ask').trigger('click');
    expect(wrapper.emitted('setup')).toHaveLength(1);
    expect(wrapper.emitted('ask')).toBeUndefined();
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

  it('renders criterion evidence as safe Markdown and math without accepting the AI verdict', () => {
    const wrapper = mount(AiAssessPanel, {
      props: {
        labels: LABELS,
        studentCriteria: [false],
        criteria: [crit({
          quote: String.raw`$x = \frac{1}{2}$`,
          reason: '**Begründung:** Der Ansatz ergibt\n\n$$x = 0.5$$',
          quoteVerified: false,
        })],
      },
    });
    expect(wrapper.get('.q-aia__quote').find('.katex').exists()).toBe(true);
    expect(wrapper.get('.q-aia__reason').get('strong').text()).toBe('Begründung:');
    expect(wrapper.get('.q-aia__reason').find('.katex-display').exists()).toBe(true);
    expect(wrapper.get('.q-aia__quote-warn').text()).toBe('nicht wörtlich gefunden');
    expect(wrapper.get('.q-aia__quote').classes()).toContain('q-aia__quote--unverified');
    expect(wrapper.get('.q-aia__evidence').attributes()).toHaveProperty('open');
    expect(wrapper.get('.q-aia__summary').text()).toContain('1 Abweichung');
    expect(wrapper.emitted()).toEqual({});
  });

  it('renders overall evidence while keeping unverified points advisory', () => {
    const wrapper = mount(AiAssessPanel, {
      props: {
        labels: [],
        studentPoints: 0,
        maxPoints: 2,
        overall: {
          points: 1,
          confidence: 0.95,
          quote: String.raw`$a^2 + b^2 = c^2$`,
          reason: '**Teilweise richtig:** Es fehlt $c = 5$.',
          quoteVerified: false,
        },
      },
    });
    expect(wrapper.get('.q-aia__quote').find('.katex').exists()).toBe(true);
    expect(wrapper.get('.q-aia__reason').get('strong').text()).toBe('Teilweise richtig:');
    expect(wrapper.get('.q-aia__reason').find('.katex').exists()).toBe(true);
    expect(wrapper.get('.q-aia__criterion').text()).toBe('Vorschlag: 1 / 2 P');
    expect(wrapper.get('.q-aia__quote-warn').text()).toBe('nicht wörtlich gefunden');
    expect(wrapper.get('.q-aia__overall').classes()).toContain('q-aia__item--shaky');
    expect(wrapper.get('.q-aia__evidence').attributes()).toHaveProperty('open');
    expect(wrapper.get('.q-aia__foot').text()).toBe('Bitte selbst bestätigen.');
    expect(wrapper.emitted()).toEqual({});
  });

  it('keeps HTML and executable links inert inside quoted evidence and reasons', () => {
    const wrapper = mount(AiAssessPanel, {
      props: {
        labels: LABELS,
        criteria: [crit({
          quote: '<img src=x onerror="alert(1)"> $x = 4$',
          reason: '<script>alert(1)</script> [unsafe](javascript:alert(1)) **Kontrollieren**',
        })],
      },
    });
    expect(wrapper.find('img, script, [onerror], [onclick], a[href^="javascript:"]').exists()).toBe(false);
    expect(wrapper.get('.q-aia__quote').text()).toContain('<img');
    expect(wrapper.get('.q-aia__reason').get('strong').text()).toBe('Kontrollieren');
    expect(wrapper.find('.q-aia__quote-warn').exists()).toBe(false);
    expect(wrapper.emitted()).toEqual({});
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
    expect(wrapper.get('.q-aia__evidence').attributes()).not.toHaveProperty('open');
  });

  it('keeps normal evidence collapsed but opens evidence that needs review', () => {
    const wrapper = mount(AiAssessPanel, {
      props: {
        labels: LABELS,
        criteria: [crit(), crit({ index: 1, confidence: 0.4 })],
      },
    });
    const evidence = wrapper.findAll('.q-aia__evidence');
    expect(evidence[0]!.attributes()).not.toHaveProperty('open');
    expect(evidence[1]!.attributes()).toHaveProperty('open');
    expect(wrapper.get('.q-aia__summary').text()).toContain('2 Abweichungen');
  });

  it('keeps the student decision authoritative', () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: LABELS, criteria: [crit()] } });
    expect(wrapper.get('.q-aia__foot').text()).toContain('selbst bestätigen');
    expect(wrapper.emitted()).toEqual({});
  });

  it('explains itself when the server refused to vouch for the reply', () => {
    const wrapper = mount(AiAssessPanel, {
      props: { labels: LABELS, criteria: [crit()], advisoryOnly: true },
    });
    expect(wrapper.get('.q-aia__head-text').text()).toContain('Nur als Hinweis');
    expect(wrapper.get('.q-aia__foot').text()).toBe('Bitte selbst bestätigen.');
    expect(wrapper.emitted()).toEqual({});
  });

  it('always identifies itself as a machine', () => {
    // The shared AiBadge, not a local chip: this mark also sits beside the
    // official Lösungsweg, and the two must be the same object so they cannot
    // drift into looking like different things.
    const idle = mount(AiAssessPanel, { props: { labels: LABELS } });
    expect(idle.get('.q-aibadge').text()).toBe('KI');
    const done = mount(AiAssessPanel, { props: { labels: LABELS, criteria: [crit()] } });
    expect(done.get('.q-aibadge').text()).toBe('KI');
  });

  it('offers a retry after a failure', async () => {
    const wrapper = mount(AiAssessPanel, {
      props: { labels: LABELS, error: 'Die KI war nicht erreichbar.' },
    });
    expect(wrapper.get('[role="alert"]').text()).toContain('nicht erreichbar');
    await wrapper.get('.q-aia__error .q-btn').trigger('click');
    expect(wrapper.emitted('ask')).toHaveLength(1);
  });

  it('falls back to a numbered label if the rubric text is missing', () => {
    const wrapper = mount(AiAssessPanel, { props: { labels: [], criteria: [crit({ index: 1 })] } });
    expect(wrapper.get('.q-aia__criterion').text()).toBe('Kriterium 2');
  });

  it('shows only disagreements after the learner assessed first', () => {
    const wrapper = mount(AiAssessPanel, {
      props: {
        labels: LABELS,
        studentCriteria: [true, false],
        criteria: [crit({ index: 0, met: true }), crit({ index: 1, met: true })],
      },
    });
    expect(wrapper.findAll('.q-aia__item')).toHaveLength(1);
    expect(wrapper.get('.q-aia__criterion').text()).toBe('Rechenweg gezeigt');
    expect(wrapper.get('.q-aia__summary').text()).toContain('1 Abweichung');
  });

  it('uses a compact agreement state when there is no difference', () => {
    const wrapper = mount(AiAssessPanel, {
      props: {
        labels: LABELS,
        studentCriteria: [true],
        criteria: [crit({ index: 0, met: true })],
      },
    });
    expect(wrapper.find('.q-aia__item').exists()).toBe(false);
    expect(wrapper.get('.q-aia__same').text()).toContain('stimmen überein');
  });
});
