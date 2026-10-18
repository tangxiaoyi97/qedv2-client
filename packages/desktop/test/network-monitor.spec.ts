import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ online: true, power: undefined as EventEmitter | undefined }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  mocks.power = new EventEmitter();
  return { net: { isOnline: () => mocks.online }, powerMonitor: mocks.power };
});
import { NetworkMonitor } from '../src/main/network-monitor.js';

describe('NetworkMonitor wake recovery', () => {
  let monitor: NetworkMonitor;
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.online = true;
    monitor = new NetworkMonitor();
  });
  afterEach(() => { monitor.stop(); vi.useRealTimers(); });

  it('reports a wake even when connectivity remains online and coalesces repeated wake events', () => {
    const resumed = vi.fn();
    const changed = vi.fn();
    monitor.on('resume', resumed).on('change', changed);
    monitor.start();
    monitor.start();
    expect(mocks.power?.listenerCount('resume')).toBe(1);
    mocks.power?.emit('resume');
    vi.advanceTimersByTime(1_000);
    mocks.power?.emit('resume');
    vi.advanceTimersByTime(1_999);
    expect(resumed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resumed).toHaveBeenCalledExactlyOnceWith(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it('samples the current connection after wake and disposes pending callbacks on shutdown', () => {
    const resumed = vi.fn();
    const changed = vi.fn();
    monitor.on('resume', resumed).on('change', changed);
    monitor.start();
    mocks.power?.emit('resume');
    mocks.online = false;
    vi.advanceTimersByTime(2_000);
    expect(changed).toHaveBeenCalledExactlyOnceWith(false);
    expect(resumed).toHaveBeenCalledExactlyOnceWith(false);
    mocks.power?.emit('resume');
    monitor.stop();
    vi.advanceTimersByTime(6_000);
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(mocks.power?.listenerCount('resume')).toBe(0);
  });
});
