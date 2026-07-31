/**
 * Local practice-history log — append-only record of answer events, used by
 * the Verlauf page and the activity heatmap.
 *
 * SCOPE: this device. The archive the server syncs holds only the LATEST
 * state per part (contract §4.2), so the per-answer trail lives here. Signed
 * in, the cloud audit trail (`GET /me/history`) is the authoritative
 * cross-device history and the Verlauf page reads that instead; this log is
 * what guests get, and it is never backfilled into the cloud.
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

  /* --- evaluation material (local only, never synced) ---------------------
   * The answer the user wrote, and — for self-assessed parts — the criteria
   * they ticked themselves.
   *
   * This exists because the AI grading evaluation needs labelled data and
   * there was none: every store recorded the SCORE an answer received and
   * none recorded the answer, so a grader could not be replayed against real
   * work. These two fields turn ordinary practice into that dataset.
   *
   * Local only, by design. It is a person's own written work; it stays on
   * their device, never enters the synced archive, and is not part of the
   * checksum. Capped like everything else here.
   */
  submittedText?: string;
  criteriaMet?: boolean[];
}

/** Answers longer than this are truncated — the log is a tail, not a backup. */
export const MAX_SUBMITTED_CHARS = 4000;

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
    if (entry.submittedText !== undefined) {
      const trimmed = entry.submittedText.trim();
      if (trimmed) entry.submittedText = trimmed.slice(0, MAX_SUBMITTED_CHARS);
      else delete entry.submittedText;
    }
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
