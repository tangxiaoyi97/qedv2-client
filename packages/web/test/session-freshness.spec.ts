import { describe, expect, it } from 'vitest';
import { isResumable } from '../src/stores/practice.js';

/**
 * „Programm starten" means TODAY's programme. Without a bound the same
 * half-finished list came back forever and FSRS never ran again; with a bound
 * that is only the calendar day, a session started at 23:50 would be thrown
 * away ten minutes later.
 */
const at = (iso: string): Date => new Date(iso);

describe('session freshness', () => {
  it('resumes a programme from earlier the same day', () => {
    expect(isResumable('smart', '2026-07-28T08:00:00', at('2026-07-28T19:00:00'))).toBe(true);
  });

  it('drops a programme from a previous day', () => {
    expect(isResumable('smart', '2026-07-27T19:00:00', at('2026-07-28T19:00:00'))).toBe(false);
  });

  it('still resumes one that merely straddled midnight', () => {
    expect(isResumable('smart', '2026-07-27T23:50:00', at('2026-07-28T00:10:00'))).toBe(true);
  });

  it('does not let the grace revive a programme hours into the new day', () => {
    expect(isResumable('smart', '2026-07-27T23:50:00', at('2026-07-28T12:00:00'))).toBe(false);
  });

  it('keeps a hand-picked set for a week, then lets it go', () => {
    expect(isResumable('manual', '2026-07-22T10:00:00', at('2026-07-28T10:00:00'))).toBe(true);
    expect(isResumable('manual', '2026-07-20T10:00:00', at('2026-07-28T10:00:00'))).toBe(false);
  });

  it('refuses a snapshot from the future or with an unreadable timestamp', () => {
    // A device clock that moved backwards must not resurrect anything.
    expect(isResumable('smart', '2026-07-29T10:00:00', at('2026-07-28T10:00:00'))).toBe(false);
    expect(isResumable('smart', 'not-a-date', at('2026-07-28T10:00:00'))).toBe(false);
  });
});
