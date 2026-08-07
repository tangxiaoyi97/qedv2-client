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
import type { CoreSourcePreference, StoragePort } from '../ports/index.js';
import type { Grading } from '../model/archive.js';
import type { Verdict } from '../grading/types.js';
import { localActivityRange, localDayKey } from '../model/format.js';

export interface HistoryEntry {
  /** Stable local event identity; absent only on pre-2.1 history rows. */
  clientAttemptId?: string;
  partId: string;
  questionId: string;
  verdict: Verdict;
  awardedPoints: number;
  maxPoints: number;
  grading: Grading;
  /** ISO 8601 UTC. */
  gradedAt: string;
  elapsedMs?: number;
  /** Local audit provenance; never required by the cloud history contract. */
  contentSource?: CoreSourcePreference;
  /** Verified bank commit when the renderer could determine it. */
  contentId?: string;
}

/** Storage layout: one document holding the newest-first entry array. */
export const HISTORY_STORAGE_KEY = 'log';
/** Retention cap — plenty for a personal tracker, bounded for IndexedDB. */
const MAX_ENTRIES = 5000;

type LegacyHistoryEntry = HistoryEntry & { submittedText?: unknown; criteriaMet?: unknown };

/** Pure history migration/preparation used by atomic grade commits. */
export function prepareHistoryLog(value: unknown): HistoryEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Local history is malformed');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Local history contains an invalid row');
    }
    const entry = { ...(raw as LegacyHistoryEntry) };
    delete entry.submittedText;
    delete entry.criteriaMet;
    return entry;
  });
}

export function prepareHistoryAppend(value: unknown, entry: HistoryEntry): HistoryEntry[] {
  const entries = prepareHistoryLog(value);
  if (
    entry.clientAttemptId
    && entries.some((candidate) => candidate.clientAttemptId === entry.clientAttemptId)
  ) {
    return entries;
  }
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entries;
}

export class HistoryLog {
  constructor(private readonly storage: StoragePort) {}

  private async read(): Promise<HistoryEntry[]> {
    const stored = (await this.storage.get<LegacyHistoryEntry[]>(STORAGE.history, HISTORY_STORAGE_KEY)) ?? [];
    if (!stored.some((entry) => 'submittedText' in entry || 'criteriaMet' in entry)) return stored;

    // RC builds briefly retained raw answers for an internal evaluation. That
    // behaviour was never part of the product contract; scrub the legacy
    // fields on first access instead of leaving sensitive beta data behind.
    const cleaned = stored.map((legacy) => {
      const entry = { ...legacy };
      delete entry.submittedText;
      delete entry.criteriaMet;
      return entry;
    });
    await this.storage.set(STORAGE.history, HISTORY_STORAGE_KEY, cleaned);
    return cleaned;
  }

  async append(entry: HistoryEntry): Promise<void> {
    const entries = prepareHistoryAppend(await this.read(), entry);
    await this.storage.set(STORAGE.history, HISTORY_STORAGE_KEY, entries);
  }

  /** Newest-first slice. */
  async list(limit = 200, offset = 0): Promise<HistoryEntry[]> {
    const entries = await this.read();
    return entries.slice(offset, offset + limit);
  }

  /** Newest-first entries for one LOCAL day, keyed as `YYYY-MM-DD`. */
  async listByLocalDay(dayKey: string): Promise<HistoryEntry[]> {
    const entries = await this.read();
    return entries.filter((e) => localDayKey(new Date(e.gradedAt)) === dayKey);
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
    // Calendar days, not rolling 24-hour windows. The old cutoff started at
    // the current clock time `days` ago, so answers from the morning of the
    // first visible day disappeared from the heatmap. Constructing a local
    // midnight also stays correct across daylight-saving transitions.
    const cutoff = new Date(localActivityRange(days, now).since);
    const out: Record<string, number> = {};
    for (const e of entries) {
      const t = new Date(e.gradedAt);
      if (t.getTime() < cutoff.getTime()) break; // newest-first: everything after is older
      const key = localDayKey(t);
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }
}
