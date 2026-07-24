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
import { questionContentHash, STORAGE } from '@qed2/core-logic';
import type {
  FsrsState,
  GradeResult,
  Grading,
  Question,
  QuestionPart,
  QuestionsFilter,
  RecommendReason,
  Submission,
  QueuedAttempt,
} from '@qed2/core-logic';
import { questionCache, storage } from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';
import { useProgressStore } from './progress.js';

/** Sync after every N graded parts while logged in (brief §5: sync eagerly). */
const SYNC_EVERY_N_GRADES = 3;
const SESSION_STORAGE_KEY = 'practice-session';
const SESSION_STORAGE_VERSION = 1;

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
  version: typeof SESSION_STORAGE_VERSION;
  items: SessionItem[];
  index: number;
  graded: GradedRecord[];
  savedAt: string;
}

function isPersistedPracticeSession(value: unknown): value is PersistedPracticeSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedPracticeSession>;
  return candidate.version === SESSION_STORAGE_VERSION
    && Array.isArray(candidate.items)
    && candidate.items.every((item) =>
      item
      && typeof item === 'object'
      && typeof item.questionId === 'string'
      && typeof item.partId === 'string'
      && typeof item.reason === 'string')
    && typeof candidate.index === 'number'
    && Number.isInteger(candidate.index)
    && Array.isArray(candidate.graded)
    && candidate.graded.every((record) =>
      record
      && typeof record === 'object'
      && typeof record.clientAttemptId === 'string'
      && typeof record.partId === 'string'
      && typeof record.questionId === 'string'
      && typeof record.gradedAt === 'string'
      && typeof record.elapsedMs === 'number'
      && record.result
      && typeof record.result === 'object'
      && typeof record.result.verdict === 'string'
      && typeof record.result.correct === 'boolean'
      && typeof record.result.awardedPoints === 'number'
      && typeof record.result.maxPoints === 'number');
}

