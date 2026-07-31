/**
 * AI answers already paid for.
 *
 * Every call costs real money, and the same question gets revisited: a wrong
 * answer is reviewed, the drawer is closed and reopened, the tab is reloaded.
 * The cache used to live in a `Map` inside the store, so a reload threw away
 * everything and the next glance at the same answer bought it again.
 *
 * LOCAL ONLY, deliberately. The obvious alternative was a server-side cache
 * shared across devices, but qed2-server's contract forbids question content
 * in its database and an AI explanation is derived question content — most
 * plainly for the whole-question walkthrough. An explanation about YOUR answer
 * is your data, so it stays with you.
 */
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';

/** One stored answer, plus what is needed to expire it. */
export interface CachedAiAnswer<T = unknown> {
  key: string;
  payload: T;
  storedAt: string;
}

const CACHE_KEY = 'answers';

/**
 * Upper bound, oldest-first. The whole cache is one document that is read and
 * rewritten on every miss, so an unbounded map turns each new answer into O(n)
 * work — the same reasoning as the attempt outbox.
 */
export const MAX_CACHED_ANSWERS = 120;

/** Answers older than this are re-fetched; prompts and models move on. */
export const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export class AiCache {
  constructor(private readonly storage: StoragePort) {}

  private async read(): Promise<CachedAiAnswer[]> {
    return (await this.storage.get<CachedAiAnswer[]>(STORAGE.aiCache, CACHE_KEY)) ?? [];
  }

  async get<T>(key: string, now = new Date()): Promise<T | undefined> {
    const hit = (await this.read()).find((e) => e.key === key);
    if (!hit) return undefined;
    const age = now.getTime() - new Date(hit.storedAt).getTime();
    // A clock that moved backwards produces a negative age; treat anything
    // outside the window as stale rather than trusting it.
    if (!Number.isFinite(age) || age < 0 || age > CACHE_MAX_AGE_MS) return undefined;
    return hit.payload as T;
  }

  async set<T>(key: string, payload: T, now = new Date()): Promise<void> {
    const entries = (await this.read()).filter((e) => e.key !== key);
    entries.unshift({ key, payload, storedAt: now.toISOString() });
    if (entries.length > MAX_CACHED_ANSWERS) entries.length = MAX_CACHED_ANSWERS;
    await this.storage.set(STORAGE.aiCache, CACHE_KEY, entries);
  }

  /** Offered in the settings alongside the key, so "forget it" means all of it. */
  async clear(): Promise<void> {
    await this.storage.set(STORAGE.aiCache, CACHE_KEY, []);
  }

  async size(): Promise<number> {
    return (await this.read()).length;
  }
}
