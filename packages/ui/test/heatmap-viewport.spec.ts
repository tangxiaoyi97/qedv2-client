import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ActivityHeatmap from '../src/review/ActivityHeatmap.vue';

describe('ActivityHeatmap viewport', () => {
  let viewportWidth: number;
  let resize: () => void;
  let pointerChange: () => void;
  let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
  let wrapper: VueWrapper | undefined;
  const disconnect = vi.fn();

  beforeEach(() => {
    viewportWidth = 320;
    resize = () => undefined;
    pointerChange = () => undefined;
    media = {
      matches: false,
      addEventListener: vi.fn((_event, callback) => { pointerChange = callback; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('q-heat__scroll') ? viewportWidth : 0;
    });
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('q-heat__scroll')
        ? Number(this.querySelector('svg')?.getAttribute('width') ?? 0) : 0;
    });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function render() {
    wrapper = mount(ActivityHeatmap, {
      attachTo: document.body,
      props: { weeks: 52, endDate: '2026-09-10', data: {} },
    });
    await nextTick();
    return wrapper.get<HTMLDivElement>('.q-heat__scroll').element;
  }

  it('waits for a visible size and opens the latest range after asynchronous layout', async () => {
    viewportWidth = 0;
    const scroll = await render();
    viewportWidth = 280;
    resize();
    await nextTick();
    expect(scroll.scrollLeft).toBe(scroll.scrollWidth - viewportWidth);
  });

  it('keeps the latest day visible when the container or pointer pitch changes', async () => {
    const scroll = await render();
    viewportWidth = 240;
    resize();
    expect(scroll.scrollLeft).toBe(scroll.scrollWidth - viewportWidth);
    media.matches = true;
    pointerChange();
    await nextTick();
    expect(scroll.scrollLeft).toBe(scroll.scrollWidth - viewportWidth);
  });

  it('preserves manual history browsing across data, resize and hidden-to-visible updates', async () => {
    const scroll = await render();
    scroll.scrollLeft = 174;
    scroll.dispatchEvent(new Event('scroll'));
    await wrapper!.setProps({ data: { '2026-09-10': 2 } });
    viewportWidth = 240;
    resize();
    expect(scroll.scrollLeft).toBe(174);
    // display:none can reset the browser's scroll offset during a refresh.
    viewportWidth = 0;
    scroll.scrollLeft = 0;
    scroll.dispatchEvent(new Event('scroll'));
    resize();
    viewportWidth = 240;
    resize();
    expect(scroll.scrollLeft).toBe(174);
    media.matches = true;
    pointerChange();
    await nextTick();
    expect(scroll.scrollLeft).toBe(224); // the same week, with a wider touch pitch
  });

  it('allows an explicit return to the latest range and follows later resizing again', async () => {
    const scroll = await render();
    scroll.scrollLeft = 40;
    scroll.dispatchEvent(new Event('scroll'));
    await nextTick();
    await wrapper!.get('.q-heat__latest').trigger('click');
    expect(scroll.scrollLeft).toBe(scroll.scrollWidth - viewportWidth);
    viewportWidth = 220;
    resize();
    expect(scroll.scrollLeft).toBe(scroll.scrollWidth - viewportWidth);
    expect(wrapper!.emitted('select')).toBeUndefined();
  });

  it('supports Home and End without selecting a date or adding every day to the tab order', async () => {
    const scroll = await render();
    const latest = wrapper!.get('[data-key="2026-09-10"]');
    await latest.trigger('keydown', { key: 'Home' });
    await nextTick();
    const first = wrapper!.findAll('.q-heat__cell')[0]!;
    expect(first.attributes('tabindex')).toBe('0');
    expect(scroll.scrollLeft).toBe(0);
    await first.trigger('keydown', { key: 'End' });
    await nextTick();
    expect(latest.attributes('tabindex')).toBe('0');
    expect(scroll.scrollLeft).toBe(scroll.scrollWidth - viewportWidth);
    expect(wrapper!.findAll('.q-heat__cell[tabindex="0"]')).toHaveLength(1);
    expect(wrapper!.get('.q-heat__svg').attributes('role')).toBe('group');
    expect(wrapper!.emitted('select')).toBeUndefined();
  });

  it('starts keyboard movement from the day focused by a pointer', async () => {
    await render();
    const day = wrapper!.get('[data-key="2026-07-02"]');
    await day.trigger('focus');
    await day.trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    expect(wrapper!.get('[data-key="2026-07-09"]').attributes('tabindex')).toBe('0');
    await wrapper!.get('[data-key="2026-07-09"]').trigger('keydown', { key: 'Enter' });
    expect(wrapper!.emitted('select')).toEqual([['2026-07-09']]);
  });
});
