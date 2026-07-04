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
import { questionContentHash } from '@qed2/core-logic';
import type {
  FsrsState,
  GradeResult,
  Grading,
  Question,
  QuestionPart,
  QuestionsFilter,
  RecommendReason,
  Submission,
  AttemptRecord,
} from '@qed2/core-logic';
import { questionCache } from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';
import { useProgressStore } from './progress.js';

/** Sync after every N graded parts while logged in (brief §5: sync eagerly). */
const SYNC_EVERY_N_GRADES = 3;

export interface SessionItem {
  questionId: string;
  partId: string;
  reason: RecommendReason | 'manual';
}

export interface GradedRecord {
  partId: string;
  questionId: string;
  result: GradeResult;
  reason: SessionItem['reason'];
  gradedAt: string;
  elapsedMs: number;
  /** Whether this answer event has been appended to the server audit log. */
  attemptRecorded?: boolean;
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

  function beginSession(list: SessionItem[]): void {
    items.value = list;
    index.value = 0;
    graded.value = [];
    preAnswerFsrs.clear();
    phase.value = list.length > 0 ? 'running' : 'summary';
    partShownAt.value = Date.now();
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
      if (auth.isLoggedIn) await progress.syncNow({ quiet: true });
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
      beginSession(list);
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
      beginSession(list);
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
      partId: payload.part.id,
      questionId: cur.question.id,
      result: payload.result,
      reason: cur.item.reason,
      gradedAt,
      elapsedMs,
      attemptRecorded: false,
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
    if (auth.isLoggedIn) await recordAttemptAudit([record]);
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
        return;
      }
    }
    phase.value = 'summary';
    void endOfSession();
  }

  async function endOfSession(): Promise<void> {
    const auth = useAuthStore();
    const progress = useProgressStore();
    if (!auth.isLoggedIn) return;
    await progress.syncNow({ quiet: true });
    // Optional audit trail (contract §4.2: append-only, never state).
    await recordAttemptAudit(graded.value.filter((g) => !g.attemptRecorded));
  }

  function toAttemptRecord(g: GradedRecord): AttemptRecord {
    return {
      questionId: g.questionId,
      partId: g.partId,
      correct: g.result.correct,
      awardedPoints: g.result.awardedPoints,
      elapsedMs: g.elapsedMs,
      gradedAt: g.gradedAt,
    };
  }

  function attemptKey(g: GradedRecord): string {
    return `${g.partId}\u0000${g.gradedAt}`;
  }

  async function recordAttemptAudit(records: GradedRecord[]): Promise<void> {
    const pending = records.filter((g) => !g.attemptRecorded);
    if (pending.length === 0) return;
    const app = useAppStore();
    try {
      await app.serverClient.recordAttempts(pending.map(toAttemptRecord));
      const recorded = new Set(pending.map(attemptKey));
      graded.value = graded.value.map((g) =>
        recorded.has(attemptKey(g)) ? { ...g, attemptRecorded: true } : g,
      );
    } catch {
      /* audit is best-effort by design; endOfSession retries pending rows */
    }
  }

  async function finishSession(): Promise<void> {
    await endOfSession();
  }

  function abort(): void {
    phase.value = 'idle';
    warning.value = undefined;
    items.value = [];
    graded.value = [];
    preAnswerFsrs.clear();
    index.value = 0;
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
    abort,
  };
});
