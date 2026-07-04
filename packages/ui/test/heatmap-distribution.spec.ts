import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import type { Grading, SolutionEntry } from '@qed2/core-logic';
import ActivityHeatmap from '../src/review/ActivityHeatmap.vue';
import GradingDistribution from '../src/review/GradingDistribution.vue';
import SolutionSheet from '../src/practice/SolutionSheet.vue';
import { provideAssetResolver } from '../src/shared/assets.js';

describe('ActivityHeatmap', () => {
  // 2026-07-02 is a Thursday; 6 week columns ending there:
  // Mondays 25.05. … 29.06., last column truncated after Thursday.
  const props = {
    endDate: '2026-07-02',
    weeks: 6,
    data: {
      '2026-07-02': 3, // bucket 2 (2–3)
      '2026-07-01': 1, // bucket 1
      '2026-06-29': 7, // bucket 4 (7+)
      '2026-06-25': 5, // bucket 3 (4–6)
    },
  };

  it('renders one cell per day up to endDate (Mon-top weeks)', () => {
    const w = mount(ActivityHeatmap, { props });
    // 5 full weeks + Mon..Thu of the last week
    expect(w.findAll('.q-heat__cell')).toHaveLength(5 * 7 + 4);
  });

  it('assigns intensity bucket classes (0 / 1 / 2-3 / 4-6 / 7+)', () => {
    const w = mount(ActivityHeatmap, { props });
    expect(w.findAll('.q-heat__cell--b1')).toHaveLength(1);
    expect(w.findAll('.q-heat__cell--b2')).toHaveLength(1);
    expect(w.findAll('.q-heat__cell--b3')).toHaveLength(1);
    expect(w.findAll('.q-heat__cell--b4')).toHaveLength(1);
    expect(w.findAll('.q-heat__cell--b0')).toHaveLength(39 - 4);
    // zero-count cells render the track base only, no accent overlay
    expect(w.findAll('.q-heat__cell .q-heat__fill')).toHaveLength(4);
  });

  it('labels months (de-AT) and weekdays Mo/Mi/Fr, with German tooltips', () => {
    const w = mount(ActivityHeatmap, { props });
    const months = w.findAll('.q-heat__month').map((t) => t.text());
    expect(months).toContain('Juni'); // month change at the 01.06. column
    const weekdays = w.findAll('.q-heat__weekday').map((t) => t.text());
    expect(weekdays).toEqual(['Mo', 'Mi', 'Fr']);
    const titles = w.findAll('title').map((t) => t.text());
    expect(titles).toContain('3 Aufgaben · 02.07.2026');
    expect(titles).toContain('1 Aufgabe · 01.07.2026'); // singular
    expect(titles).toContain('0 Aufgaben · 30.06.2026');
  });

  it('shows month labels at later month starts across a longer range', () => {
    const w = mount(ActivityHeatmap, {
      props: { endDate: '2026-07-02', weeks: 10, data: {} },
    });
    const months = w.findAll('.q-heat__month').map((t) => t.text());
    expect(months).toEqual(['Mai', 'Juni']);
  });

  it('renders the legend row Weniger … Mehr with 5 swatches', () => {
    const w = mount(ActivityHeatmap, { props });
    expect(w.text()).toContain('Weniger');
    expect(w.text()).toContain('Mehr');
    expect(w.findAll('.q-heat__swatch')).toHaveLength(5);
  });
});

