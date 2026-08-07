/**
 * Practice session store — drives the practice flow:
 * recommend (or explicit selection) → fetch full questions → per-part
 * answer/grade cycle → archive updates → periodic sync.
 *
 * Grading supplement: excluded parts are filtered OUT of every session
 * source (they are also projected away in the recommend userState); manual
 * grading overrides rebase FSRS on the pre-answer snapshot kept per part.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  CoreClient,
  CoreProtocolError,
  GUEST_ATTEMPT_OWNER,
  hasAtomicStorage,
  questionContentHash,
  STORAGE,
} from '@qed2/core-logic';
import type {
  AttemptOwnerSnapshot,
  ContentQuestion,
  CoreSourcePreference,
  FsrsState,
  GradeResult,
  Grading,
  ManifestResponse,
  Question,
  QuestionPart,
  QuestionsFilter,
  RecommendReason,
  Submission,
  QueuedAttempt,
} from '@qed2/core-logic';
import { ports, questionCache, storage } from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';
import { useProgressStore } from './progress.js';

/** Sync after every N graded parts while logged in (brief §5: sync eagerly). */
const SYNC_EVERY_N_GRADES = 3;
/**
 * A hand-picked set is an ad-hoc thing; resurrecting a week-old one is more
 * surprise than convenience. A programme is bounded by the day instead — see
 * `isResumable`.
 */
const MANUAL_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Grace for a programme that straddles midnight. Strict same-day alone would
 * throw away a session started at 23:50 the moment the user came back ten
 * minutes later — technically a new day, obviously the same sitting.
 */
const SMART_SESSION_GRACE_MS = 6 * 60 * 60 * 1000;
const SESSION_STORAGE_KEY = 'practice-session';
const SESSION_STORAGE_VERSION = 4;
const MAX_PINNED_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_ASSET_BYTES = 32 * 1024 * 1024;

/**
 * Where a session came from. „Programm üben" in the navigation means the
 * FSRS programme for today; a hand-picked set from the Aufgaben list is a
 * different thing that happens to use the same screen. Without this tag the
 * two are indistinguishable once the session is running, and the plain
 * /practice entry silently resumed whichever set was last open.
 */
export type SessionOrigin = 'smart' | 'manual';

export interface SessionItem {
  questionId: string;
  partId: string;
  reason: RecommendReason | 'manual';
}

export interface GradedRecord {
  clientAttemptId: string;
  partId: string;
  questionId: string;
  result: GradeResult;
  reason: SessionItem['reason'];
  gradedAt: string;
  elapsedMs: number;
}

interface PersistedPracticeSession {
  version: 2 | 3 | typeof SESSION_STORAGE_VERSION;
  /** Added in v3; v2 is migrated using the owner of the key being read. */
  owner?: AttemptOwnerSnapshot;
  /** Added in v4; older/malformed sessions require an explicit current-bank choice. */
  contentSource?: CoreSourcePreference;
  /** Immutable bank revision used to validate an offline resume. */
  contentId?: string;
  origin: SessionOrigin;
  items: SessionItem[];
  index: number;
  graded: GradedRecord[];
  savedAt: string;
}

function isPersistedPracticeSession(value: unknown): value is PersistedPracticeSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedPracticeSession>;
  return (candidate.version === 2 || candidate.version === 3 || candidate.version === SESSION_STORAGE_VERSION)
    && (candidate.version === 2
      || (candidate.owner !== undefined
        && typeof candidate.owner.userId === 'string'
        && (candidate.owner.guestGeneration === undefined
          || typeof candidate.owner.guestGeneration === 'string')))
    && (candidate.version !== SESSION_STORAGE_VERSION
      || ((candidate.contentSource === undefined
        || candidate.contentSource === 'local'
        || candidate.contentSource === 'remote')
        && (candidate.contentId === undefined || typeof candidate.contentId === 'string')))
    && (candidate.origin === 'smart' || candidate.origin === 'manual')
    && Array.isArray(candidate.items)
    && candidate.items.every((item) =>
      item
      && typeof item === 'object'
      && typeof item.questionId === 'string'
      && typeof item.partId === 'string'
      && typeof item.reason === 'string')
    && typeof candidate.index === 'number'
    && Number.isInteger(candidate.index)
    && candidate.index >= 0
    && typeof candidate.savedAt === 'string'
    && Array.isArray(candidate.graded)
    && candidate.graded.every((record) =>
      record
      && typeof record === 'object'
      && typeof record.clientAttemptId === 'string'
      && typeof record.partId === 'string'
      && typeof record.questionId === 'string'
      && typeof record.reason === 'string'
      && typeof record.gradedAt === 'string'
      && typeof record.elapsedMs === 'number'
      && record.result
      && typeof record.result === 'object'
      && typeof record.result.verdict === 'string'
      && typeof record.result.correct === 'boolean'
      && typeof record.result.awardedPoints === 'number'
      && typeof record.result.maxPoints === 'number');
}

