import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import PracticeSessionDrawer from '../src/practice/PracticeSessionDrawer.vue';
import type { SessionItem } from '../src/practice/SessionItemList.vue';
import drawerSource from '../src/practice/PracticeSessionDrawer.vue?raw';
import listSource from '../src/practice/SessionItemList.vue?raw';

const items: SessionItem[] = [
  { index: 0, partId: 'a', title: 'Erste', partLabel: undefined, state: 'correct', jumpable: false },
  { index: 1, partId: 'b', title: 'Zweite', partLabel: undefined, state: 'current', jumpable: true },
  { index: 2, partId: 'c', title: 'Dritte', partLabel: 'b', state: 'pending', jumpable: true },
];

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  document.body.innerHTML = '';
});

function mountDrawer() {
  const view = mount(PracticeSessionDrawer, {
    props: { open: true, items, gradedCount: 1, total: 3 },
    attachTo: document.body,
  });
  mounted.push(view);
  return view;
}

/** jsdom has no PointerEvent constructor; the handlers only read these fields. */
function pointer(type: string, x: number, y = 200, pointerType = 'touch'): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: 3 },
    pointerType: { value: pointerType },
    isPrimary: { value: true },
  });
  return event;
}

async function swipe(target: Element, distances: number[], pointerType = 'touch', y = 200): Promise<void> {
  target.dispatchEvent(pointer('pointerdown', 40, 200, pointerType));
  for (const dx of distances) target.dispatchEvent(pointer('pointermove', 40 + dx, y, pointerType));
  target.dispatchEvent(pointer('pointerup', 40 + distances[distances.length - 1]!, y, pointerType));
  await nextTick();
}

describe('practice session drawer on touch screens', () => {
  it('closes when the panel is swiped back toward the edge it came from', async () => {
    const view = mountDrawer();
    const row = document.querySelectorAll('.q-sitems__item')[2]!;
    await swipe(row, [12, 60, 140]);
    expect(view.emitted('close')).toHaveLength(1);
    // The row the finger ended on must not also be opened.
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(view.emitted('jump')).toBeUndefined();
  });

  it('springs back from a short drag and keeps rows tappable afterwards', async () => {
    const view = mountDrawer();
    const panel = document.querySelector<HTMLElement>('.practice-session-drawer__panel')!;
    const row = document.querySelectorAll<HTMLButtonElement>('.q-sitems__item')[2]!;
    await swipe(row, [12, 30]);
    expect(view.emitted('close')).toBeUndefined();
    expect(panel.style.transform).toBe('');
    row.click();
    expect(view.emitted('close')).toBeUndefined();
    row.click();
    expect(view.emitted('jump')?.at(-1)).toEqual([2]);
  });

  it('leaves vertical scrolling and mouse drags alone', async () => {
    const view = mountDrawer();
    const panel = document.querySelector<HTMLElement>('.practice-session-drawer__panel')!;
    const row = document.querySelectorAll('.q-sitems__item')[1]!;
    row.dispatchEvent(pointer('pointerdown', 40, 200));
    row.dispatchEvent(pointer('pointermove', 46, 120));
    row.dispatchEvent(pointer('pointermove', 52, 60));
    await nextTick();
    expect(panel.style.transform).toBe('');
    row.dispatchEvent(pointer('pointerup', 52, 60));
    await swipe(row, [20, 120, 200], 'mouse');
    expect(view.emitted('close')).toBeUndefined();
    expect(drawerSource).toContain('touch-action: pan-y');
  });

  it('shows label and count on one line and gives every row a full touch target', () => {
    mountDrawer();
    const heading = document.querySelector('.practice-session-drawer__heading');
    expect(heading?.querySelector('.practice-session-drawer__title')?.textContent).toBe('Programm');
    expect(heading?.querySelector('.practice-session-drawer__count')?.textContent).toBe('1/3');
    expect(drawerSource).toMatch(/\.practice-session-drawer__heading\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*baseline/);
    expect(listSource).toMatch(/\.q-sitems__item\s*\{[^}]*min-height:\s*var\(--q-touch-target\)/);
    // The current row is an icon, not a typed arrow glyph.
    expect(document.querySelector('.q-sitems__item--current svg.q-sitems__now')).not.toBeNull();
    expect(listSource).not.toContain('>→<');
  });
});
