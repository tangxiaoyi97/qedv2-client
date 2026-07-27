import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SolutionSheet from '../src/practice/SolutionSheet.vue';

/**
 * On a phone the bottom bar has no room for a „Lösung" button next to the
 * primary action, so the sheet's own grab handle is the control: swipe it in
 * either direction, or just click it.
 */
function mountSheet(props: Record<string, unknown> = {}) {
  return mount(SolutionSheet, {
    props: { solution: [], open: false, handle: true, ...props },
  });
}

const at = (y: number) => ({ clientY: y, pointerId: 1 });

describe('SolutionSheet grab handle', () => {
  it('stays visible while the sheet is shut, so there is something to grab', () => {
    const wrapper = mountSheet({ open: false });
    expect(wrapper.find('.q-ssheet__handle').exists()).toBe(true);
    expect(wrapper.get('.q-ssheet').classes()).not.toContain('q-ssheet--open');
  });

  it('is absent while the question is still unanswered', () => {
    expect(mountSheet({ handle: false }).find('.q-ssheet__handle').exists()).toBe(false);
  });

  it('opens on click and closes on the next one', async () => {
    const shut = mountSheet({ open: false });
    await shut.get('.q-ssheet__handle').trigger('click');
    expect(shut.emitted('update:open')?.at(-1)).toEqual([true]);

    const openSheet = mountSheet({ open: true });
    await openSheet.get('.q-ssheet__handle').trigger('click');
    expect(openSheet.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('opens on a swipe up and closes on a swipe down', async () => {
    const up = mountSheet({ open: false });
    const upHandle = up.get('.q-ssheet__handle');
    await upHandle.trigger('pointerdown', at(300));
    await upHandle.trigger('pointermove', at(260));
    expect(up.emitted('update:open')?.at(-1)).toEqual([true]);

    const down = mountSheet({ open: true });
    const downHandle = down.get('.q-ssheet__handle');
    await downHandle.trigger('pointerdown', at(300));
    await downHandle.trigger('pointermove', at(340));
    expect(down.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('ignores a twitch that is too small to be a swipe', async () => {
    const wrapper = mountSheet({ open: false });
    const handle = wrapper.get('.q-ssheet__handle');
    await handle.trigger('pointerdown', at(300));
    await handle.trigger('pointermove', at(290));
    expect(wrapper.emitted('update:open')).toBeUndefined();
  });

  it('does not let the click after a swipe undo the swipe', async () => {
    const wrapper = mountSheet({ open: false });
    const handle = wrapper.get('.q-ssheet__handle');
    await handle.trigger('pointerdown', at(300));
    await handle.trigger('pointermove', at(250));
    await handle.trigger('pointerup', at(250));
    await handle.trigger('click');
    // Exactly one decision, not open-then-close.
    expect(wrapper.emitted('update:open')).toEqual([[true]]);
  });

  it('shows the verdict inside the sheet and tints the whole surface', () => {
    const wrapper = mountSheet({
      verdict: 'incorrect',
      verdictLabel: 'Falsch',
      verdictPoints: '0 / 1 P',
    });
    expect(wrapper.get('.q-ssheet-wrap').classes()).toContain('q-ssheet-wrap--incorrect');
    const verdict = wrapper.get('.q-ssheet__verdict');
    expect(verdict.text()).toContain('Falsch');
    expect(verdict.text()).toContain('0 / 1 P');
  });
});