/** A persisted session may resume automatically only with complete provenance. */
function hasExactContentProvenance(
  snapshot: PersistedPracticeSession,
): snapshot is PersistedPracticeSession & {
  version: typeof SESSION_STORAGE_VERSION;
  contentSource: CoreSourcePreference;
  contentId: string;
} {
  return snapshot.version === SESSION_STORAGE_VERSION
    && (snapshot.contentSource === 'local' || snapshot.contentSource === 'remote')
    && typeof snapshot.contentId === 'string'
    && /^[0-9a-f]{40}$/u.test(snapshot.contentId);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Whether a snapshot still deserves to be handed back.
 *
 * „Programm starten" means TODAY's FSRS programme. Without a bound, a
 * half-finished programme was resumed forever: every entry point routes to a
 * bare /practice, so the user stayed pinned to a stale item list and new due
 * reviews were never offered again until they ground through it. `savedAt`
 * was being written and never read.
 */
export function isResumable(origin: SessionOrigin, savedAt: string, now: Date): boolean {
  const saved = new Date(savedAt);
  if (Number.isNaN(saved.getTime())) return false;
  if (saved.getTime() > now.getTime() + 60_000) return false; // clock moved back
  const age = now.getTime() - saved.getTime();
  return origin === 'smart'
    ? isSameLocalDay(saved, now) || age < SMART_SESSION_GRACE_MS
    : age < MANUAL_SESSION_MAX_AGE_MS;
}

function createClientAttemptId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** A protocol/revision violation must never degrade to a stale-cache session. */
class ContentIntegrityError extends Error {
  override readonly name = 'ContentIntegrityError';
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function assetKey(src: string): string {
  return src.replace(/^\/+/, '').replace(/^assets\//, '');
}

/** Collect only paths that the UI resolves as bank assets. */
function questionAssetPaths(question: Question): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (
      typeof node.src === 'string'
      && (node.t === 'fig' || node.kind === 'image')
    ) paths.add(assetKey(node.src));
    for (const nested of Object.values(node)) visit(nested);
  };
  visit(question);
  return [...paths];
}

async function readBoundedAsset(
  response: Response,
  remainingBytes: number,
): Promise<Blob> {
  if (!response.ok) {
    throw new ContentIntegrityError(`Eine Aufgabengrafik konnte nicht geladen werden (${response.status}).`);
  }
  const allowed = Math.min(MAX_SINGLE_ASSET_BYTES, remainingBytes);
  const declaredHeader = response.headers.get('content-length');
  if (!declaredHeader || !/^(?:0|[1-9][0-9]*)$/u.test(declaredHeader)) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat keine gültige Längenangabe geliefert.');
  }
  const declared = Number(declaredHeader);
  if (!Number.isSafeInteger(declared) || declared <= 0) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat keine gültige Längenangabe geliefert.');
  }
  if (declared > allowed) {
    throw new ContentIntegrityError('Eine Aufgabengrafik überschreitet das sichere Größenlimit.');
  }
  const contentType = response.headers.get('content-type');
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'image/png') {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat einen unerwarteten Dateityp geliefert.');
  }
  const etag = response.headers.get('etag');
  const etagMatch = /^"([0-9a-f]{64})"$/u.exec(etag ?? '');
  if (!etagMatch) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat keine starke Prüfsumme geliefert.');
  }

  let bytes: Uint8Array;
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > allowed) {
      throw new ContentIntegrityError('Eine Aufgabengrafik überschreitet das sichere Größenlimit.');
    }
    if (blob.size !== declared) {
      throw new ContentIntegrityError('Eine Aufgabengrafik wurde unvollständig übertragen.');
    }
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else {
    const reader = response.body.getReader();
    bytes = new Uint8Array(declared);
    let received = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const nextReceived = received + next.value.byteLength;
        if (nextReceived > allowed) {
          await reader.cancel();
          throw new ContentIntegrityError('Eine Aufgabengrafik überschreitet das sichere Größenlimit.');
        }
        if (nextReceived > declared) {
          await reader.cancel();
          throw new ContentIntegrityError('Eine Aufgabengrafik hat eine falsche Längenangabe geliefert.');
        }
        bytes.set(next.value, received);
        received = nextReceived;
      }
    } finally {
      reader.releaseLock();
    }
    if (received !== declared) {
      throw new ContentIntegrityError('Eine Aufgabengrafik wurde unvollständig übertragen.');
    }
  }

  const verifiedBytes = new Uint8Array(bytes.byteLength);
  verifiedBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', verifiedBytes.buffer);
  const actualHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (actualHash !== etagMatch[1]) {
    throw new ContentIntegrityError('Die Prüfsumme einer Aufgabengrafik ist ungültig.');
  }
  return new Blob([verifiedBytes.buffer], { type: 'image/png' });
}