function createClientAttemptId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export const usePracticeStore = defineStore('practice', () => {
  const items = ref<SessionItem[]>([]);
  const questions = shallowRef<Map<string, Question>>(new Map());
  const index = ref(0);
  const graded = ref<GradedRecord[]>([]);
  const phase = ref<'idle' | 'loading' | 'running' | 'summary' | 'error'>('idle');
  const error = ref<string | undefined>();
  /** Non-fatal notice (e.g. some questions failed to load, session continues). */
  const warning = ref<string | undefined>();
  const partShownAt = ref(0);
  /** Pre-answer FSRS snapshots for same-event manual override (per partId). */
  const preAnswerFsrs = new Map<string, FsrsState | undefined>();
  /** Serialize session writes so a slower, older snapshot cannot win. */
  let sessionPersistenceTail: Promise<void> = Promise.resolve();

  function storageKey(): string {
    const owner = useAuthStore().session?.user.id ?? 'guest';
    return `${SESSION_STORAGE_KEY}:${owner}`;
  }

  function enqueueSessionPersistence(task: () => Promise<void>): Promise<void> {
    const run = sessionPersistenceTail.then(task, task);
    sessionPersistenceTail = run.catch(() => undefined);
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

  async function persistSession(): Promise<void> {
    if (phase.value !== 'running' || items.value.length === 0) return;
    const key = storageKey();
    const snapshot: PersistedPracticeSession = {
      version: SESSION_STORAGE_VERSION,
      items: items.value.map((item) => ({ ...item })),
      index: index.value,
      graded: graded.value.map(cloneGradedRecord),
      savedAt: new Date().toISOString(),
    };
    try {
      await enqueueSessionPersistence(() => storage.set(STORAGE.app, key, snapshot));
    } catch {
      warning.value = 'Das laufende Programm konnte lokal nicht gespeichert werden.';
    }
  }

  async function clearPersistedSession(): Promise<void> {
    const key = storageKey();
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
    const app = useAppStore();
    const unique = [...new Set(ids)];
    const missing: string[] = [];
    const map = new Map<string, Question>();
    const stale = new Map<string, Question>();
    let manifest: Awaited<ReturnType<typeof app.coreClient.manifest>> | undefined;
    try {
      manifest = await app.coreClient.manifest();
    } catch {
      manifest = undefined;
    }
    for (const id of unique) {
      const cached = await questionCache.get(id);
      if (!cached) {
        missing.push(id);
        continue;
      }
      const expectedHash = manifest?.items[id];
      if (!manifest || (expectedHash && questionContentHash(cached) === expectedHash)) {
        map.set(id, cached);
      } else {
        stale.set(id, cached);
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      try {
        const res = await app.coreClient.getQuestionsBatch(missing);
        for (const q of res.questions) map.set(q.id, q);
        await questionCache.putMany(res.questions);
      } catch (e) {
        for (const [id, q] of stale) {
          if (!map.has(id)) map.set(id, q);
        }
        if (map.size === 0) throw e;
        warning.value = `${missing.length} Aufgaben konnten nicht geladen werden — Programm läuft mit ${map.size} gespeicherten weiter.`;
      }
    }
    questions.value = map;
  }

  async function beginSession(list: SessionItem[]): Promise<void> {
    items.value = list;
    index.value = 0;
    graded.value = [];
    preAnswerFsrs.clear();
    phase.value = list.length > 0 ? 'running' : 'summary';
    partShownAt.value = Date.now();
    if (list.length > 0) await persistSession();
    else await clearPersistedSession();
  }

  /**
   * Bulk practice handoff (URL-bloat fix): the browse page seeds the session
   * IN THE STORE and navigates to a bare /practice — hundreds of question ids
   * never enter the URL. Single questions keep the shareable ?questions= link.
   */
  async function startPrepared(questionIds: string[]): Promise<void> {
    await startQuestions(questionIds);
  }

  /** Smart session: FSRS-due reviews + weak-competency new parts (core decides). */
  async function startSmart(opts?: { count?: number; filters?: QuestionsFilter }): Promise<void> {
    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    try {
      const app = useAppStore();
      const auth = useAuthStore();
      const progress = useProgressStore();
      // Logged in: reconcile with the cloud archive before asking for
      // recommendations (contract §8.2 step 2 — checksum compare inside).
      if (auth.isLoggedIn) {
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
      const req: Parameters<typeof app.coreClient.recommend>[0] = {
        userState,
        count: opts?.count ?? 20,
      };
      if (opts?.filters) req.filters = opts.filters;
      const rec = await app.coreClient.recommend(req);
      await fetchQuestions(rec.items.map((i) => i.questionId));
      // Guards: playable parts only, and NEVER an excluded part (supplement
      // §1.4 — belt to the userState projection's braces).
      const excluded = progress.excludedPartIds;
      const list: SessionItem[] = rec.items.filter((i) => {
        if (excluded.has(i.partId)) return false;
        const q = questions.value.get(i.questionId);
        return q?.parts.some((p) => p.id === i.partId && p.answer);
      });
      await beginSession(list);
    } catch (e) {
      phase.value = 'error';
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Practice explicit questions (whole exam or a hand-picked set) —
   * user-driven, so excluded parts stay OPENABLE here when a single question
   * is chosen deliberately (supplement §1.4: exclusion is not deletion).
   * For bulk selections (more than one question) excluded parts are skipped.
   */
  async function startQuestions(questionIds: string[]): Promise<void> {
    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    try {
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
      await beginSession(list);
    } catch (e) {
      phase.value = 'error';
      error.value = e instanceof Error ? e.message : String(e);
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
    graded.value = [...graded.value, record];
    const { previousFsrs } = await progress.applyGrade({
      partId: payload.part.id,
      questionId: cur.question.id,
      competencyCodes: payload.part.competencies.map((c) => c.code),
      result: payload.result,
      elapsedMs,
    });
    preAnswerFsrs.set(payload.part.id, previousFsrs);
    // The grade and its session marker must both be durable before any
    // best-effort network work, otherwise an interruption can replay the part.
    await persistSession();
    if (auth.isLoggedIn) await progress.queueAttempt(toAttemptRecord(record));
    if (auth.isLoggedIn && graded.value.length % SYNC_EVERY_N_GRADES === 0) {
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
    if (!auth.isLoggedIn) return;
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

  /**
   * Rehydrate an interrupted program from IndexedDB. Questions themselves are
   * restored through the existing cache-first loader, keeping the snapshot
   * small and usable offline.
   */
  async function restoreSession(): Promise<boolean> {
    if (phase.value === 'loading') return true;
    if (phase.value === 'running') {
      if (current.value && gradedPartIds.value.has(current.value.item.partId)) {
        next();
        await sessionPersistenceTail;
      }
      return true;
    }
    const key = storageKey();
    await sessionPersistenceTail;
    const snapshot = await storage.get<unknown>(STORAGE.app, key);
    if (!isPersistedPracticeSession(snapshot) || snapshot.items.length === 0) {
      if (snapshot !== undefined) await clearPersistedSession();
      return false;
    }

    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    try {
      await fetchQuestions(snapshot.items.map((item) => item.questionId));
      const validItems = snapshot.items.filter((item) => {
        const question = questions.value.get(item.questionId);
        return question?.parts.some((part) => part.id === item.partId && part.answer);
      });
      if (validItems.length === 0) {
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
      graded.value = restoredGraded;
      preAnswerFsrs.clear();
      if (restoredGraded.length >= validItems.length) {
        index.value = restoredIndex;
        phase.value = 'summary';
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
      await persistSession();
      return true;
    } catch (e) {
      phase.value = 'error';
      error.value = e instanceof Error ? e.message : String(e);
      return true;
    }
  }

  function abort(): void {
    phase.value = 'idle';
    warning.value = undefined;
    items.value = [];
    graded.value = [];
    preAnswerFsrs.clear();
    index.value = 0;
    void clearPersistedSession();
  }

  return {
    items,
    questions,
    index,
    graded,
    phase,
    error,
    warning,
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
    abort,
  };
});
