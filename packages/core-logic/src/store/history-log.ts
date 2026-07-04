/**
 * Local practice-history log — append-only record of answer events, used by
 * the Verlauf page and the activity heatmap.
 *
 * SCOPE: local-only by design. The server stores only the LATEST state per
 * part (contract §4.2); `POST /me/attempts` is an optional write-only audit
 * stream with no read-back endpoint, so a cross-device history is not
 * possible with the current backend — this log covers this device.
 */
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import type { Grading } from '../model/archive.js';
import type { Verdict } from '../grading/types.js';

export interface HistoryEntry {
  partId: string;
  questionId: string;
  verdict: Verdict;
  awardedPoints: number;
  maxPoints: number;
  grading: Grading;
  /** ISO 8601 UTC. */
  gradedAt: string;
  elapsedMs?: number;
}

/** Storage layout: one document holding the newest-first entry array. */
const HISTORY_KEY = 'log';
/** Retention cap — plenty for a personal tracker, bounded for IndexedDB. */
const MAX_ENTRIES = 5000;

export class HistoryLog {
  constructor(private readonly storage: StoragePort) {}

  private async read(): Promise<HistoryEntry[]> {
    return (await this.storage.get<HistoryEntry[]>(STORAGE.history, HISTORY_KEY)) ?? [];
  }

  async append(entry: HistoryEntry): Promise<void> {
    const entries = await this.read();
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    await this.storage.set(STORAGE.history, HISTORY_KEY, entries);
  }

  /** Newest-first slice. */
  async list(limit = 200, offset = 0): Promise<HistoryEntry[]> {
    const entries = await this.read();
    return entries.slice(offset, offset + limit);
  }

  /** Newest-first entries for one LOCAL day, keyed as `YYYY-MM-DD`. */
  async listByLocalDay(dayKey: string): Promise<HistoryEntry[]> {
    const entries = await this.read();
    return entries.filter((e) => {
      const t = new Date(e.gradedAt);
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      return key === dayKey;
    });
  }

  async count(): Promise<number> {
    return (await this.read()).length;
  }

  /**
   * Daily activity counts (heatmap feed): local-date keys `YYYY-MM-DD` for
   * the last `days` days, counting answer events per day.
   */
  async dailyActivity(days: number, now: Date): Promise<Record<string, number>> {
    const entries = await this.read();
    const cutoff = now.getTime() - days * 86_400_000;
    const out: Record<string, number> = {};
    for (const e of entries) {
      const t = new Date(e.gradedAt);
      if (t.getTime() < cutoff) break; // newest-first: everything after is older
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }
}