export const usePracticeStore = defineStore('practice', () => {
  const items = ref<SessionItem[]>([]);
  const questions = shallowRef<Map<string, Question>>(new Map());
  const index = ref(0);
  const origin = ref<SessionOrigin>('smart');
  const graded = ref<GradedRecord[]>([]);
  const phase = ref<
    'idle' | 'loading' | 'provenance-choice' | 'running' | 'summary' | 'error'
  >('idle');
  const error = ref<string | undefined>();
  /** Non-fatal notice (e.g. some questions failed to load, session continues). */
  const warning = ref<string | undefined>();
  /** Content provenance is fixed for the lifetime of this renderer's session. */
  const contentSource = ref<CoreSourcePreference>('remote');
  const contentId = ref<string | undefined>();
  const contentMode = ref<'current' | 'revision'>('current');
  const partShownAt = ref(0);
  /**
   * Last time the live session was written — the in-memory counterpart of the
   * snapshot's `savedAt`. Judging a running session by its START time instead
   * declared an actively used session stale and deleted a still-fresh
   * snapshot underneath it.
   */
  const lastActivityAt = ref(new Date().toISOString());
  /** Last thing the user asked for, so the error screen can retry THAT. */
  const lastRequest = ref<
    {
      kind: 'smart';
      source: CoreSourcePreference;
      opts?: { count?: number; filters?: QuestionsFilter };
      contentId?: string;
    }
    | { kind: 'questions'; source: CoreSourcePreference; ids: string[]; contentId?: string }
    | undefined
  >();
  /** Pre-answer FSRS snapshots for same-event manual override (per partId). */
  const preAnswerFsrs = new Map<string, FsrsState | undefined>();
  /** Serialize session writes so a slower, older snapshot cannot win. */
  let sessionPersistenceTail: Promise<void> = Promise.resolve();
  /** Fixed for the whole live session; auth changes cannot retarget it. */
  let sessionOwner: AttemptOwnerSnapshot | undefined;
  let sessionStorageKey: string | undefined;
  let sessionResolvedOwnerId: string | undefined;
  let sessionCoreClient: CoreClient | undefined;
  let sessionManifest: ManifestResponse | undefined;
  let sessionManifestUnavailable = false;
  let pinnedAssetUrls = new Map<string, string>();
  /**
   * Kept verbatim while an old snapshot waits for explicit consent. A failed
   * current-bank load keeps it too, so retry never turns into a fresh session.
   */
  let pendingUnprovenancedSession:
    | { snapshot: PersistedPracticeSession; selectedSource?: CoreSourcePreference }
    | undefined;

  function revokePinnedAssets(): void {
    for (const url of pinnedAssetUrls.values()) URL.revokeObjectURL(url);
    pinnedAssetUrls = new Map();
  }

  function enterFailClosedError(cause: unknown): void {
    questions.value = new Map();
    revokePinnedAssets();
    phase.value = 'error';
    error.value = cause instanceof Error ? cause.message : String(cause);
  }

  function commitPinnedAssets(blobs: Map<string, Blob>): void {
    const next = new Map<string, string>();
    try {
      for (const [path, blob] of blobs) next.set(path, URL.createObjectURL(blob));
    } catch (cause) {
      for (const url of next.values()) URL.revokeObjectURL(url);
      throw new ContentIntegrityError('Die lokalen Aufgabengrafiken konnten nicht vorbereitet werden.', { cause });
    }
    revokePinnedAssets();
    pinnedAssetUrls = next;
  }

  async function prepareAssetSnapshot(
    client: CoreClient,
    questionMap: Map<string, Question>,
    revision: string,
  ): Promise<Map<string, Blob>> {
    const paths = new Set<string>();
    for (const question of questionMap.values()) {
      for (const path of questionAssetPaths(question)) paths.add(path);
    }
    const blobs = new Map<string, Blob>();
    let total = 0;
    for (const path of paths) {
      const response = await fetch(client.revisionAssetUrl(path, revision), {
        cache: 'no-store',
        credentials: 'omit',
      });
      const blob = await readBoundedAsset(response, MAX_PINNED_ASSET_BYTES - total);
      total += blob.size;
      blobs.set(path, blob);
    }
    return blobs;
  }

  function storageKeyForOwner(owner: AttemptOwnerSnapshot): string {
    const keyOwner = owner.userId === GUEST_ATTEMPT_OWNER ? 'guest' : owner.userId;
    const windowKind = ports.shell.capabilities.desktop ? ports.shell.windowKind : undefined;
    return `${SESSION_STORAGE_KEY}:${keyOwner}${windowKind ? `:${windowKind}` : ''}`;
  }

  function legacyStorageKeyForOwner(owner: AttemptOwnerSnapshot): string {
    const keyOwner = owner.userId === GUEST_ATTEMPT_OWNER ? 'guest' : owner.userId;
    return `${SESSION_STORAGE_KEY}:${keyOwner}`;
  }

  /**
   * First Desktop launch after the scoped-key upgrade claims the legacy
   * snapshot atomically. Only one native window may win; all later writes are
   * isolated by its stable main/practice key.
   */
  async function readPersistedSession(owner: AttemptOwnerSnapshot): Promise<unknown> {
    const key = storageKeyForOwner(owner);
    const current = await storage.get<unknown>(STORAGE.app, key);
    const legacyKey = legacyStorageKeyForOwner(owner);
    if (current !== undefined || key === legacyKey) return current;
    const migrate = async (): Promise<unknown> => {
      const alreadyMigrated = await storage.get<unknown>(STORAGE.app, key);
      if (alreadyMigrated !== undefined) return alreadyMigrated;
      const legacy = await storage.get<unknown>(STORAGE.app, legacyKey);
      if (legacy === undefined) return undefined;
      await storage.set(STORAGE.app, key, legacy);
      await storage.delete(STORAGE.app, legacyKey);
      return legacy;
    };
    return storage.runExclusiveMutation ? storage.runExclusiveMutation(migrate) : migrate();
  }

  function setSessionIdentity(owner: AttemptOwnerSnapshot): AttemptOwnerSnapshot {
    sessionOwner = { ...owner };
    sessionStorageKey = storageKeyForOwner(owner);
    sessionResolvedOwnerId = owner.userId;
    return sessionOwner;
  }

  async function ensureSessionIdentity(): Promise<AttemptOwnerSnapshot> {
    if (sessionOwner) return sessionOwner;
    return setSessionIdentity(await useProgressStore().captureAttemptOwner());
  }

  async function bindSessionContent(
    requestedSource?: CoreSourcePreference,
    expectedContentId?: string,
  ): Promise<CoreClient> {
    const app = useAppStore();
    const pin = await app.pinCoreContent(
      requestedSource ?? app.coreEndpointSource,
      expectedContentId,
    );
    if (expectedContentId && pin.contentId && pin.contentId !== expectedContentId) {
      throw new Error(
        'Die Aufgabenbank dieses Programms wurde geändert. Der lokale Stand bleibt erhalten; bitte starte das Programm mit der passenden Quelle neu.',
      );
    }
    contentSource.value = pin.source;
    contentId.value = pin.contentId ?? expectedContentId;
    sessionCoreClient = pin.client;
    contentMode.value = pin.mode;
    sessionManifest = pin.manifest;
    sessionManifestUnavailable = pin.manifestUnavailable === true;
    revokePinnedAssets();
    const request = lastRequest.value;
    if (contentId.value && request) {
      lastRequest.value = { ...request, contentId: contentId.value };
    }
    return pin.client;
  }

  function enqueueSessionPersistence<Result>(task: () => Promise<Result>): Promise<Result> {
    const run = sessionPersistenceTail.then(task, task);
    sessionPersistenceTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function cloneGradedRecord(record: GradedRecord): GradedRecord {
    const breakdown = record.result.breakdown?.map((item) => ({ ...item }));
    return {
      ...record,
      result: {
        ...record.result,
        ...(breakdown ? { breakdown } : {}),
      },
    };
  }

  function buildPersistedSession(
    owner: AttemptOwnerSnapshot,
    records: readonly GradedRecord[],
    savedAt: string,
  ): PersistedPracticeSession {
    return {
      version: SESSION_STORAGE_VERSION,
      owner: { ...owner },
      contentSource: contentSource.value,
      ...(contentId.value ? { contentId: contentId.value } : {}),
      origin: origin.value,
      items: items.value.map((item) => ({ ...item })),
      index: index.value,
      graded: records.map(cloneGradedRecord),
      savedAt,
    };
  }

  function sameSessionDefinition(
    current: PersistedPracticeSession,
    expected: PersistedPracticeSession,
  ): boolean {
    return current.version === SESSION_STORAGE_VERSION
      && current.origin === expected.origin
      && current.contentSource === expected.contentSource
      && current.contentId === expected.contentId
      && current.items.length === expected.items.length
      && current.items.every((item, itemIndex) => {
        const other = expected.items[itemIndex];
        return other !== undefined
          && item.questionId === other.questionId
          && item.partId === other.partId
          && item.reason === other.reason;
      });
  }

  function mergeSessionGradeRecords(
    current: readonly GradedRecord[],
    pending: readonly GradedRecord[],
  ): GradedRecord[] {
    const merged = current.map(cloneGradedRecord);
    const ids = new Set(merged.map((record) => record.clientAttemptId));
    for (const record of pending) {
      if (ids.has(record.clientAttemptId)) continue;
      ids.add(record.clientAttemptId);
      merged.push(cloneGradedRecord(record));
    }
    return merged;
  }

  async function commitSessionSnapshot(
    key: string,
    snapshot: PersistedPracticeSession,
    replaceExisting: boolean,
  ): Promise<PersistedPracticeSession> {
    if (!hasAtomicStorage(storage)) {
      await storage.set(STORAGE.app, key, snapshot);
      return snapshot;
    }
    const address = { collection: STORAGE.app, key } as const;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [entry] = await storage.readBatch([address]);
      if (!entry) throw new Error('Practice session revision read returned no entry');
      let next = snapshot;
      if (entry.value !== undefined) {
        if (!isPersistedPracticeSession(entry.value)) {
          throw new Error('Stored practice session is malformed');
        }
        const current = entry.value;
        if (sameSessionDefinition(current, snapshot) && !replaceExisting) {
          next = {
            ...snapshot,
            graded: mergeSessionGradeRecords(current.graded, snapshot.graded),
            savedAt: current.savedAt > snapshot.savedAt ? current.savedAt : snapshot.savedAt,
          };
        } else if (!replaceExisting) {
          throw new Error('Stored practice session was replaced by another programme');
        }
      }
      try {
        const committed = await storage.commitBatch({
          ifRevisions: [{ ...address, revision: entry.revision }],
          mutations: [{ ...address, operation: 'set', value: next }],
        });
        if (committed.committed) return next;
      } catch (cause) {
        // The browser/IPC may lose the response after COMMIT. A matching
        // session containing every grade from this snapshot is already a
        // safe outcome; otherwise the caller must surface the storage error.
        const [durable] = await storage.readBatch([address]).catch(() => []);
        const durableSession = durable?.value;
        if (
          durable
          && isPersistedPracticeSession(durableSession)
          && sameSessionDefinition(durableSession, snapshot)
          && snapshot.graded.every((record) =>
            durableSession.graded.some((saved) =>
              saved.clientAttemptId === record.clientAttemptId))
        ) {
          return durableSession;
        }
        throw cause;
      }
    }
    throw new Error('Practice session changed too often to save safely');
  }

  async function persistSession(options: { replaceExisting?: boolean } = {}): Promise<void> {
    if (phase.value !== 'running' || items.value.length === 0) return;
    const owner = await ensureSessionIdentity();
    const key = sessionStorageKey!;
    const snapshot = buildPersistedSession(owner, graded.value, new Date().toISOString());
    try {
      const committed = await enqueueSessionPersistence(() =>
        commitSessionSnapshot(key, snapshot, options.replaceExisting === true),
      );
      graded.value = committed.graded.map(cloneGradedRecord);
      lastActivityAt.value = committed.savedAt;
    } catch {
      warning.value = 'Das laufende Programm konnte lokal nicht gespeichert werden.';
    }
  }

  async function clearPersistedSession(): Promise<void> {
    const key = sessionStorageKey;
    if (!key) return;
    try {
      await enqueueSessionPersistence(() => storage.delete(STORAGE.app, key));
    } catch {
      warning.value = 'Der lokal gespeicherte Programmstand konnte nicht entfernt werden.';
    }
  }

  const total = computed(() => items.value.length);
  const current = computed(() => {
    const item = items.value[index.value];
    if (!item) return undefined;
    const question = questions.value.get(item.questionId);
    const part = question?.parts.find((p) => p.id === item.partId);
    if (!question || !part) return undefined;
    return { item, question, part };
  });

  const summary = computed(() => {
    const list = graded.value;
    const points = list.reduce((s, g) => s + g.result.awardedPoints, 0);
    const maxPoints = list.reduce((s, g) => s + g.result.maxPoints, 0);
    const byVerdict = { correct: 0, partial: 0, incorrect: 0 };
    for (const g of list) byVerdict[g.result.verdict]++;
    const codes = new Set<string>();
    for (const g of list) {
      const q = questions.value.get(g.questionId);
      const part = q?.parts.find((p) => p.id === g.partId);
      for (const c of part?.competencies ?? []) codes.add(c.code);
    }
    return { count: list.length, points, maxPoints, byVerdict, competencies: [...codes] };
  });

  /**
   * Load full questions, cache-first. When the network fetch fails but SOME
   * questions are already cached (e.g. core briefly unreachable), the session
   * proceeds with the cached subset and a warning instead of hard-failing;
   * with nothing usable the error propagates.
   */
  async function fetchQuestions(ids: string[]): Promise<void> {
    const client = sessionCoreClient ?? await bindSessionContent();
    const unique = [...new Set(ids)];
    const missing: string[] = [];
    const map = new Map<string, Question>();
    const manifest = sessionManifestUnavailable ? undefined : sessionManifest;
    if (manifest) {
      if (!manifest.commit || typeof manifest.commit !== 'string') {
        throw new ContentIntegrityError('Die Aufgabenbank hat keine überprüfbare Versionskennung geliefert.');
      }
      if (contentId.value && manifest.commit !== contentId.value) {
        throw new ContentIntegrityError('Die Aufgabenbank wurde während des Ladens gewechselt.');
      }
      contentId.value = manifest.commit;
    }
    const cacheScope = manifest?.commit ?? contentId.value;
    for (const id of unique) {
      const expectedHash = manifest?.items[id];
      // Strict sessions never reuse a legacy plain Question. getVerified
      // requires one atomic revision/raw-hash/wire-hash envelope and checks
      // the wire payload again on every read.
      const cached = cacheScope && (!manifest || isSha256(expectedHash))
        ? await questionCache.getVerified(id, cacheScope, expectedHash)
        : undefined;
      if (!cached) {
        missing.push(id);
        continue;
      }
      map.set(id, cached);
    }
    const fetched: ContentQuestion[] = [];
    if (missing.length > 0) {
      // No manifest means there is no authority against which a new payload
      // can be admitted. Only already-proven scoped envelopes above survive.
      if (!manifest) {
        throw new ContentIntegrityError(
          'Die Aufgabenbank konnte nicht überprüft werden. Neue Aufgaben werden aus Sicherheitsgründen nicht geladen.',
        );
      }
      let batchPayloadReceived = false;
      try {
        const res = contentMode.value === 'revision'
          ? await client.getRevisionQuestionsBatch(manifest.commit, missing)
          : await client.getQuestionsBatch(missing);
        batchPayloadReceived = true;
        const requested = new Set(missing);
        const returned = new Set<string>();
        for (const entry of res.questions) {
          const q = entry?.question;
          if (!q || typeof q.id !== 'string') {
            throw new ContentIntegrityError('Der Core hat eine ungültige Batch-Antwort geliefert.');
          }
          if (!requested.has(q.id)) {
            throw new ContentIntegrityError(
              `Der Core hat eine nicht angeforderte Aufgabe geliefert (${q.id}).`,
            );
          }
          if (returned.has(q.id)) {
            throw new ContentIntegrityError(`Der Core hat Aufgabe ${q.id} doppelt geliefert.`);
          }
          returned.add(q.id);
          const expectedHash = manifest.items[q.id];
          if (!isSha256(entry.contentHash) || !isSha256(entry.wireHash)) {
            throw new ContentIntegrityError(
              `Der Core hat für Aufgabe ${q.id} keine überprüfbaren Prüfsummen geliefert.`,
            );
          }
          if (!isSha256(expectedHash) || entry.contentHash !== expectedHash) {
            throw new ContentIntegrityError(
              `Die Inhalts-Prüfsumme von Aufgabe ${q.id} stimmt nicht mit der Aufgabenbank überein.`,
            );
          }
          if (questionContentHash(q) !== entry.wireHash) {
            throw new ContentIntegrityError(
              `Die Übertragungs-Prüfsumme von Aufgabe ${q.id} ist ungültig.`,
            );
          }
          fetched.push(entry);
        }
        const reportedMissing = new Set(res.missing);
        if (
          reportedMissing.size !== res.missing.length
          ||
          res.missing.some((id) => !requested.has(id) || returned.has(id))
          || missing.some((id) => !returned.has(id) && !reportedMissing.has(id))
        ) {
          throw new ContentIntegrityError('Die Batch-Antwort des Core ist unvollständig oder widersprüchlich.');
        }
        if (reportedMissing.size > 0) {
          warning.value = `${reportedMissing.size} Aufgaben sind in dieser Bank nicht verfügbar.`;
        }
      } catch (e) {
        // Hash/revision failures are evidence of mixed content, not an
        // ordinary outage. Invalid stale entries must never be resurrected.
        if (e instanceof ContentIntegrityError) throw e;
        if (e instanceof CoreProtocolError) {
          throw new ContentIntegrityError(
            'Der Core unterstützt die erforderliche sichere Aufgabenübertragung nicht.',
            { cause: e },
          );
        }
        // Once a manifest-backed batch arrived, admitting any of it requires
        // the post-download revision confirmation. A failed confirmation is
        // intentionally fail-closed; otherwise figures could come from a
        // newer deployment than the cached question text.
        if (batchPayloadReceived) throw e;
        if (map.size === 0) throw e;
        const unavailable = unique.length - map.size;
        warning.value = `${unavailable} Aufgaben konnten nicht geladen werden — Programm läuft mit ${map.size} geprüften gespeicherten weiter.`;
      }
    }

    for (const entry of fetched) map.set(entry.question.id, entry.question);

    // Every manifest-backed session uses Core's immutable revision asset
    // route, including a session that otherwise reads the current question
    // endpoint. Afterwards these sessions expose only blob: URLs, so text and
    // figures cannot cross revisions.
    let pendingAssets = new Map<string, Blob>();
    if (contentSource.value === 'remote' || contentMode.value === 'revision') {
      const hasAssets = [...map.values()].some((question) => questionAssetPaths(question).length > 0);
      if (hasAssets && !manifest) {
        throw new ContentIntegrityError(
          'Die Version der Remote-Aufgabengrafiken konnte nicht bestätigt werden.',
        );
      }
      if (hasAssets) {
        pendingAssets = await prepareAssetSnapshot(
          client,
          map,
          manifest!.commit,
        );
      }
    }
    if (fetched.length > 0 || pendingAssets.size > 0) {
      let confirmed: ManifestResponse;
      try {
        confirmed = contentMode.value === 'revision'
          ? await client.revisionManifest(manifest!.commit)
          : await client.manifest();
      } catch (cause) {
        throw new ContentIntegrityError(
          'Die Aufgabenbank konnte nach dem Laden nicht erneut bestätigt werden.',
          { cause },
        );
      }
      const changed = confirmed.commit !== manifest?.commit
        || unique.some((id) => confirmed.items[id] !== manifest?.items[id]);
      if (changed) {
        throw new ContentIntegrityError(
          'Die Aufgabenbank wurde während des Ladens aktualisiert. Bitte lade das Programm erneut.',
        );
      }
      sessionManifest = confirmed;
    }

    if (contentSource.value === 'remote' || contentMode.value === 'revision') {
      commitPinnedAssets(pendingAssets);
    }
    if (fetched.length > 0 && cacheScope) {
      await questionCache.putManyVerified(fetched, cacheScope);
      // The unscoped cache is a current-bank title compatibility index. A
      // historical replay must never overwrite it with an old title.
      if (contentMode.value === 'current') {
        await questionCache.putMany(fetched.map((entry) => entry.question));
      }
    }
    questions.value = map;
  }

  async function beginSession(list: SessionItem[], from: SessionOrigin): Promise<void> {
    await ensureSessionIdentity();
    items.value = list;
    origin.value = from;
    lastActivityAt.value = new Date().toISOString();
    index.value = 0;
    graded.value = [];
    preAnswerFsrs.clear();
    phase.value = list.length > 0 ? 'running' : 'summary';
    partShownAt.value = Date.now();
    if (list.length > 0) await persistSession({ replaceExisting: true });
    else await clearPersistedSession();
  }

  /**
   * Bulk practice handoff (URL-bloat fix): the browse page seeds the session
   * IN THE STORE and navigates to a bare /practice — hundreds of question ids
   * never enter the URL. Single questions keep the shareable ?questions= link.
   */
  async function startPrepared(
    questionIds: string[],
    fixedSource = useAppStore().coreEndpointSource,
    expectedContentId?: string,
  ): Promise<void> {
    await startQuestions(questionIds, fixedSource, expectedContentId);
  }

  /** Smart session: FSRS-due reviews + weak-competency new parts (core decides). */
  async function startSmart(
    opts?: { count?: number; filters?: QuestionsFilter },
    fixedSource = useAppStore().coreEndpointSource,
    expectedContentId?: string,
  ): Promise<void> {
    // Capture the source synchronously with the click. Another Desktop window
    // may change the device preference while owner reconciliation is awaiting
    // storage, but this programme must still start from the source the user saw.
    const requestedSource = fixedSource;
    // Session ownership begins with the user's start action, before any fetch
    // or reconciliation await can let a different window change auth.
    setSessionIdentity(await useProgressStore().captureAttemptOwner());
    lastRequest.value = opts
      ? { kind: 'smart', source: requestedSource, opts, ...(expectedContentId ? { contentId: expectedContentId } : {}) }
      : { kind: 'smart', source: requestedSource, ...(expectedContentId ? { contentId: expectedContentId } : {}) };
    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    try {
      const app = useAppStore();
      const client = await bindSessionContent(requestedSource, expectedContentId);
      const auth = useAuthStore();
      const progress = useProgressStore();
      // Logged in: reconcile with the cloud archive before asking for
      // recommendations (contract §8.2 step 2 — checksum compare inside).
      if (auth.session?.user.id === sessionResolvedOwnerId) {
        const syncResult = await progress.syncBeforeRecommendation();
        if (syncResult === 'conflict' || syncResult === 'blocked') {
          throw new Error('Bitte löse zuerst den offenen Speicherkonflikt. Danach kann das Programm starten.');
        }
        if (syncResult === 'offline') {
          warning.value = 'Cloud-Speicher nicht erreichbar — Empfehlungen basieren auf dem lokalen Fortschritt.';
        } else if (syncResult === 'error') {
          warning.value = 'Cloud-Abgleich fehlgeschlagen — Empfehlungen basieren auf dem lokalen Fortschritt.';
        }
      }
      const userState = await progress.toUserState();
      const req: Parameters<CoreClient['recommend']>[0] = {
        userState,
        count: opts?.count ?? 20,
      };
      if (opts?.filters) req.filters = opts.filters;
      const rec = await client.recommend(req);
      await fetchQuestions(rec.items.map((i) => i.questionId));
      // Guards: playable parts only, and NEVER an excluded part (supplement
      // §1.4 — belt to the userState projection's braces).
      const excluded = progress.excludedPartIds;
      const list: SessionItem[] = rec.items.filter((i) => {
        if (excluded.has(i.partId)) return false;
        const q = questions.value.get(i.questionId);
        return q?.parts.some((p) => p.id === i.partId && p.answer);
      });
      await beginSession(list, 'smart');
    } catch (e) {
      enterFailClosedError(e);
    }
  }

  /**
   * Practice explicit questions (whole exam or a hand-picked set) —
   * user-driven, so excluded parts stay OPENABLE here when a single question
   * is chosen deliberately (supplement §1.4: exclusion is not deletion).
   * For bulk selections (more than one question) excluded parts are skipped.
   */
  async function startQuestions(
    questionIds: string[],
    fixedSource = useAppStore().coreEndpointSource,
    expectedContentId?: string,
  ): Promise<void> {
    const requestedSource = fixedSource;
    // Fix the same identity for question loading, answer commits and every
    // later snapshot; beginSession must not re-read live auth.
    setSessionIdentity(await useProgressStore().captureAttemptOwner());
    lastRequest.value = {
      kind: 'questions',
      source: requestedSource,
      ids: [...questionIds],
      ...(expectedContentId ? { contentId: expectedContentId } : {}),
    };
    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    try {
      await bindSessionContent(requestedSource, expectedContentId);
      const progress = useProgressStore();
      await fetchQuestions(questionIds);
      const excluded = progress.excludedPartIds;
      const deliberateSingle = questionIds.length === 1;
      const list: SessionItem[] = [];
      for (const id of questionIds) {
        const q = questions.value.get(id);
        for (const p of q?.parts ?? []) {
          if (!p.answer) continue;
          if (!deliberateSingle && excluded.has(p.id)) continue;
          list.push({ questionId: id, partId: p.id, reason: 'manual' });
        }
      }
      await beginSession(list, 'manual');
    } catch (e) {
      enterFailClosedError(e);
    }
  }

  async function recordGraded(payload: {
    part: QuestionPart;
    result: GradeResult;
    submission: Submission;
  }): Promise<void> {
    const cur = current.value;
    if (!cur || cur.part.id !== payload.part.id) return;
    const progress = useProgressStore();
    const auth = useAuthStore();
    // The whole programme owns the event. Capturing from live auth here would
    // let a cross-window account switch put an old guest snapshot into a new
    // user's key even if the audit outbox itself retained the old owner.
    const attemptOwner = await ensureSessionIdentity();
    const gradedAt = new Date().toISOString();
    const elapsedMs = Math.max(0, Date.now() - partShownAt.value);
    const record: GradedRecord = {
      clientAttemptId: createClientAttemptId(),
      partId: payload.part.id,
      questionId: cur.question.id,
      result: payload.result,
      reason: cur.item.reason,
      gradedAt,
      elapsedMs,
    };
    const nextGraded = [...graded.value, record];
    const key = sessionStorageKey;
    if (!key) throw new Error('Practice session has no durable storage identity');
    // Drain earlier position-only snapshots before taking the revisioned batch
    // snapshot. They may fail, but they can never race and overwrite the grade
    // after its transaction commits.
    await sessionPersistenceTail;
    const savedAt = new Date().toISOString();
    const nextSession = buildPersistedSession(attemptOwner, nextGraded, savedAt);
    const committed = await progress.commitGradeEvent({
      owner: attemptOwner,
      attempt: toAttemptRecord(record),
      grade: {
        partId: payload.part.id,
        competencyCodes: payload.part.competencies.map((competency) => competency.code),
        verdict: payload.result.verdict,
        awardedPoints: payload.result.awardedPoints,
        maxPoints: payload.result.maxPoints,
        now: new Date(gradedAt),
      },
      session: {
        address: { collection: STORAGE.app, key },
        prepare(current) {
          if (current !== undefined) {
            if (!isPersistedPracticeSession(current)) {
              throw new Error('Stored practice session is malformed');
            }
            const owner = current.version >= 3 ? current.owner : undefined;
            if (
              owner
              && (owner.userId !== attemptOwner.userId
                || owner.guestGeneration !== attemptOwner.guestGeneration)
            ) {
              throw new Error('Stored practice session belongs to a different account');
            }
            if (!sameSessionDefinition(current, nextSession)) {
              throw new Error('Stored practice session was replaced by another programme');
            }
            return {
              ...nextSession,
              graded: mergeSessionGradeRecords(current.graded, nextSession.graded),
              savedAt: current.savedAt > nextSession.savedAt ? current.savedAt : nextSession.savedAt,
            };
          }
          return nextSession;
        },
        containsAttempt(current, clientAttemptId) {
          return isPersistedPracticeSession(current)
            && current.graded.some((candidate) => candidate.clientAttemptId === clientAttemptId);
        },
      },
    });
    // Nothing reactive changes before all four durable records are committed.
    if (!isPersistedPracticeSession(committed.session)) {
      throw new Error('Committed practice session is malformed');
    }
    sessionResolvedOwnerId = committed.ownerId;
    graded.value = committed.session.graded.map(cloneGradedRecord);
    lastActivityAt.value = committed.session.savedAt;
    preAnswerFsrs.set(payload.part.id, committed.previousFsrs);
    // Guests retain the staged event under their local-only owner. Authenticated
    // attempts flush only if the same captured account is still active.
    void progress.flushStagedAttempt(committed.ownerId).catch(() => {
      progress.scheduleCloudRecovery();
    });
    if (auth.session?.user.id === committed.ownerId && graded.value.length % SYNC_EVERY_N_GRADES === 0) {
      void progress.syncNow({ quiet: true });
    }
  }

  /**
   * Manual grading from the ever-present menu (supplement §1.2 — manual
   * always wins). If the part was answered THIS session, the override
   * replaces the auto advance (rebased on the pre-answer snapshot);
   * otherwise it acts as a standalone review event.
   */
  async function overrideGrading(partId: string, grading: Grading): Promise<void> {
    const progress = useProgressStore();
    const input: Parameters<typeof progress.setGrading>[0] = { partId, grading };
    if (preAnswerFsrs.has(partId)) input.baseFsrs = preAnswerFsrs.get(partId);
    await progress.setGrading(input);
  }

  /** Set of partIds already graded this session (drives the session rail). */
  const gradedPartIds = computed(() => new Set(graded.value.map((g) => g.partId)));

  /**
   * Jump to a not-yet-graded session item (session rail). Graded parts are
   * not revisitable — re-answering would advance FSRS twice for one attempt.
   */
  function jumpTo(i: number): void {
    if (phase.value !== 'running') return;
    const item = items.value[i];
    if (!item || i === index.value) return;
    if (gradedPartIds.value.has(item.partId)) return;
    index.value = i;
    partShownAt.value = Date.now();
    void persistSession();
  }

  /** Advance to the next UNGRADED item (cyclic — jumping may leave gaps);
   *  the session completes only when every item has been graded. */
  function next(): void {
    const n = items.value.length;
    if (graded.value.length >= n) {
      phase.value = 'summary';
      void endOfSession();
      return;
    }
    for (let step = 1; step <= n; step++) {
      const i = (index.value + step) % n;
      if (!gradedPartIds.value.has(items.value[i]!.partId)) {
        index.value = i;
        partShownAt.value = Date.now();
        void persistSession();
        return;
      }
    }
    phase.value = 'summary';
    void endOfSession();
  }

  async function syncSessionProgress(): Promise<void> {
    const auth = useAuthStore();
    const progress = useProgressStore();
    if (!sessionResolvedOwnerId || auth.session?.user.id !== sessionResolvedOwnerId) return;
    await progress.syncNow({ quiet: true });
    await progress.flushAttemptOutbox();
  }

  async function endOfSession(): Promise<void> {
    await clearPersistedSession();
    await syncSessionProgress();
  }

  function toAttemptRecord(g: GradedRecord): QueuedAttempt {
    return {
      clientAttemptId: g.clientAttemptId,
      contentSource: contentSource.value,
      ...(contentId.value ? { contentId: contentId.value } : {}),
      questionId: g.questionId,
      partId: g.partId,
      correct: g.result.correct,
      awardedPoints: g.result.awardedPoints,
      elapsedMs: g.elapsedMs,
      gradedAt: g.gradedAt,
    };
  }

  async function finishSession(): Promise<void> {
    await persistSession();
    await syncSessionProgress();
  }

  async function hydratePersistedSession(
    snapshot: PersistedPracticeSession,
    source: CoreSourcePreference,
    expectedContentId?: string,
  ): Promise<boolean> {
    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    // If the restore fails the user lands on the error screen, whose retry
    // must keep the exact question ids. Recommending a new smart programme
    // here would silently replace the interrupted one.
    lastRequest.value = {
      kind: 'questions',
      source,
      ids: [...new Set(snapshot.items.map((item) => item.questionId))],
      ...(expectedContentId ? { contentId: expectedContentId } : {}),
    };
    try {
      await bindSessionContent(source, expectedContentId);
      await fetchQuestions(snapshot.items.map((item) => item.questionId));
      const validItems = snapshot.items.filter((item) => {
        const question = questions.value.get(item.questionId);
        return question?.parts.some((part) => part.id === item.partId && part.answer);
      });
      if (validItems.length === 0) {
        if (pendingUnprovenancedSession?.snapshot === snapshot) {
          enterFailClosedError(
            new Error('Keine der gespeicherten Aufgaben ist in der aktuell gewählten Bank verfügbar.'),
          );
          return true;
        }
        phase.value = 'idle';
        await clearPersistedSession();
        return false;
      }

      const validPartIds = new Set(validItems.map((item) => item.partId));
      const seenGraded = new Set<string>();
      const restoredGraded = snapshot.graded.filter((record) => {
        if (!validPartIds.has(record.partId) || seenGraded.has(record.partId)) return false;
        seenGraded.add(record.partId);
        return true;
      });
      const savedItem = snapshot.items[snapshot.index];
      let restoredIndex = savedItem
        ? validItems.findIndex((item) =>
            item.questionId === savedItem.questionId && item.partId === savedItem.partId)
        : 0;
      if (restoredIndex < 0) restoredIndex = 0;

      items.value = validItems;
      origin.value = snapshot.origin;
      lastActivityAt.value = snapshot.savedAt;
      graded.value = restoredGraded;
      preAnswerFsrs.clear();
      if (restoredGraded.length >= validItems.length) {
        index.value = restoredIndex;
        phase.value = 'summary';
        pendingUnprovenancedSession = undefined;
        await clearPersistedSession();
        return true;
      }

      if (seenGraded.has(validItems[restoredIndex]!.partId)) {
        for (let step = 1; step <= validItems.length; step++) {
          const candidate = (restoredIndex + step) % validItems.length;
          if (!seenGraded.has(validItems[candidate]!.partId)) {
            restoredIndex = candidate;
            break;
          }
        }
      }
      index.value = restoredIndex;
      phase.value = 'running';
      partShownAt.value = Date.now();
      await persistSession({
        replaceExisting: pendingUnprovenancedSession?.snapshot === snapshot,
      });
      pendingUnprovenancedSession = undefined;
      return true;
    } catch (e) {
      enterFailClosedError(e);
      return true;
    }
  }

  /**
   * Rehydrate an interrupted program from IndexedDB. Questions themselves are
   * restored through the existing cache-first loader, keeping the snapshot
   * small and usable offline.
   *
   * `want` restricts what may be resumed. „Programm üben" passes 'smart', so
   * a half-finished hand-picked set from the Aufgaben list is NOT what the
   * user gets handed back — they asked for today's programme. Nothing is lost
   * by declining: every grade is written to the archive as it happens, only
   * the position inside that ad-hoc set goes away.
   */
  async function restoreSession(want?: SessionOrigin): Promise<boolean> {
    if (phase.value === 'loading' || phase.value === 'provenance-choice') return true;
    if (phase.value === 'error' && pendingUnprovenancedSession) return true;
    if (phase.value === 'running') {
      if (want && origin.value !== want) return false;
      try {
        await bindSessionContent(contentSource.value, contentId.value);
      } catch (e) {
        enterFailClosedError(e);
        return true;
      }
      // A PWA can stay open for days; the live session ages the same way a
      // persisted one does.
      if (!isResumable(origin.value, lastActivityAt.value, new Date())) {
        await clearPersistedSession();
        return false;
      }
      if (current.value && gradedPartIds.value.has(current.value.item.partId)) {
        next();
        await sessionPersistenceTail;
      }
      return true;
    }
    const requestedOwner = await useProgressStore().captureAttemptOwner();
    // Fix the candidate key before any await below. Invalid/stale cleanup must
    // delete exactly what was read, even if auth changes in another window.
    setSessionIdentity(requestedOwner);
    await sessionPersistenceTail;
    const snapshot = await readPersistedSession(requestedOwner);
    if (!isPersistedPracticeSession(snapshot) || snapshot.items.length === 0) {
      if (snapshot !== undefined) await clearPersistedSession();
      return false;
    }
    const persistedOwner = snapshot.version >= 3
      ? snapshot.owner!
      : requestedOwner;
    const ownerMatchesKey = persistedOwner.userId === requestedOwner.userId;
    const guestGenerationMatches = persistedOwner.userId !== GUEST_ATTEMPT_OWNER
      || persistedOwner.guestGeneration === requestedOwner.guestGeneration;
    if (!ownerMatchesKey || !guestGenerationMatches) {
      // A rotated guest generation belongs to the account that claimed it,
      // not to whoever later uses this device as a guest.
      await clearPersistedSession();
      return false;
    }
    setSessionIdentity(persistedOwner);
    if (want && snapshot.origin !== want) return false;
    if (!isResumable(snapshot.origin, snapshot.savedAt, new Date())) {
      await clearPersistedSession();
      return false;
    }
    if (!hasExactContentProvenance(snapshot)) {
      pendingUnprovenancedSession = { snapshot };
      lastRequest.value = undefined;
      phase.value = 'provenance-choice';
      error.value = undefined;
      warning.value = undefined;
      return true;
    }
    return hydratePersistedSession(snapshot, snapshot.contentSource, snapshot.contentId);
  }

  /** Explicit opt-in required for v2/v3 or incomplete-v4 snapshots. */
  async function resumeWithCurrentContent(): Promise<void> {
    const pending = pendingUnprovenancedSession;
    if (!pending) return;
    const source = pending.selectedSource ?? useAppStore().coreEndpointSource;
    pending.selectedSource = source;
    await hydratePersistedSession(pending.snapshot, source);
  }

  /**
   * Redo whatever the user last asked for. „Erneut versuchen" used to call the
   * view's `start()`, which re-reads the URL — and the Aufgaben bulk handoff
   * puts no ids in the URL, so a retry silently swapped the hand-picked set
   * for today's programme.
   */
  async function retry(): Promise<void> {
    if (pendingUnprovenancedSession?.selectedSource) {
      await hydratePersistedSession(
        pendingUnprovenancedSession.snapshot,
        pendingUnprovenancedSession.selectedSource,
      );
      return;
    }
    const request = lastRequest.value;
    if (!request) {
      await startSmart();
      return;
    }
    if (request.kind === 'questions') {
      await startQuestions(request.ids, request.source, request.contentId);
    }
    else await startSmart(request.opts, request.source, request.contentId);
  }

  function abort(): void {
    phase.value = 'idle';
    warning.value = undefined;
    items.value = [];
    questions.value = new Map();
    origin.value = 'smart';
    graded.value = [];
    preAnswerFsrs.clear();
    index.value = 0;
    void clearPersistedSession();
    sessionOwner = undefined;
    sessionStorageKey = undefined;
    sessionResolvedOwnerId = undefined;
    sessionCoreClient = undefined;
    contentMode.value = 'current';
    sessionManifest = undefined;
    sessionManifestUnavailable = false;
    pendingUnprovenancedSession = undefined;
    contentId.value = undefined;
    revokePinnedAssets();
    useAppStore().releaseCoreContentPin();
  }

  function suspendContentPin(): void {
    useAppStore().releaseCoreContentPin();
  }

  /**
   * Figures in a running programme resolve through the same source-pinned
   * client as its JSON. This deliberately does not depend on App's live Core
   * preference, which another Desktop window may change mid-session.
   */
  function assetUrl(src: string): string {
    if ((contentSource.value === 'remote' || contentMode.value === 'revision') && sessionCoreClient) {
      const pinned = pinnedAssetUrls.get(assetKey(src));
      if (pinned) return pinned;
      // Never fall through to a mutable Remote Core after the session has
      // been bound. Missing snapshot entries render broken-but-safe instead
      // of silently mixing revisions.
      warning.value = 'Eine Aufgabengrafik fehlt im überprüften lokalen Abbild.';
      return 'data:,';
    }
    return (sessionCoreClient ?? useAppStore().coreClient).assetUrl(src);
  }

  return {
    items,
    questions,
    index,
    origin,
    graded,
    retry,
    phase,
    error,
    warning,
    contentSource,
    contentId,
    contentMode,
    total,
    current,
    summary,
    gradedPartIds,
    jumpTo,
    startSmart,
    startQuestions,
    startPrepared,
    recordGraded,
    overrideGrading,
    next,
    finishSession,
    restoreSession,
    resumeWithCurrentContent,
    suspendContentPin,
    assetUrl,
    abort,
  };
});
