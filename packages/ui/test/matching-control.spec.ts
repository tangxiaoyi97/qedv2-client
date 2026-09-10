import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
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
  it('keeps grouped image zoom independent of radio navigation and review selection', async () => {
    const imageAnswer: MatchingAnswer = {
      ...groupedAnswer,
      right: groupedAnswer.right.map((item, index) => index === 0
        ? [{ t: 'fig' as const, src: 'assets/matching-graph.png', alt: 'Steigender Graph' }] : item),
    };
    const wrapper = mount(MatchingControl, {
      attachTo: document.body,
      props: { answer: imageAnswer, modelValue: [null, null] },
      global: { stubs: { FigureViewer: true } },
    });
    try {
      const option = wrapper.get('.q-match__inline-choice');
      const select = option.get('button[role="radio"]');
      const zoom = option.get('button.q-zfig');
      expect(option.element.tagName).toBe('DIV');
      expect(option.attributes('role')).toBeUndefined();
      expect(wrapper.find('button button').exists()).toBe(false);
      expect(select.attributes('aria-label')).toBe('A · Steigender Graph');

      (zoom.element as HTMLButtonElement).focus();
      await zoom.trigger('keydown', { key: 'ArrowRight' });
      expect(document.activeElement).toBe(zoom.element);
      expect(wrapper.emitted('update:modelValue')).toBeUndefined();
      zoom.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      await nextTick();
      expect(wrapper.get('figure-viewer-stub').attributes('src')).toBe('assets/matching-graph.png');
      expect(wrapper.emitted('update:modelValue')).toBeUndefined();
      wrapper.findComponent({ name: 'FigureViewer' }).vm.$emit('close');

      // Radio arrows still select within their group and never land on zoom.
      (select.element as HTMLButtonElement).focus();
      await select.trigger('keydown', { key: 'ArrowRight' });
      expect(document.activeElement).toBe(wrapper.findAll('button[role="radio"]')[1]!.element);
      expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual([1, null]);
      await wrapper.setProps({
        modelValue: [1, 4],
        result: { verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 1 },
      });
      const before = wrapper.emitted('update:modelValue')!.length;
      await zoom.trigger('click');
      expect(wrapper.find('figure-viewer-stub').exists()).toBe(true);
      await select.trigger('click');
      expect(wrapper.emitted('update:modelValue')).toHaveLength(before);
      expect(select.attributes('aria-disabled')).toBe('true');
    } finally {
      wrapper.unmount();
    }
  });

  it('opens classic pool figures without assigning and retains drag/drop assignment', async () => {
    const imageAnswer: MatchingAnswer = {
      ...answer,
      right: [[{ t: 'fig', src: 'assets/pool-graph.png', alt: 'Funktionsgraph A' }], ...answer.right.slice(1)],
    };
    const wrapper = mount(MatchingControl, {
      props: { answer: imageAnswer, modelValue: [null, null, null] },
      global: { stubs: { FigureViewer: true } },
    });
    try {
      const poolItem = wrapper.get('.q-match__pool-item');
      await poolItem.get('button.q-zfig').trigger('click');
      expect(wrapper.find('figure-viewer-stub').exists()).toBe(true);
      expect(wrapper.emitted('update:modelValue')).toBeUndefined();
      expect(poolItem.attributes('draggable')).toBe('true');
      await wrapper.get('.q-match__row').trigger('drop', { dataTransfer: { getData: () => '0' } });
      expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual([0, null, null]);
    } finally {
      wrapper.unmount();
    }
  });

  it('does not change a grouped match when the learner scrolls inside an option', async () => {
    const wrapper = mount(MatchingControl, { props: { answer: groupedAnswer, modelValue: [null, null] } });
    const option = wrapper.get('.q-match__inline-choice');
    await option.trigger('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 150, clientY: 100 });
    await option.trigger('pointermove', { pointerId: 1, clientX: 100, clientY: 95 });
    await option.trigger('pointerup', { pointerId: 1, clientX: 100, clientY: 95 });
    option.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    // Keyboard selection is independent of the previous pointer gesture.
    option.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual([0, null]);
  });

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
    expect(opts[2]!.text()).toBe('B · Parabel x²'); // math projected to readable plain text
    expect(opts[4]!.text()).toBe('D · Hyperbel');

    // pool lists all right items with the same letters, rendered rich
    const pool = wrapper.findAll('.q-match__pool-item');
    expect(pool).toHaveLength(4);
    expect(wrapper.find('.q-match__pool').text()).toContain('Optionen');
    expect(wrapper.get('.q-match__pool-hint--fine').text()).toBe('Ziehen / auswählen');
    expect(wrapper.get('.q-match__pool-hint--coarse').text()).toBe('Auswählen');
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

  it('shows a chosen formula once in the row and keeps its rich rendering in the options pool', async () => {
    const wrapper = mount(MatchingControl, {
      props: { answer, modelValue: [1, null, null] },
    });
    const select = wrapper.findAll('select')[0]!;
    expect((select.element as HTMLSelectElement).selectedOptions[0]!.textContent?.trim()).toBe('B · Parabel x²');
    expect(wrapper.find('.q-match__echo').exists()).toBe(false);
    // Native options retain readable labels; the shared pool keeps complete
    // typeset formulas available without a second card under every choice.
    expect(wrapper.findAll('.q-match__pool-item')[1]!.find('.katex').exists()).toBe(true);

    // Switching to text or clearing a choice must not leave a stale preview.
    await wrapper.setProps({ modelValue: [0, null, null] });
    expect((select.element as HTMLSelectElement).selectedOptions[0]!.textContent?.trim()).toBe('A · Exponentialfunktion');
    expect(wrapper.find('.q-match__echo').exists()).toBe(false);
    await wrapper.setProps({ modelValue: [null, null, null] });
    expect((select.element as HTMLSelectElement).value).toBe('');
    expect(wrapper.find('.q-match__echo').exists()).toBe(false);
  });

  it('compares correct, wrong and unassigned matches in a read-only table', async () => {
    const result: GradeResult = {
      verdict: 'partial',
      correct: false,
      awardedPoints: 1,
      maxPoints: 2,
      breakdown: [
        // The result identifies rows by ref, not breakdown order.
        { ref: '2', correct: false, note: 'unassigned' },
        { ref: '0', correct: true },
        { ref: '1', correct: false, note: 'wrong-match' },
      ],
    };
    const wrapper = mount(MatchingControl, {
      props: { answer, modelValue: [0, 3, null], result },
    });
    const table = wrapper.get('table');
    // Responsive block/grid styling must retain the table's accessible roles.
    expect(table.attributes('role')).toBe('table');
    expect(table.findAll('[role="rowgroup"]')).toHaveLength(2);
    expect(table.findAll('[role="columnheader"]')).toHaveLength(3);
    expect(table.findAll('[role="rowheader"]')).toHaveLength(3);
    expect(table.findAll('[role="cell"]')).toHaveLength(6);
    expect(table.attributes('aria-label')).toBe('Zuordnungen vergleichen');
    expect(table.findAll('thead th[scope="col"]').map(cell => cell.text())).toEqual([
      'Zuordnung', 'Gewählt', 'Lösung',
    ]);
    const rows = table.findAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.find('th[scope="row"]').exists())).toBe(true);

    // Index 0 remains A. A correct answer is confirmed without repeating it.
    const correctCells = rows[0]!.findAll('td');
    expect(correctCells[0]!.text()).toContain('A');
    expect(correctCells[0]!.text()).toContain('Exponentialfunktion');
    expect(correctCells[1]!.text()).toContain('Richtig');
    expect(rows[0]!.text().match(/Exponentialfunktion/g)).toHaveLength(1);

    // A wrong match keeps the chosen answer alongside its rich-text solution.
    const wrongCells = rows[1]!.findAll('td');
    expect(wrongCells[0]!.text()).toContain('D');
    expect(wrongCells[0]!.text()).toContain('Hyperbel');
    expect(wrongCells[1]!.text()).toContain('B');
    expect(wrongCells[1]!.text()).toContain('Parabel');
    expect(wrongCells[1]!.find('.katex').exists()).toBe(true);
    expect(wrongCells[0]!.find('.q-state-icon--incorrect').exists()).toBe(true);
    expect(wrongCells[0]!.find('[role="img"][aria-label="Falsch"]').exists()).toBe(true);

    const unassignedCells = rows[2]!.findAll('td');
    expect(unassignedCells[0]!.text()).toContain('Keine Auswahl');
    expect(unassignedCells[1]!.text()).toContain('C');
    expect(unassignedCells[1]!.text()).toContain('Gerade');

    // Review cannot mutate the submission, including through drag/drop.
    expect(wrapper.findAll('select')).toHaveLength(0);
    expect(wrapper.find('.q-match__pool').exists()).toBe(false);
    await rows[1]!.trigger('drop', { dataTransfer: { getData: () => '0' } });
    await wrongCells[0]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it.each([
    ['missing breakdown', undefined],
    ['missing row marks', [{ ref: '2', correct: false }]],
  ] as const)('keeps ungraded choices visible and neutral with %s', (_, breakdown) => {
    const wrapper = mount(MatchingControl, {
      props: {
        answer,
        modelValue: [0, 1, null],
        result: {
          verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1,
          ...(breakdown ? { breakdown: [...breakdown] } : {}),
        },
      },
    });
    const rows = wrapper.findAll('tbody tr');
    const firstCells = rows[0]!.findAll('td');
    expect(firstCells[0]!.text()).toContain('A');
    expect(firstCells[0]!.text()).toContain('Exponentialfunktion');
    expect(firstCells[1]!.text()).toContain('Nicht bewertet');
    const secondCells = rows[1]!.findAll('td');
    expect(secondCells[0]!.text()).toContain('B');
    expect(secondCells[0]!.text()).toContain('Parabel');
    expect(secondCells[0]!.find('.katex').exists()).toBe(true);
    expect(secondCells[1]!.text()).toContain('Nicht bewertet');
    for (const row of rows.slice(0, 2)) {
      // A failing overall result does not imply that each ungraded row is wrong.
      expect(row.find('.q-state-icon--incorrect').exists()).toBe(false);
      expect(row.find('.q-state-icon--correct').exists()).toBe(false);
    }
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('.q-match__pool').exists()).toBe(false);
  });

  it('treats missing submission entries as unassigned while retaining answer index zero', () => {
    const wrapper = mount(MatchingControl, {
      props: {
        answer, modelValue: [0],
        result: {
          verdict: 'partial', correct: false, awardedPoints: 1, maxPoints: 3,
          breakdown: [
            { ref: '0', correct: true },
            { ref: '1', correct: false, note: 'unassigned' },
            { ref: '2', correct: false, note: 'unassigned' },
          ],
        },
      },
    });
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0]!.findAll('td')[0]!.text()).toContain('A');
    expect(rows[0]!.findAll('td')[0]!.text()).toContain('Exponentialfunktion');
    expect(rows[0]!.text()).not.toContain('Keine Auswahl');
    for (const row of rows.slice(1)) expect(row.findAll('td')[0]!.text()).toContain('Keine Auswahl');
    expect(rows[1]!.findAll('td')[1]!.text()).toContain('Parabel');
    expect(rows[2]!.findAll('td')[1]!.text()).toContain('Gerade');
  });

  it('renders safe placeholders for invalid indices in legacy results', () => {
    const wrapper = mount(MatchingControl, {
      props: {
        answer: { ...answer, pairs: [[0, 99], [1, -1], [2, 0.5]] },
        modelValue: [99, -1, 0.5],
        result: {
          verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1,
          breakdown: answer.left.map((_, index) => ({ ref: String(index), correct: false })),
        },
      },
    });
    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = row.findAll('td');
      expect(cells[0]!.text()).toContain('Keine Auswahl');
      expect(cells[1]!.text()).toContain('Keine Zuordnung');
      // Invalid values must not render a bogus letter or an empty RichText node.
      expect(row.findAll('td .q-richtext')).toHaveLength(0);
      expect(row.find('.q-match-review__letter').exists()).toBe(false);
    }
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
    expect(first[1]!.text()).toContain('Falsch');
    expect(first[1]!.text()).not.toContain('gewählt');
    expect(first[0]!.classes()).toContain('q-match__inline-choice--missed');
    expect(first[0]!.text()).toContain('Richtig');
    const second = rows[1]!.findAll('.q-match__inline-choice');
    expect(second[1]!.classes()).toContain('q-match__inline-choice--ok');
    // The classic comparison table must not replace grouped in-place feedback.
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('.q-match__cmp').exists()).toBe(false);
    expect(wrapper.find('.q-match__pool').exists()).toBe(false);
    // Feedback belongs to each option; the group heading must not announce
    // a second, potentially conflicting verdict for the whole group.
    expect(rows[0]!.classes()).not.toContain('q-match__row--err');
    expect(rows[0]!.classes()).not.toContain('q-match__row--ok');
    expect(rows[1]!.classes()).not.toContain('q-match__row--ok');
    expect(rows[1]!.classes()).not.toContain('q-match__row--err');
    expect(rows[0]!.find('.q-match__main .q-state-icon').exists()).toBe(false);
    expect(rows[1]!.find('.q-match__main .q-state-icon').exists()).toBe(false);
    expect(first[1]!.get('.q-match__oc-label').attributes('aria-hidden')).toBeUndefined();
    expect(first[0]!.get('.q-match__oc-label').attributes('aria-hidden')).toBeUndefined();
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
