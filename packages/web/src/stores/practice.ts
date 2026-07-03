/**
 * Practice session store — drives the practice flow:
 * recommend (or explicit selection) → fetch full questions → per-part
 * answer/grade cycle → archive updates → periodic sync.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type {
  GradeResult,
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
}

export const usePracticeStore = defineStore('practice', () => {
  const items = ref<SessionItem[]>([]);
  const questions = shallowRef<Map<string, Question>>(new Map());
  const index = ref(0);
  const graded = ref<GradedRecord[]>([]);
  const phase = ref<'idle' | 'loading' | 'running' | 'summary' | 'error'>('idle');
  const error = ref<string | undefined>();
  const partShownAt = ref(0);

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

  async function fetchQuestions(ids: string[]): Promise<void> {
    const app = useAppStore();
    const unique = [...new Set(ids)];
    const missing: string[] = [];
    const map = new Map<string, Question>();
    for (const id of unique) {
      const cached = await questionCache.get(id);
      if (cached) map.set(id, cached);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const res = await app.coreClient.getQuestionsBatch(missing);
      for (const q of res.questions) map.set(q.id, q);
      await questionCache.putMany(res.questions);
    }
    questions.value = map;
  }

  function beginSession(list: SessionItem[]): void {
    items.value = list;
    index.value = 0;
    graded.value = [];
    phase.value = list.length > 0 ? 'running' : 'summary';
    partShownAt.value = Date.now();
  }

  /** Smart session: FSRS-due reviews + weak-competency new parts (core decides). */
  async function startSmart(opts?: { count?: number; filters?: QuestionsFilter }): Promise<void> {
    phase.value = 'loading';
    error.value = undefined;
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
      // Guard against non-playable/missing parts.
      const list: SessionItem[] = rec.items.filter((i) => {
        const q = questions.value.get(i.questionId);
        return q?.parts.some((p) => p.id === i.partId && p.answer);
      });
      beginSession(list);
    } catch (e) {
      phase.value = 'error';
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** Practice explicit questions (whole exam or a hand-picked set). */
  async function startQuestions(questionIds: string[]): Promise<void> {
    phase.value = 'loading';
    error.value = undefined;
    try {
      await fetchQuestions(questionIds);
      const list: SessionItem[] = [];
      for (const id of questionIds) {
        const q = questions.value.get(id);
        for (const p of q?.parts ?? []) {
          if (p.answer) list.push({ questionId: id, partId: p.id, reason: 'manual' });
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
    graded.value = [
      ...graded.value,
      {
        partId: payload.part.id,
        questionId: cur.question.id,
        result: payload.result,
        reason: cur.item.reason,
        gradedAt,
        elapsedMs: Math.max(0, Date.now() - partShownAt.value),
      },
    ];
    await progress.applyGrade({
      partId: payload.part.id,
      competencyCodes: payload.part.competencies.map((c) => c.code),
      result: payload.result,
    });
    if (auth.isLoggedIn && graded.value.length % SYNC_EVERY_N_GRADES === 0) {
      void progress.syncNow({ quiet: true });
    }
  }

  function next(): void {
    if (index.value + 1 < items.value.length) {
      index.value += 1;
      partShownAt.value = Date.now();
    } else {
      phase.value = 'summary';
      void endOfSession();
    }
  }

  async function endOfSession(): Promise<void> {
    const auth = useAuthStore();
    const progress = useProgressStore();
    const app = useAppStore();
    if (!auth.isLoggedIn) return;
    await progress.syncNow({ quiet: true });
    // Optional audit trail (contract §4.2: append-only, never state).
    const attempts: AttemptRecord[] = graded.value.map((g) => ({
      questionId: g.questionId,
      partId: g.partId,
      correct: g.result.correct,
      awardedPoints: g.result.awardedPoints,
      elapsedMs: g.elapsedMs,
      gradedAt: g.gradedAt,
    }));
    if (attempts.length > 0) {
      try {
        await app.serverClient.recordAttempts(attempts);
      } catch {
        /* audit is best-effort by design */
      }
    }
  }

  function abort(): void {
    phase.value = 'idle';
    items.value = [];
    graded.value = [];
    index.value = 0;
  }

  return {
    items,
    questions,
    index,
    graded,
    phase,
    error,
    total,
    current,
    summary,
    startSmart,
    startQuestions,
    recordGraded,
    next,
    abort,
  };
});
