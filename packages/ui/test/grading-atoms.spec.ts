import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { GradeResult, GradingOrUnseen } from '@qed2/core-logic';
import GradingDot, { GRADING_LABELS } from '../src/shared/GradingDot.vue';
import GradingCapsule from '../src/shared/GradingCapsule.vue';
import GradingMenu from '../src/shared/GradingMenu.vue';
import StarButton from '../src/shared/StarButton.vue';
import ResultPill from '../src/practice/ResultPill.vue';
import StateIcon from '../src/shared/StateIcon.vue';

const ALL_STATES: GradingOrUnseen[] = ['good', 'careless', 'meh', 'baffled', 'excluded', 'unseen'];

describe('GradingDot', () => {
  it('renders a distinct SVG shape per state (shape carries meaning, not color)', () => {
    const svgs = ALL_STATES.map(
      (grading) => mount(GradingDot, { props: { grading } }).find('svg').html(),
    );
    // all six markups pairwise different
    expect(new Set(svgs).size).toBe(6);
  });

  it('exposes state through class, shape markers and German aria-label', () => {
    const good = mount(GradingDot, { props: { grading: 'good' } });
    expect(good.classes()).toContain('q-grading-dot--good');
    expect(good.html()).toContain('fill="var(--q-ok)"'); // solid fill

    const careless = mount(GradingDot, { props: { grading: 'careless' } });
    expect(careless.find('path').exists()).toBe(true); // half-fill wedge
    expect(careless.attributes('aria-label')).toBe('Schlampigkeitsfehler');

    const meh = mount(GradingDot, { props: { grading: 'meh' } });
    expect(meh.find('circle').attributes('fill')).toBe('none'); // outlined
    expect(meh.html()).not.toContain('stroke-dasharray');

    const baffled = mount(GradingDot, { props: { grading: 'baffled' } });
    expect(baffled.find('circle').attributes('stroke-dasharray')).toBeTruthy(); // dashed

    const excluded = mount(GradingDot, { props: { grading: 'excluded' } });
    expect(excluded.findAll('line')).toHaveLength(2); // inscribed ✕

    const unseen = mount(GradingDot, { props: { grading: 'unseen' } });
    expect(unseen.find('circle').attributes('stroke')).toBe('var(--q-btn-border)');
    expect(unseen.attributes('aria-label')).toBe('Neu');
  });

  it('sizes via the size prop (default 14) and takes a custom title', () => {
    const dflt = mount(GradingDot, { props: { grading: 'good' } });
    expect(dflt.attributes('width')).toBe('14');
    const custom = mount(GradingDot, { props: { grading: 'good', size: 10, title: 'Zuletzt: Gut' } });
    expect(custom.attributes('width')).toBe('10');
    expect(custom.find('title').text()).toBe('Zuletzt: Gut');
  });
});

describe('GradingCapsule', () => {
  it('shows dot + German label, toned per state', () => {
    const good = mount(GradingCapsule, { props: { grading: 'good' } });
    expect(good.element.tagName).toBe('SPAN');
    expect(good.classes()).toContain('q-grading-capsule--ok');
    expect(good.text()).toContain('Gut');
    expect(good.findComponent(GradingDot).props('grading')).toBe('good');

    const meh = mount(GradingCapsule, { props: { grading: 'meh' } });
    expect(meh.classes()).toContain('q-grading-capsule--part');

    const unseen = mount(GradingCapsule, { props: { grading: 'unseen' } });
    expect(unseen.classes()).toContain('q-grading-capsule--neutral');
    expect(unseen.text()).toContain('Neu');
  });

  it('renders as a button with caret and emits click when interactive', async () => {
    const w = mount(GradingCapsule, { props: { grading: 'baffled', interactive: true } });
    expect(w.element.tagName).toBe('BUTTON');
    expect(w.text()).toContain('▾');
    await w.trigger('click');
    expect(w.emitted('click')).toHaveLength(1);
  });
});

