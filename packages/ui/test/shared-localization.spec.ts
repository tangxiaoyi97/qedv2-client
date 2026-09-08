import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setUiLocale } from '../src/i18n.js';
import ChoiceControl from '../src/question/ChoiceControl.vue';
import NumericControl from '../src/question/NumericControl.vue';
import FilterDialog from '../src/question/FilterDialog.vue';
import GradingCapsule from '../src/shared/GradingCapsule.vue';
import QLoadingPanel from '../src/shared/QLoadingPanel.vue';
import ActivityHeatmap from '../src/review/ActivityHeatmap.vue';

afterEach(() => setUiLocale('de'));

describe('shared UI language', () => {
  it('changes shared labels immediately while preserving question content and answers', async () => {
    const wrapper = mount(ChoiceControl, { props: { answer: { kind: 'choice', options: [[{ t: 'text', v: 'Die Funktion steigt.' }]], correct: [0], selectCount: 1 }, modelValue: [0] } });
    const capsule = mount(GradingCapsule, { props: { grading: 'good' } });
    setUiLocale('en');
    await nextTick();
    expect(wrapper.text()).toContain('1 of 1');
    expect(wrapper.text()).toContain('1 selected');
    expect(wrapper.text()).toContain('Die Funktion steigt.');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(capsule.attributes('aria-label')).toBe('Rating: Confident');
    setUiLocale('de');
    await nextTick();
    expect(capsule.text()).toContain('Gut');
  });

  it('formats expected values and loading states in English', () => {
    setUiLocale('en');
    const wrapper = mount(NumericControl, { props: { answer: { kind: 'numeric', blanks: [{ id: 'x', value: 4.5, tol: 0.1 }] }, modelValue: { x: '9' }, result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1, breakdown: [{ ref: 'x', correct: false }] } } });
    expect(wrapper.get('input').attributes('aria-label')).toBe('Answer (number)');
    expect(wrapper.text()).toContain('Correct: 4.5 (±0.1)');
    expect(mount(QLoadingPanel).text()).toBe('Loading…');
  });

  it('switches heatmap dates and localized filter enums', async () => {
    setUiLocale('en');
    const heatmap = mount(ActivityHeatmap, { props: { endDate: '2026-07-02', weeks: 6, data: { '2026-07-02': 3 } } });
    expect(heatmap.findAll('.q-heat__weekday').map(item => item.text())).toEqual(['Mon', 'Wed', 'Fri']);
    expect(heatmap.findAll('title').map(item => item.text())).toContain('3 questions · 02 Jul 2026');
    const filter = mount(FilterDialog, { attachTo: document.body, props: { modelValue: { years: [], terms: [], teils: [], categories: [], gradings: [], formats: [], starredOnly: false }, resultCount: 4 } });
    expect(document.body.textContent).toContain('Main session');
    expect(document.body.textContent).toContain('Part 1');
    filter.unmount();
  });
});
