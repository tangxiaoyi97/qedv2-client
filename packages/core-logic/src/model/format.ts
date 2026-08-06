/**
 * Austrian-German presentation helpers.
 *
 * Platform-free on purpose: every shell shows the same numbers and the same
 * day keys, and these were previously reimplemented per view — two different
 * rounding behaviours for points were shipping side by side, and the same
 * day-key parser existed under two names.
 */
/** Points carry at most two decimals; anything finer is float noise. */
export function roundScore(points: number): number {
  return Math.round(points * 100) / 100;
}

/** `1` → "1", `0.5` → "0,5". The single spelling of a score in this app. */
export function formatScore(points: number): string {
  const rounded = roundScore(points);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
}

/** `awarded / max P`, both formatted the same way. */
export function formatScoreRatio(awarded: number, max: number): string {
  return `${formatScore(awarded)} / ${formatScore(max)} P`;
}

/** A Date grouped by the user's local calendar, not by UTC. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A `YYYY-MM-DD` activity key back into a LOCAL midnight Date.
 *
 * `new Date('2026-07-28')` would parse as UTC and land on the previous day
 * west of Greenwich, which is why the parts are passed separately.
 */
export function parseLocalDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  // `?? 1970` only covers a MISSING part; a non-numeric one yields NaN and an
  // Invalid Date, which then throws inside Intl.DateTimeFormat rather than
  // rendering something harmless.
  const num = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? (value as number) : fallback;
  return new Date(num(year, 1970), num(month, 1) - 1, num(day, 1));
}

/** The ISO bounds of the local day a key names — inclusive start, inclusive end. */
export function localDayRange(key: string): { since: string; until: string } {
  const start = parseLocalDayKey(key);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, -1);
  return { since: start.toISOString(), until: end.toISOString() };
}

/** Inclusive ISO window covering complete local calendar days. */
export function localActivityRange(days: number, now: Date): { since: string; until: string } {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1;
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (safeDays - 1));
  return {
    since: localDayRange(localDayKey(first)).since,
    until: localDayRange(localDayKey(now)).until,
  };
}