describe('GradingDistribution', () => {
  const counts = (over: Partial<Record<Grading, number>> = {}): Record<Grading, number> => ({
    good: 0,
    careless: 0,
    meh: 0,
    baffled: 0,
    excluded: 0,
    ...over,
  });

  it('renders proportional segments in state order, skipping zeros', () => {
    const w = mount(GradingDistribution, {
      props: { counts: counts({ good: 2, baffled: 1 }) },
    });
    const segs = w.findAll('.q-dist__seg');
    expect(segs).toHaveLength(2); // zero states skipped
    expect(segs[0]!.classes()).toContain('q-dist__seg--good');
    expect(segs[1]!.classes()).toContain('q-dist__seg--baffled');
    const lengthOf = (s: (typeof segs)[number]) =>
      Number.parseFloat((s.attributes('stroke-dasharray') ?? '').split(' ')[0] ?? '0');
    const good = lengthOf(segs[0]!);
    const baffled = lengthOf(segs[1]!);
    expect(good).toBeGreaterThan(baffled); // 2 good vs 1 baffled
    expect(good / (good + baffled)).toBeCloseTo(2 / 3, 3);
    expect(baffled / (good + baffled)).toBeCloseTo(1 / 3, 3);
  });

  it('renders a full track donut when the total is 0', () => {
    const w = mount(GradingDistribution, { props: { counts: counts() } });
    expect(w.find('.q-dist__track').exists()).toBe(true);
    expect(w.findAll('.q-dist__seg')).toHaveLength(0);
  });

  it('shows a legend row per state with GradingDot, German label and count', () => {
    const w = mount(GradingDistribution, {
      props: { counts: counts({ good: 2, baffled: 1 }) },
    });
    const items = w.findAll('.q-dist__item');
    expect(items).toHaveLength(5); // no unseen prop → no unseen row
    expect(w.findAll('.q-grading-dot')).toHaveLength(5);
    expect(w.text()).toContain('Gut');
    expect(w.text()).toContain('Ausgeschlossen');
    expect(w.text()).not.toContain('Neu');
    expect(items[0]!.text()).toContain('2');
    expect(items[3]!.text()).toContain('1');
  });

  it('includes an unseen row and segment when the prop is provided', () => {
    const w = mount(GradingDistribution, {
      props: { counts: counts({ good: 1 }), unseen: 3 },
    });
    const items = w.findAll('.q-dist__item');
    expect(items).toHaveLength(6);
    expect(items[5]!.text()).toContain('Neu');
    expect(items[5]!.text()).toContain('3');
    const segs = w.findAll('.q-dist__seg');
    expect(segs).toHaveLength(2);
    expect(segs[1]!.classes()).toContain('q-dist__seg--unseen');
    const lengths = segs.map((s) =>
      Number.parseFloat((s.attributes('stroke-dasharray') ?? '').split(' ')[0] ?? '0'),
    );
    expect(lengths[0]! / (lengths[0]! + lengths[1]!)).toBeCloseTo(0.25, 3);
    expect(lengths[1]! / (lengths[0]! + lengths[1]!)).toBeCloseTo(0.75, 3);
  });

  it('emits selected state from chart and legend', async () => {
    const w = mount(GradingDistribution, {
      props: { counts: counts({ good: 2, baffled: 1 }) },
    });
    await w.find('.q-dist__seg--good').trigger('click');
    await w.findAll('.q-dist__item-button')[3]!.trigger('click');
    expect(w.emitted('select')).toEqual([['good'], ['baffled']]);
  });

  it('links chart hover/focus with legend hover/focus highlighting', async () => {
    const w = mount(GradingDistribution, {
      props: { counts: counts({ good: 2, baffled: 1 }) },
    });
    const goodSeg = w.find('.q-dist__seg--good');
    const baffledSeg = w.find('.q-dist__seg--baffled');
    const buttons = w.findAll('.q-dist__item-button');

    await goodSeg.trigger('pointerenter');
    expect(goodSeg.classes()).toContain('q-dist__seg--active');
    expect(baffledSeg.classes()).toContain('q-dist__seg--dimmed');
    expect(buttons[0]!.classes()).toContain('q-dist__item-button--active');
    expect(buttons[3]!.classes()).toContain('q-dist__item-button--dimmed');

    await goodSeg.trigger('pointerleave');
    expect(w.find('.q-dist').classes()).not.toContain('q-dist--has-active');

    await buttons[3]!.trigger('pointerenter');
    expect(w.find('.q-dist__seg--baffled').classes()).toContain('q-dist__seg--active');
    expect(w.find('.q-dist__seg--good').classes()).toContain('q-dist__seg--dimmed');
    expect(buttons[3]!.classes()).toContain('q-dist__item-button--active');
  });
});

describe('SolutionSheet', () => {
  const solution: SolutionEntry[] = [
    {
      result: [
        { t: 'text', v: 'Zutreffend: ' },
        { t: 'math', v: 'a\\cdot b' },
      ],
      note: '[0 / 1 Punkt] Ein Punkt ist genau dann zu geben, wenn …',
      figures: [{ kind: 'image', src: 'assets/fig/loesung.png', alt: 'Lösungsabbildung' }],
    },
    {
      result: [{ t: 'text', v: 'Alternativer Weg über die Umkehrfunktion.' }],
    },
  ];

  it('honors the controlled open prop (closed ↔ open)', async () => {
    const w = mount(SolutionSheet, { props: { solution, open: false } });
    const sheet = w.find('.q-ssheet');
    expect(sheet.classes()).not.toContain('q-ssheet--open');
    expect(sheet.attributes('aria-hidden')).toBe('true');
    await w.setProps({ open: true });
    expect(sheet.classes()).toContain('q-ssheet--open');
    expect(sheet.attributes('aria-hidden')).toBe('false');
    expect(w.text()).toContain('Offizieller Lösungsweg');
  });

  it('renders solution entries with note box, figures and Alternative divider', () => {
    const w = mount(SolutionSheet, { props: { solution, open: true } });
    expect(w.text()).toContain('Zutreffend:');
    expect(w.find('.katex').exists()).toBe(true);
    expect(w.text()).toContain('Beurteilungshinweis');
    expect(w.text()).toContain('[0 / 1 Punkt]');
    const img = w.find('.q-ssheet__img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('assets/fig/loesung.png');
    expect(img.attributes('alt')).toBe('Lösungsabbildung');
    const dividers = w.findAll('.q-ssheet__divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]!.text()).toContain('Alternative');
  });

  it('resolves figure paths through the injected asset resolver', () => {
    const Host = defineComponent({
      components: { SolutionSheet },
      setup() {
        provideAssetResolver((src) => `https://core.example/content/assets/${src}`);
        return { solution };
      },
      template: '<SolutionSheet :solution="solution" :open="true" />',
    });
    const w = mount(Host);
    expect(w.find('.q-ssheet__img').attributes('src')).toBe(
      'https://core.example/content/assets/assets/fig/loesung.png',
    );
  });

  it('shows a quiet empty line when there is no official solution', () => {
    const w = mount(SolutionSheet, { props: { solution: undefined, open: true } });
    expect(w.text()).toContain('Keine offizielle Lösung verfügbar.');
    expect(w.findAll('.q-ssheet__entry')).toHaveLength(0);
  });

  it('emits update:open=false on Escape (parent owns the state)', async () => {
    const w = mount(SolutionSheet, { props: { solution, open: true } });
    await w.find('.q-ssheet').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('update:open')).toEqual([[false]]);
  });
});
