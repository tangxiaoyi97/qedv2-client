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
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { hasAtomicStorage, STORAGE } from '../ports/index.js';
import type { CoreSourcePreference, StoragePort } from '../ports/index.js';
import type { Grading } from '../model/archive.js';
import type { Verdict } from '../grading/types.js';
import { localActivityRange, localDayKey } from '../model/format.js';
import {
  historyStorageKey,
  isLocalProfileId,
  type LocalProfileId,
} from './local-profile-store.js';

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
const MAX_CAS_ATTEMPTS = 6;
export const HISTORY_EVENT_ROW_PREFIX = 'history-event/v2/';

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
  return entries;
}

export interface StoredHistoryEvent {
  version: 2;
  profileId: LocalProfileId | null;
  entry: HistoryEntry;
}

function validateEventId(value: string): void {
  if (!value || value.length > 256 || value.includes('\0')) {
    throw new TypeError('Invalid history event identity');
  }
}

function historyProfilePrefix(profileId: LocalProfileId | null | undefined): string {
  return `${HISTORY_EVENT_ROW_PREFIX}${encodeURIComponent(profileId ?? '__legacy__')}/`;
}

export function historyEventRowKey(
  clientAttemptId: string,
  profileId?: LocalProfileId | null,
): string {
  validateEventId(clientAttemptId);
  return `${historyProfilePrefix(profileId)}${encodeURIComponent(clientAttemptId)}`;
}

export function prepareStoredHistoryEvent(
  profileId: LocalProfileId | undefined,
  entry: HistoryEntry,
): StoredHistoryEvent {
  return { version: 2, profileId: profileId ?? null, entry: { ...entry } };
}

export function parseStoredHistoryEvent(value: unknown): StoredHistoryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local history event is malformed');
  }
  const row = value as Partial<StoredHistoryEvent>;
  if (
    row.version !== 2
    || (row.profileId !== null && !isLocalProfileId(row.profileId))
    || !row.entry
    || typeof row.entry !== 'object'
    || Array.isArray(row.entry)
    || typeof row.entry.partId !== 'string'
    || typeof row.entry.questionId !== 'string'
    || typeof row.entry.gradedAt !== 'string'
    || Number.isNaN(Date.parse(row.entry.gradedAt))
  ) {
    throw new Error('Local history event is malformed');
  }
  const [entry] = prepareHistoryLog([row.entry]);
  if (!entry) throw new Error('Local history event is malformed');
  return { version: 2, profileId: row.profileId, entry };
}

function sameStoredEvent(left: StoredHistoryEvent, right: StoredHistoryEvent): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function legacyEventDigest(entry: HistoryEntry): string {
  return bytesToHex(sha256(utf8ToBytes(stableJson(entry))));
}

/**
 * Assign duplicate occurrences from oldest to newest. A 2.1 writer prepends
 * new entries, so counting from the tail keeps every previously observed ID
 * stable when a migration CAS retries against the longer snapshot.
 */
function legacyEventIds(entries: readonly HistoryEntry[]): Array<string | undefined> {
  const occurrences = new Map<string, number>();
  const ids = new Array<string | undefined>(entries.length);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.clientAttemptId) continue;
    const digest = legacyEventDigest(entry);
    const occurrence = occurrences.get(digest) ?? 0;
    occurrences.set(digest, occurrence + 1);
    ids[index] = `legacy-${digest}-${occurrence.toString(16).padStart(16, '0')}`;
  }
  return ids;
}

function anonymousEventId(): string {
  const native = globalThis.crypto?.randomUUID?.();
  if (native) return `anonymous-${native}`;
  const entropy = new Uint8Array(32);
  globalThis.crypto?.getRandomValues?.(entropy);
  if (entropy.every((value) => value === 0)) {
    throw new Error('Secure history event identity generation is unavailable');
  }
  return `anonymous-${bytesToHex(sha256(entropy))}`;
}

export class HistoryLog {
  constructor(
    private readonly storage: StoragePort,
    private readonly profileId?:
      | LocalProfileId
      | (() => LocalProfileId | readonly LocalProfileId[] | undefined),
  ) {}

  private profiles(): readonly LocalProfileId[] {
    const configured = typeof this.profileId === 'function' ? this.profileId() : this.profileId;
    if (configured === undefined) return [];
    return Array.isArray(configured) ? configured : [configured as LocalProfileId];
  }

  private primaryProfile(): LocalProfileId | undefined {
    return this.profiles()[0];
  }

  private async putRow(row: StoredHistoryEvent, id: string): Promise<void> {
    const key = historyEventRowKey(id, row.profileId);
    if (!hasAtomicStorage(this.storage)) {
      const existing = await this.storage.get<unknown>(STORAGE.history, key);
      if (existing !== undefined) {
        if (!sameStoredEvent(parseStoredHistoryEvent(existing), row)) {
          throw new Error('Client attempt identity was reused with different history data');
        }
        return;
      }
      await this.storage.set(STORAGE.history, key, row);
      return;
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([{ collection: STORAGE.history, key }]);
      if (!snapshot) throw new Error('History event row read returned no entry');
      if (snapshot.exists) {
        if (!sameStoredEvent(parseStoredHistoryEvent(snapshot.value), row)) {
          throw new Error('Client attempt identity was reused with different history data');
        }
        return;
      }
      const committed = await this.storage.commitBatch({
        ifRevisions: [{ collection: STORAGE.history, key, revision: snapshot.revision }],
        mutations: [{ collection: STORAGE.history, key, operation: 'set', value: row }],
      });
      if (committed.committed) return;
    }
    throw new Error('History event row changed too often');
  }

