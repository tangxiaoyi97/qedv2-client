import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { GradeResult, MatchingAnswer } from '@qed2/core-logic';
import MatchingControl from '../src/question/MatchingControl.vue';

const answer: MatchingAnswer = {
  kind: 'matching',
  left: [
    [{ t: 'math', v: 'f(x)=2^x' }],
    [{ t: 'math', v: 'g(x)=x^2-1' }],
    [{ t: 'text', v: 'lineare Funktion' }],
  ],
  right: [
    [{ t: 'text', v: 'Exponentialfunktion' }],
    [{ t: 'text', v: 'Parabel ' }, { t: 'math', v: 'x^2' }],
    [{ t: 'text', v: 'Gerade' }],
    [{ t: 'text', v: 'Hyperbel' }],
  ],
  pairs: [
    [0, 0],
    [1, 1],
    [2, 2],
  ],
};

describe('MatchingControl', () => {
  it('renders a lettered select per left row plus the Optionen pool', () => {
    const wrapper = mount(MatchingControl, {
      props: { answer, modelValue: [null, null, null] },
    });
    const selects = wrapper.findAll('select');
    expect(selects).toHaveLength(3);
    // placeholder + 4 right items, plain-text projections with letters
    const opts = selects[0]!.findAll('option');
    expect(opts).toHaveLength(5);
    expect(opts[0]!.text()).toContain('zuordnen');
    expect(opts[1]!.text()).toBe('A · Exponentialfunktion');
    expect(opts[2]!.text()).toBe('B · Parabel x^2'); // math projected to plain source
    expect(opts[4]!.text()).toBe('D · Hyperbel');

    // pool lists all right items with the same letters, rendered rich
    const pool = wrapper.findAll('.q-match__pool-item');
    expect(pool).toHaveLength(4);
    expect(wrapper.find('.q-match__pool').text()).toContain('Optionen');
    expect(pool[0]!.text()).toContain('A ·');
    expect(pool[1]!.find('.katex').exists()).toBe(true);
  });

  it('emits the updated matches array and enforces one-to-one via disabled options', async () => {
    const wrapper = mount(MatchingControl, {
      props: { answer, modelValue: [null, null, null] },
    });
    await wrapper.findAll('select')[0]!.setValue('0');
    expect(wrapper.emitted('update:modelValue')![0]![0]).toEqual([0, null, null]);

    await wrapper.setProps({ modelValue: [0, null, null] });
    const row1opts = wrapper.findAll('select')[1]!.findAll('option');
    // right 0 is taken by row 0 → disabled in other selects
    expect(row1opts[1]!.attributes('disabled')).toBeDefined();
    expect(row1opts[2]!.attributes('disabled')).toBeUndefined();
    // but stays enabled in the row that owns it
    const row0opts = wrapper.findAll('select')[0]!.findAll('option');
    expect(row0opts[1]!.attributes('disabled')).toBeUndefined();
    // pool marks the used entry
    expect(wrapper.findAll('.q-match__pool-item')[0]!.classes()).toContain(
      'q-match__pool-item--used',
    );

    // clearing back to unassigned
    await wrapper.findAll('select')[0]!.setValue('');
    const events = wrapper.emitted('update:modelValue')!;
    expect(events[events.length - 1]![0]).toEqual([null, null, null]);
  });

  it('re-renders a chosen right item through RichTextView when it contains math', async () => {
    const wrapper = mount(MatchingControl, {
      props: { answer, modelValue: [1, null, null] },
    });
    const echo = wrapper.find('.q-match__echo');
    expect(echo.exists()).toBe(true);
    expect(echo.text()).toContain('B ·');
    expect(echo.find('.katex').exists()).toBe(true);

    // plain-text right item needs no echo
    await wrapper.setProps({ modelValue: [0, null, null] });
    expect(wrapper.find('.q-match__echo').exists()).toBe(false);
  });

  it('marks rows per breakdown in review mode and shows the correct item on error', async () => {
    const result: GradeResult = {
      verdict: 'partial',
      correct: false,
      awardedPoints: 1,
      maxPoints: 2,
      breakdown: [
        { ref: '0', correct: true },
        { ref: '1', correct: false, note: 'wrong-match' },
        { ref: '2', correct: false, note: 'unassigned' },
      ],
    };
    const wrapper = mount(MatchingControl, {
      props: { answer, modelValue: [0, 3, null], result },
    });
    const rows = wrapper.findAll('.q-match__row');
    expect(rows[0]!.classes()).toContain('q-match__row--ok');
    expect(rows[0]!.text()).toContain('Richtig');
    expect(rows[1]!.classes()).toContain('q-match__row--err');
    expect(rows[1]!.text()).toContain('Falsch');

    // correct right item shown for the wrong rows, dashed-ok framed
    const fix = rows[1]!.find('.q-match__correct');
    expect(fix.exists()).toBe(true);
    expect(fix.text()).toContain('Richtig wäre:');
    expect(fix.text()).toContain('B ·');
    expect(fix.find('.katex').exists()).toBe(true);

    // read-only: selects disabled, no emissions possible
    for (const sel of wrapper.findAll('select')) {
      expect(sel.attributes('disabled')).toBeDefined();
    }
  });
});
