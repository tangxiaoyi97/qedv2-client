import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MasteryBar from '../src/review/MasteryBar.vue';
import CompetencyGroups from '../src/review/CompetencyGroups.vue';

describe('MasteryBar', () => {
  it('renders code, fill width and level label derived from mastery', () => {
    const w = mount(MasteryBar, { props: { code: 'AG', mastery: 0.78 } });
    expect(w.text()).toContain('AG');
    expect(w.text()).toContain('hoch');
    const fill = w.find('.q-mastery__fill');
    expect(fill.attributes('style')).toContain('width: 78%');
    expect(fill.classes()).toContain('q-mastery__fill--high');
  });

  it('maps thresholds: <0.4 gering, <0.7 mittel, else hoch', () => {
    expect(mount(MasteryBar, { props: { code: 'X', mastery: 0.39 } }).text()).toContain('gering');
    expect(mount(MasteryBar, { props: { code: 'X', mastery: 0.4 } }).text()).toContain('mittel');
    expect(mount(MasteryBar, { props: { code: 'X', mastery: 0.69 } }).text()).toContain('mittel');
    expect(mount(MasteryBar, { props: { code: 'X', mastery: 0.7 } }).text()).toContain('hoch');
  });

  it('honours an explicit level override', () => {
    const w = mount(MasteryBar, { props: { code: 'FA 1.5', mastery: 0.9, level: 'low' } });
    expect(w.text()).toContain('gering');
    expect(w.find('.q-mastery__fill').classes()).toContain('q-mastery__fill--low');
  });

  it('clamps out-of-range mastery for the fill width', () => {
    const w = mount(MasteryBar, { props: { code: 'X', mastery: 1.4 } });
    expect(w.find('.q-mastery__fill').attributes('style')).toContain('width: 100%');
  });
});

describe('CompetencyGroups', () => {
  const entries = [
    { code: 'FA 1.5', mastery: 0.5, due: true },
    { code: 'FA 2.1', mastery: 0.4 },
    { code: 'AN 3.3', mastery: 0.28, due: true },
    { code: 'AG 1.1', mastery: 0.8 },
  ];

  it('groups entries by category with German names in AG/FA/AN/WS order', () => {
    const w = mount(CompetencyGroups, { props: { entries } });
    const heads = w.findAll('.q-cgroups__head');
    expect(heads.map((h) => h.find('.q-cgroups__cat').text())).toEqual(['AG', 'FA', 'AN']);
    expect(w.text()).toContain('Algebra & Geometrie');
    expect(w.text()).toContain('Funktionale Abhängigkeiten');
    expect(w.text()).toContain('Analysis');
    expect(w.text()).not.toContain('Wahrscheinlichkeit & Statistik');
  });

  it('shows the mean-mastery aggregate per group ("mittel · 45%")', () => {
    const w = mount(CompetencyGroups, { props: { entries } });
    const aggregates = w.findAll('.q-cgroups__agg').map((a) => a.text());
    // FA: (0.5+0.4)/2 = 0.45 → mittel · 45%
    expect(aggregates).toContain('mittel · 45%');
    // AN: 0.28 → gering · 28%
    expect(aggregates).toContain('gering · 28%');
    // AG: 0.8 → hoch · 80%
    expect(aggregates).toContain('hoch · 80%');
  });

  it('renders a MasteryBar per entry and a due dot only for due entries', () => {
    const w = mount(CompetencyGroups, { props: { entries } });
    expect(w.findAllComponents(MasteryBar)).toHaveLength(4);
    const dots = w.findAll('.q-cgroups__due--on');
    expect(dots).toHaveLength(2);
    expect(dots[0]!.attributes('title')).toBe('fällig');
  });
});
