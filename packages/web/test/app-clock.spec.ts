import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppClock } from '../src/composables/app-clock.js';

describe('application clock', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses an injectable now provider and refreshes every minute', () => {
    vi.useFakeTimers();
    let wallTime = new Date(2026, 7, 7, 10, 15, 0, 0);
    const clock = createAppClock({ now: () => wallTime });
    clock.start();

    wallTime = new Date(2026, 7, 7, 10, 16, 0, 0);
    vi.advanceTimersByTime(60_000);

    expect(clock.now.value.getTime()).toBe(wallTime.getTime());
    clock.stop();
  });

  it('ticks at local day rollover and when a hidden tab becomes visible', () => {
    vi.useFakeTimers();
    let wallTime = new Date(2026, 7, 7, 23, 59, 59, 900);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const clock = createAppClock({ now: () => wallTime });
    clock.start();

    wallTime = new Date(2026, 7, 8, 0, 0, 0, 25);
    vi.advanceTimersByTime(125);
    expect(clock.dayKey.value).toBe('2026-08-08');

    wallTime = new Date(2026, 7, 8, 8, 45, 0, 0);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(clock.now.value.getHours()).toBe(8);
    expect(clock.now.value.getMinutes()).toBe(45);

    clock.stop();
    visibility.mockRestore();
  });
});
