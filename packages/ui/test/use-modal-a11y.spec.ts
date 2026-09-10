import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, toRef } from 'vue';
import { useModalA11y } from '../src/shared/useModalA11y.js';
import { bodyScrollLockDepth } from '../src/shared/scroll-lock.js';

const views: VueWrapper[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

const Dialog = defineComponent({
  props: { open: Boolean, label: { type: String, required: true } },
  emits: ['close'],
  setup(props, { emit }) {
    const container = ref<HTMLElement | null>(null);
    useModalA11y(container, toRef(props, 'open'), () => emit('close'));
    return () => props.open ? h('div', { ref: container, role: 'dialog', tabindex: -1 }, [
      h('button', { 'data-first': '' }, `${props.label} first`),
      h('button', { 'data-chip': '' }, `${props.label} competency`),
      h('button', { 'data-last': '' }, `${props.label} last`),
    ]) : null;
  },
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(() => document.body);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  views.splice(0).reverse().forEach(view => view.unmount());
  frames.clear();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  expect(bodyScrollLockDepth()).toBe(0);
});

function mountDialog(label: string) {
  const view = mount(Dialog, { props: { open: false, label }, attachTo: document.body });
  views.push(view);
  return view;
}

function runFrames() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(0));
}

function key(key: string, shiftKey = false) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}

function opener() {
  const button = document.createElement('button');
  document.body.append(button);
  button.focus();
  return button;
}

describe('useModalA11y overlay stack', () => {
  it('lets Escape close only the top dialog, then restores its competency chip', async () => {
    const outside = opener();
    const parent = mountDialog('progress');
    await parent.setProps({ open: true });
    runFrames();
    const chip = parent.get('[data-chip]').element as HTMLButtonElement;
    chip.focus();
    const child = mountDialog('competency');
    await child.setProps({ open: true });
    runFrames();
    expect(bodyScrollLockDepth()).toBe(2);
    key('Escape');
    expect(child.emitted('close')).toHaveLength(1);
    expect(parent.emitted('close')).toBeUndefined();
    await child.setProps({ open: false });
    expect(document.activeElement).toBe(chip);
    expect(bodyScrollLockDepth()).toBe(1);
    expect(document.body.classList.contains('q-modal-open')).toBe(true);
    key('Escape');
    expect(parent.emitted('close')).toHaveLength(1);
    await parent.setProps({ open: false });
    expect(document.activeElement).toBe(outside);
    expect(bodyScrollLockDepth()).toBe(0);
  });

  it('traps Tab only inside the top dialog, including when focus escaped to its parent', async () => {
    const parent = mountDialog('progress');
    const child = mountDialog('competency');
    await parent.setProps({ open: true });
    await child.setProps({ open: true });
    runFrames();
    const first = child.get('[data-first]').element as HTMLButtonElement;
    const last = child.get('[data-last]').element as HTMLButtonElement;
    last.focus();
    key('Tab');
    expect(document.activeElement).toBe(first);
    key('Tab', true);
    expect(document.activeElement).toBe(last);
    (parent.get('[data-chip]').element as HTMLButtonElement).focus();
    key('Tab');
    expect(document.activeElement).toBe(first);
  });

  it('does not release another dialog’s lock when a closed dialog mounts or unmounts', async () => {
    const parent = mountDialog('progress');
    await parent.setProps({ open: true });
    runFrames();
    const closed = mountDialog('competency');
    expect(bodyScrollLockDepth()).toBe(1);
    closed.unmount();
    views.splice(views.indexOf(closed), 1);
    expect(bodyScrollLockDepth()).toBe(1);
    expect(document.body.classList.contains('q-modal-open')).toBe(true);
  });

  it('cancels deferred focus after an immediate close and never lets a lower frame steal focus', async () => {
    const outside = opener();
    const parent = mountDialog('progress');
    await parent.setProps({ open: true });
    const cancelledCallback = [...frames.values()][0]!;
    await parent.setProps({ open: false });
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    // Even an already-dispatched callback must become harmless after close.
    cancelledCallback(0);
    expect(document.activeElement).toBe(outside);
    expect(frames.size).toBe(0);
    await parent.setProps({ open: true });
    const child = mountDialog('competency');
    await child.setProps({ open: true });
    const pending = [...frames.values()];
    frames.clear();
    pending.reverse().forEach(callback => callback(0));
    expect(document.activeElement).toBe(child.get('[data-first]').element);
  });

  it('keeps focus and the lock in a child when its parent unmounts, then returns outside', async () => {
    const outside = opener();
    const parent = mountDialog('progress');
    await parent.setProps({ open: true });
    runFrames();
    (parent.get('[data-chip]').element as HTMLButtonElement).focus();
    const child = mountDialog('competency');
    await child.setProps({ open: true });
    runFrames();
    const childFocus = document.activeElement;
    parent.unmount();
    views.splice(views.indexOf(parent), 1);
    expect(document.activeElement).toBe(childFocus);
    expect(bodyScrollLockDepth()).toBe(1);
    await child.setProps({ open: false });
    expect(document.activeElement).toBe(outside);
    expect(bodyScrollLockDepth()).toBe(0);
  });
});