describe('GradingMenu', () => {
  function open(grading: GradingOrUnseen = 'unseen') {
    const w = mount(GradingMenu, { props: { grading } });
    return w
      .find('button')
      .trigger('click')
      .then(() => w);
  }

  it('opens on trigger click and lists exactly the five selectable states (no unseen)', async () => {
    const w = await open();
    const rows = w.findAll('.q-grading-menu__option');
    expect(rows).toHaveLength(5);
    const text = rows.map((r) => r.text()).join(' | ');
    for (const g of ['good', 'careless', 'meh', 'baffled', 'excluded'] as const) {
      expect(text).toContain(GRADING_LABELS[g]);
    }
    expect(text).not.toContain('Neu');
    // hint texts present
    expect(text).toContain('Eigentlich gekonnt');
    expect(text).toContain('Nie wieder üben');
  });

  it('marks the current state row', async () => {
    const w = await open('meh');
    const current = w.find('.q-grading-menu__option--current');
    expect(current.exists()).toBe(true);
    expect(current.text()).toContain('Halb verstanden');
    expect(current.attributes('aria-checked')).toBe('true');
    expect(current.text()).toContain('✓');
  });

  it('emits select and closes when an option is clicked', async () => {
    const w = await open('baffled');
    const careless = w
      .findAll('.q-grading-menu__option')
      .find((r) => r.text().includes('Schlampigkeitsfehler'));
    expect(careless).toBeDefined();
    await careless!.trigger('click');
    expect(w.emitted('select')).toEqual([['careless']]);
    expect(w.find('.q-grading-menu__popover').exists()).toBe(false);
  });

  it('closes on Escape and does not open when disabled', async () => {
    const w = await open();
    expect(w.find('.q-grading-menu__popover').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await w.vm.$nextTick();
    expect(w.find('.q-grading-menu__popover').exists()).toBe(false);
    w.unmount();

    const d = mount(GradingMenu, { props: { grading: 'good', disabled: true } });
    await d.find('button').trigger('click');
    expect(d.find('.q-grading-menu__popover').exists()).toBe(false);
  });
});

describe('StarButton', () => {
  it('reflects the starred state via aria-pressed, glyph and title', async () => {
    const w = mount(StarButton, { props: { starred: false } });
    expect(w.attributes('aria-pressed')).toBe('false');
    expect(w.text()).toContain('☆');
    expect(w.attributes('title')).toBe('Merken');

    await w.setProps({ starred: true });
    expect(w.attributes('aria-pressed')).toBe('true');
    expect(w.text()).toContain('★');
    expect(w.attributes('title')).toBe('Gemerkt');
  });

  it('emits toggle on click', async () => {
    const w = mount(StarButton, { props: { starred: false } });
    await w.trigger('click');
    expect(w.emitted('toggle')).toHaveLength(1);
  });
});

describe('ResultPill', () => {
  function result(partial: Partial<GradeResult>): GradeResult {
    return { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1, ...partial };
  }

  it('shows label, icon and points for a correct result', () => {
    const w = mount(ResultPill, { props: { result: result({}) } });
    expect(w.classes()).toContain('q-result-pill--correct');
    expect(w.text()).toContain('Richtig');
    expect(w.text()).toContain('1 / 1');
    expect(w.text()).toContain('Punkte');
    expect(w.findComponent(StateIcon).props('state')).toBe('correct');
  });

  it('shows the partial verdict with German comma decimals', () => {
    const w = mount(ResultPill, {
      props: {
        result: result({ verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 2 }),
      },
    });
    expect(w.classes()).toContain('q-result-pill--partial');
    expect(w.text()).toContain('Teilweise richtig');
    expect(w.text()).toContain('0,5 / 2');
    expect(w.findComponent(StateIcon).props('state')).toBe('partial');
  });

  it('shows the incorrect verdict', () => {
    const w = mount(ResultPill, {
      props: {
        result: result({ verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 3 }),
      },
    });
    expect(w.classes()).toContain('q-result-pill--incorrect');
    expect(w.text()).toContain('Falsch');
    expect(w.text()).toContain('0 / 3');
  });
});
