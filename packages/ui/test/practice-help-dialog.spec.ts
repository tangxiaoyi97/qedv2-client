import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import PracticeHelpDialog from '../src/practice/PracticeHelpDialog.vue';

let view: VueWrapper | undefined;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function () { return document.body; });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 0; });
});
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks(); document.body.innerHTML = ''; });

function openDialog() {
  const opener = document.createElement('button');
  opener.textContent = 'Lösung erklären';
  document.body.append(opener);
  opener.focus();
  view = mount(PracticeHelpDialog, {
    props: { title: 'KI-Erklärung', context: 'Beispiel', returnLabel: 'Zurück zur Bewertung' },
    slots: { default: '<p>Ein langer Lösungsweg</p><button>Erneut versuchen</button>' },
    attachTo: document.body,
  });
  return opener;
}

describe('PracticeHelpDialog', () => {
  it('keeps keyboard focus inside and restores the invocation point on close', async () => {
    const opener = openDialog();
    await nextTick();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    buttons.at(-1)!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(view!.emitted('close')).toHaveLength(1);
    view!.unmount(); view = undefined;
    expect(document.activeElement).toBe(opener);
    expect(document.body.classList.contains('q-modal-open')).toBe(false);
  });

  it('keeps the return action outside scrolling content and ignores clicks inside', async () => {
    openDialog();
    await nextTick();
    const body = document.querySelector('.practice-help__body')!;
    expect(body.textContent).toContain('Ein langer Lösungsweg');
    expect(body.textContent).not.toContain('Zurück zur Bewertung');
    body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(view!.emitted('close')).toBeUndefined();
    document.querySelector<HTMLButtonElement>('.practice-help__footer button')!.click();
    expect(view!.emitted('close')).toHaveLength(1);
  });
});
