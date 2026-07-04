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

const groupedAnswer: MatchingAnswer = {
  kind: 'matching',
  left: [[{ t: 'text', v: '①' }], [{ t: 'text', v: '②' }]],
  right: [
    [{ t: 'math', v: 'a<b' }],
    [{ t: 'math', v: 'a=b' }],
    [{ t: 'math', v: 'a>b' }],
    [{ t: 'math', v: 'b<c' }],
    [{ t: 'math', v: 'b=c' }],
    [{ t: 'math', v: 'b>c' }],
  ],
  pairs: [
    [0, 0],
    [1, 4],
  ],
  candidateGroups: [
    { leftIndices: [0], rightIndices: [0, 1, 2], label: [{ t: 'text', v: '①' }] },
    { leftIndices: [1], rightIndices: [3, 4, 5], label: [{ t: 'text', v: '②' }] },
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
    expect(rows[1]!.classes()).toContain('q-match__row--err');

    // correct row: single compact confirmation line with the chosen letter
    expect(rows[0]!.find('.q-match__cmp-line--ok').exists()).toBe(true);
    expect(rows[0]!.find('.q-match__cmp-letter').text()).toBe('A');

    // wrong row: Gewählt/Richtig comparison lines, correct item rendered with math
    const wrong = rows[1]!;
    expect(wrong.find('.q-match__cmp-line--user').text()).toContain('Gewählt');
    const fix = wrong.find('.q-match__cmp-line--ok');
    expect(fix.exists()).toBe(true);
    expect(fix.text()).toContain('Richtig');
    expect(fix.text()).toContain('B');
    expect(fix.find('.katex').exists()).toBe(true);

    // review is form-free and pool-free — no dead controls, less noise
    expect(wrapper.findAll('select')).toHaveLength(0);
    expect(wrapper.find('.q-match__pool').exists()).toBe(false);
  });

  it('uses v3 candidateGroups to render isolated option groups', async () => {
    const wrapper = mount(MatchingControl, {
      props: { answer: groupedAnswer, modelValue: [null, null] },
    });

    expect(wrapper.findAll('select')).toHaveLength(0);
    // grouped mode is two independent single-choice groups — the redundant
    // Optionen pool must NOT render (options live inline as cards).
    expect(wrapper.find('.q-match__pool').exists()).toBe(false);

    const rows = wrapper.findAll('.q-match__row');
    const firstChoices = rows[0]!.findAll('.q-match__inline-choice');
    const secondChoices = rows[1]!.findAll('.q-match__inline-choice');
    expect(firstChoices.map((node) => node.find('.q-match__pool-letter').text())).toEqual([
      'A ·',
      'B ·',
      'C ·',
    ]);
    expect(secondChoices.map((node) => node.find('.q-match__pool-letter').text())).toEqual([
      'D ·',
      'E ·',
      'F ·',
    ]);

    await rows[0]!.findAll('.q-match__inline-choice')[1]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')![0]![0]).toEqual([1, null]);
  });

  it('grouped review marks options in place like ChoiceControl', () => {
    const wrapper = mount(MatchingControl, {
      props: {
        answer: groupedAnswer,
        modelValue: [1, 4], // gap 1 wrong (B, correct A); gap 2 correct (E)
        result: {
          verdict: 'partial',
          correct: false,
          awardedPoints: 0.5,
          maxPoints: 1,
          breakdown: [
            { ref: '0', correct: false },
            { ref: '1', correct: true },
          ],
        },
      },
    });
    const rows = wrapper.findAll('.q-match__row');
    const first = rows[0]!.findAll('.q-match__inline-choice');
    // chosen-wrong (B) marked err, expected (A) dashed-missed, in place
    expect(first[1]!.classes()).toContain('q-match__inline-choice--err');
    expect(first[1]!.text()).toContain('Falsch · gewählt');
    expect(first[0]!.classes()).toContain('q-match__inline-choice--missed');
    expect(first[0]!.text()).toContain('Richtig');
    const second = rows[1]!.findAll('.q-match__inline-choice');
    expect(second[1]!.classes()).toContain('q-match__inline-choice--ok');
    // no classic comparison lines, no pool in grouped review
    expect(wrapper.find('.q-match__cmp').exists()).toBe(false);
    expect(wrapper.find('.q-match__pool').exists()).toBe(false);
  });

  it('rejects cross-group drag/drop assignments for v3 matching', async () => {
    const wrapper = mount(MatchingControl, {
      props: { answer: groupedAnswer, modelValue: [null, null] },
    });

    await wrapper.findAll('.q-match__row')[0]!.trigger('drop', {
      dataTransfer: { getData: () => '3' },
    });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('keeps 2x6 matching without candidateGroups on the v2 full-option select path', () => {
    const plainTwoBySix: MatchingAnswer = {
      ...groupedAnswer,
      candidateGroups: undefined,
    };
    const wrapper = mount(MatchingControl, {
      props: { answer: plainTwoBySix, modelValue: [null, null] },
    });

    const selects = wrapper.findAll('select');
    expect(selects).toHaveLength(2);
    expect(selects[0]!.findAll('option')).toHaveLength(7);
    expect(selects[0]!.text()).toContain('F · b>c');
  });
});
