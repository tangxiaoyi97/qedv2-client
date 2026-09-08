import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchBox from '../src/shared/SearchBox.vue';

afterEach(() => vi.useRealTimers());

describe('SearchBox', () => {
  it.each(['tracked', 'event', 'safari'] as const)('preserves the native IME confirmation Enter (%s)', async (mode) => {
    const wrapper = mount(SearchBox, { props: { modelValue: '函数' } });
    const input = wrapper.get<HTMLInputElement>('input');
    if (mode === 'tracked') await input.trigger('compositionstart');
    const confirmation = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, isComposing: mode === 'event',
    });
    if (mode === 'safari') Object.defineProperty(confirmation, 'keyCode', { value: 229 });
    input.element.dispatchEvent(confirmation);
    expect(confirmation.defaultPrevented).toBe(false);
    expect(wrapper.emitted('search')).toBeUndefined();

    if (mode === 'tracked') await input.trigger('compositionend');
    const search = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.element.dispatchEvent(search);
    expect(search.defaultPrevented).toBe(true);
    expect(wrapper.emitted('search')).toEqual([['函数']]);
    wrapper.unmount();
  });

  it('waits for composition to finish before searching', async () => {
    vi.useFakeTimers();
    const wrapper = mount(SearchBox, { props: { modelValue: '' } });
    const input = wrapper.get<HTMLInputElement>('input');
    await input.trigger('compositionstart');
    await input.setValue('函数');
    vi.advanceTimersByTime(500);
    expect(wrapper.emitted('search')).toBeUndefined();
    await input.trigger('compositionend');
    vi.advanceTimersByTime(300);
    expect(wrapper.emitted('search')).toEqual([['函数']]);
    wrapper.unmount();
  });

  it('can clear a pending search and returns focus to the field', async () => {
    vi.useFakeTimers();
    const wrapper = mount(SearchBox, { attachTo: document.body, props: { modelValue: 'algebra', busy: true } });
    const input = wrapper.get<HTMLInputElement>('input');
    await input.setValue('geometry');
    await wrapper.get('button').trigger('click');
    vi.advanceTimersByTime(500);
    expect(wrapper.emitted('search')).toEqual([['']]);
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });
});
