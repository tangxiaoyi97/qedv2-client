import { computed, readonly, shallowRef, type ComputedRef, type DeepReadonly, type Ref } from 'vue';

const MINUTE_MS = 60_000;
const MIDNIGHT_SLOP_MS = 25;

export interface AppClockOptions {
  /** Injectable wall clock for deterministic tests. */
  now?: () => Date;
}

export interface AppClock {
  now: DeepReadonly<Ref<Date>>;
  dayKey: ComputedRef<string>;
  start: () => void;
  stop: () => void;
  refresh: () => void;
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * One reactive wall clock for time-derived UI. It ticks once a minute, again
 * exactly after local midnight, and immediately when a suspended tab becomes
 * visible. Consumers no longer cache `new Date()` inside unrelated computeds.
 */
export function createAppClock(options: AppClockOptions = {}): AppClock {
  const readNow = options.now ?? (() => new Date());
  const current = shallowRef(new Date(readNow().getTime()));
  let minuteTimer: ReturnType<typeof setInterval> | undefined;
  let midnightTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  const refresh = (): void => {
    current.value = new Date(readNow().getTime());
  };

  const scheduleMidnight = (): void => {
    if (midnightTimer !== undefined) clearTimeout(midnightTimer);
    const now = readNow();
    const next = new Date(now.getTime());
    next.setHours(24, 0, 0, MIDNIGHT_SLOP_MS);
    midnightTimer = setTimeout(() => {
      refresh();
      scheduleMidnight();
    }, Math.max(1, next.getTime() - now.getTime()));
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    refresh();
    scheduleMidnight();
  };

  const start = (): void => {
    if (started || typeof window === 'undefined') return;
    started = true;
    refresh();
    minuteTimer = setInterval(refresh, MINUTE_MS);
    scheduleMidnight();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    if (minuteTimer !== undefined) clearInterval(minuteTimer);
    if (midnightTimer !== undefined) clearTimeout(midnightTimer);
    minuteTimer = undefined;
    midnightTimer = undefined;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };

  return {
    now: readonly(current),
    dayKey: computed(() => localDayKey(current.value)),
    start,
    stop,
    refresh,
  };
}

const appClock = createAppClock();

/** App-lifetime singleton; `start()` is idempotent across Pinia consumers. */
export function useAppClock(): AppClock {
  appClock.start();
  return appClock;
}