  private async migrateLegacy(): Promise<void> {
    const profiles = this.profiles();
    const sources: Array<{ profileId: LocalProfileId | undefined; key: string }> = profiles.length > 0
      ? profiles.map((profileId) => ({ profileId, key: historyStorageKey(profileId) }))
      : [{ profileId: undefined, key: HISTORY_STORAGE_KEY }];
    for (const source of sources) {
      if (!hasAtomicStorage(this.storage)) {
        const raw = await this.storage.get<unknown>(STORAGE.history, source.key);
        if (raw === undefined) continue;
        const entries = prepareHistoryLog(raw);
        const generatedIds = legacyEventIds(entries);
        for (const [index, entry] of entries.entries()) {
          await this.putRow(
            prepareStoredHistoryEvent(source.profileId, entry),
            entry.clientAttemptId ?? generatedIds[index]!,
          );
        }
        // Without a source revision, deletion could erase a concurrent append.
        // Keep a scrubbed bounded document for another idempotent pass.
        await this.storage.set(STORAGE.history, source.key, entries);
        continue;
      }
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const address = { collection: STORAGE.history, key: source.key } as const;
        const [snapshot] = await this.storage.readBatch([address]);
        if (!snapshot) throw new Error('Legacy history read returned no entry');
        if (!snapshot.exists) break;
        const entries = prepareHistoryLog(snapshot.value);
        const generatedIds = legacyEventIds(entries);
        for (const [index, entry] of entries.entries()) {
          await this.putRow(
            prepareStoredHistoryEvent(source.profileId, entry),
            entry.clientAttemptId ?? generatedIds[index]!,
          );
        }
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...address, revision: snapshot.revision }],
          mutations: [{ ...address, operation: 'delete' }],
        });
        if (committed.committed) break;
        if (attempt === MAX_CAS_ATTEMPTS - 1) {
          throw new Error('Legacy history kept changing during migration');
        }
      }
    }
  }

  private async read(): Promise<Array<{ key: string; row: StoredHistoryEvent }>> {
    await this.migrateLegacy();
    const accepted = new Set<LocalProfileId | null>(this.profiles());
    if (accepted.size === 0) accepted.add(null);
    const prefixes = accepted.size > 0
      ? [...accepted].map((profileId) => historyProfilePrefix(profileId))
      : [historyProfilePrefix(null)];
    const keys = (await this.storage.keys(STORAGE.history))
      .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    const values = new Map<string, unknown>();
    if (hasAtomicStorage(this.storage)) {
      for (let offset = 0; offset < keys.length; offset += 32) {
        const entries = await this.storage.readBatch(
          keys.slice(offset, offset + 32).map((key) => ({ collection: STORAGE.history, key })),
        );
        for (const entry of entries) if (entry.exists) values.set(entry.key, entry.value);
      }
    } else {
      await Promise.all(keys.map(async (key) => {
        const value = await this.storage.get<unknown>(STORAGE.history, key);
        if (value !== undefined) values.set(key, value);
      }));
    }
    const rows = keys.map((key) => {
      const value = values.get(key);
      if (value === undefined) return undefined;
      const row = parseStoredHistoryEvent(value);
      return accepted.has(row.profileId) ? { key, row } : undefined;
    });
    const sorted = rows
      .filter((row): row is { key: string; row: StoredHistoryEvent } => row !== undefined)
      .sort((left, right) =>
        right.row.entry.gradedAt.localeCompare(left.row.entry.gradedAt)
        || right.key.localeCompare(left.key));
    return sorted;
  }

  async append(entry: HistoryEntry): Promise<void> {
    // Compatibility for isolated consumers that have not initialized local
    // profiles yet: retain the legacy document until LocalProfileStore can
    // atomically assign it to a concrete guest/account profile.
    if (this.profiles().length === 0) {
      const entries = prepareHistoryAppend(
        await this.storage.get<unknown>(STORAGE.history, HISTORY_STORAGE_KEY),
        entry,
      );
      await this.storage.set(STORAGE.history, HISTORY_STORAGE_KEY, entries);
      return;
    }
    await this.migrateLegacy();
    await this.putRow(
      prepareStoredHistoryEvent(this.primaryProfile(), entry),
      entry.clientAttemptId ?? anonymousEventId(),
    );
  }

  /** Newest-first slice. */
  async list(limit = 200, offset = 0): Promise<HistoryEntry[]> {
    const rows = await this.read();
    return rows.slice(offset, offset + limit).map(({ row }) => row.entry);
  }

  /**
   * One newest-first immutable view for screens that need list, count and
   * activity from the same local snapshot. This avoids three complete
   * IndexedDB/SQLite scans while keeping the smaller convenience APIs.
   */
  async snapshot(): Promise<HistoryEntry[]> {
    return (await this.read()).map(({ row }) => ({ ...row.entry }));
  }

  /** Newest-first entries for one LOCAL day, keyed as `YYYY-MM-DD`. */
  async listByLocalDay(dayKey: string): Promise<HistoryEntry[]> {
    const rows = await this.read();
    return rows
      .map(({ row }) => row.entry)
      .filter((entry) => localDayKey(new Date(entry.gradedAt)) === dayKey);
  }

  async count(): Promise<number> {
    return (await this.read()).length;
  }

  /**
   * Daily activity counts (heatmap feed): local-date keys `YYYY-MM-DD` for
   * the last `days` days, counting answer events per day.
   */
  async dailyActivity(days: number, now: Date): Promise<Record<string, number>> {
    const entries = (await this.read()).map(({ row }) => row.entry);
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
