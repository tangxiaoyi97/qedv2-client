<script setup lang="ts">
/**
 * Practice flow (prototype 1b/1d, mobile 5b/5c) — full-screen focus mode.
 * Session orchestration lives in the practice store; grading inside
 * PartPlayer; this view provides chrome, navigation and the summary.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { GradeResult, QuestionsFilter, Submission, QuestionPart, Term, ExamPart } from '@qed2/core-logic';
import { PartPlayer, QuestionHeader, QButton, QChip, RichTextView, StateIcon } from '@qed2/ui';
import { usePracticeStore } from '../stores/practice.js';
import { useProgressStore } from '../stores/progress.js';
import { useAuthStore } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();
const practice = usePracticeStore();
const progress = useProgressStore();
const auth = useAuthStore();

const reviewed = ref(false);

const current = computed(() => practice.current);
const progressPct = computed(() =>
  practice.total === 0 ? 0 : Math.round((practice.index / practice.total) * 100),
);

function start(): void {
  reviewed.value = false;
  const q = route.query;
  if (typeof q.questions === 'string' && q.questions.length > 0) {
    void practice.startQuestions(q.questions.split(',').filter(Boolean));
    return;
  }
  const filters: QuestionsFilter = {};
  if (typeof q.year === 'string' && q.year) filters.year = Number(q.year);
  if (typeof q.term === 'string' && q.term) filters.term = q.term as Term;
  if (typeof q.part === 'string' && q.part) filters.part = q.part as ExamPart;
  if (typeof q.gk === 'string' && q.gk) filters.gk = q.gk;
  const opts: Parameters<typeof practice.startSmart>[0] =
    Object.keys(filters).length > 0 ? { filters } : {};
  void practice.startSmart(opts);
}

onMounted(() => {
  if (practice.phase !== 'running') start();
});

watch(
  () => practice.index,
  () => {
    reviewed.value = false;
    window.scrollTo({ top: 0 });
  },
);

async function onGraded(payload: {
  partId: string;
  result: GradeResult;
  submission: Submission;
  selfAssessed: boolean;
}): Promise<void> {
  const part: QuestionPart | undefined = current.value?.part;
  if (!part || part.id !== payload.partId) return;
  await practice.recordGraded({ part, result: payload.result, submission: payload.submission });
  reviewed.value = true;
}

function exit(): void {
  if (practice.phase === 'running' && practice.graded.length < practice.total) {
    if (!window.confirm('Sitzung beenden? Dein Fortschritt bleibt gespeichert.')) return;
  }
  practice.abort();
  void router.push('/');
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'ArrowRight' && reviewed.value && practice.phase === 'running') {
    ev.preventDefault();
    practice.next();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const multiPart = computed(() => (current.value?.question.parts.length ?? 0) > 1);

const summaryStats = computed(() => practice.summary);
</script>

<template>
  <div class="practice q-app">
    <!-- top bar -->
    <div class="practice__topbar">
      <button type="button" class="practice__close" aria-label="Sitzung beenden" @click="exit">✕</button>
      <div class="practice__progress">
        <div class="practice__progress-label">
          <template v-if="practice.phase === 'running'">Aufgabe {{ practice.index + 1 }} von {{ practice.total }}</template>
          <template v-else-if="practice.phase === 'summary'">Sitzung abgeschlossen</template>
          <template v-else>QED<span class="practice__logo-accent">2</span></template>
        </div>
        <div class="practice__progress-track">
          <div class="practice__progress-fill" :style="{ width: `${practice.phase === 'summary' ? 100 : progressPct}%` }" />
        </div>
      </div>
      <span class="practice__spacer" />
    </div>

    <!-- loading -->
    <div v-if="practice.phase === 'loading'" class="practice__center">
      <div class="practice__skeleton">
        <div class="practice__skeleton-bar" style="width: 40%" />
        <div class="practice__skeleton-bar" style="width: 90%" />
        <div class="practice__skeleton-bar" style="width: 75%" />
        <div class="practice__skeleton-bar" style="width: 85%" />
      </div>
      <div class="practice__loading-text">Aufgaben werden geladen …</div>
    </div>

    <!-- error -->
    <div v-else-if="practice.phase === 'error'" class="practice__center">
      <div class="practice__error">
        <div class="practice__error-title">Aufgaben konnten nicht geladen werden</div>
        <div class="practice__error-text">
          {{ practice.error }} — ist der Inhalts-Server erreichbar? (Einstellungen → Serveradressen)
        </div>
        <div class="practice__error-actions">
          <QButton variant="secondary" @click="exit">Zurück</QButton>
          <QButton @click="start">Erneut versuchen</QButton>
        </div>
      </div>
    </div>

    <!-- summary -->
    <div v-else-if="practice.phase === 'summary'" class="practice__center">
      <div class="practice__summary">
        <h2 class="practice__summary-title">Sitzung abgeschlossen</h2>
        <div v-if="summaryStats.count === 0" class="practice__error-text">
          Keine passenden Aufgaben gefunden — andere Filter probieren?
        </div>
        <template v-else>
          <div class="practice__summary-grid">
            <div class="practice__stat">
              <div class="practice__stat-num">{{ summaryStats.count }}</div>
              <div class="practice__stat-label">Aufgaben</div>
            </div>
            <div class="practice__stat">
              <div class="practice__stat-num">
                {{ summaryStats.points.toLocaleString('de-AT') }}<span class="practice__stat-sub">/{{ summaryStats.maxPoints.toLocaleString('de-AT') }}</span>
              </div>
              <div class="practice__stat-label">Punkte</div>
            </div>
            <div class="practice__stat practice__stat--verdicts">
              <span class="practice__verdict"><StateIcon state="correct" :size="16" /> {{ summaryStats.byVerdict.correct }}</span>
              <span class="practice__verdict"><StateIcon state="partial" :size="16" /> {{ summaryStats.byVerdict.partial }}</span>
              <span class="practice__verdict"><StateIcon state="incorrect" :size="16" /> {{ summaryStats.byVerdict.incorrect }}</span>
            </div>
          </div>
          <div v-if="summaryStats.competencies.length > 0" class="practice__summary-comps">
            <QChip v-for="c in summaryStats.competencies" :key="c">{{ c }}</QChip>
          </div>
          <div v-if="auth.isLoggedIn" class="practice__sync-note">
            <template v-if="progress.syncStatus.state === 'synced'">✓ Synchronisiert</template>
            <template v-else-if="progress.syncStatus.state === 'offline'">Offline — wird später synchronisiert</template>
          </div>
        </template>
        <div class="practice__summary-actions">
          <QButton variant="secondary" @click="start">Noch eine Sitzung</QButton>
          <QButton @click="router.push('/')">Zur Startseite</QButton>
        </div>
      </div>
    </div>

    <!-- running -->
    <template v-else-if="practice.phase === 'running' && current">
      <div class="practice__meta">
        <QuestionHeader
          :question="current.question"
          :competencies="current.part.competencies"
          :points="current.part.points"
        />
      </div>

      <div class="practice__content">
        <div v-if="current.question.prompt && current.question.prompt.length > 0" class="practice__qprompt">
          <RichTextView :nodes="current.question.prompt" />
        </div>

        <PartPlayer
          :key="current.part.id"
          :part="current.part"
          :label="multiPart ? `Teil ${current.part.label}` : undefined"
          @graded="onGraded"
        />
      </div>

      <div v-if="reviewed" class="practice__next">
        <span class="practice__key-hint">→ weiter</span>
        <QButton @click="practice.next()">Weiter →</QButton>
      </div>
      <div v-if="progress.syncStatus.state === 'offline' && auth.isLoggedIn" class="practice__offline">
        Offline — wird später synchronisiert
      </div>
    </template>
  </div>
</template>

<style scoped>
.practice {
  min-height: 100vh;
  background: var(--q-card);
  display: flex;
  flex-direction: column;
}
.practice__topbar {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--q-border);
  gap: 16px;
  position: sticky;
  top: 0;
  background: var(--q-card);
  z-index: 10;
}
.practice__close {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: none;
  background: none;
  color: var(--q-mut-2);
  font-size: 17px;
  cursor: pointer;
}
.practice__close:hover {
  background: var(--q-panel);
}
.practice__progress {
  flex: 1;
  max-width: 340px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.practice__progress-label {
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  color: var(--q-ink-2);
}
.practice__logo-accent {
  color: var(--q-accent);
}
.practice__progress-track {
  height: 5px;
  border-radius: 3px;
  background: var(--q-track);
  overflow: hidden;
}
.practice__progress-fill {
  height: 100%;
  background: var(--q-accent);
  transition: width 0.3s ease;
}
.practice__spacer {
  width: 34px;
}
.practice__meta {
  padding: 12px 28px;
  background: var(--q-panel);
  border-bottom: 1px solid var(--q-border-soft);
}
.practice__content {
  padding: 28px 28px 8px;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
  flex: 1;
}
.practice__qprompt {
  font-size: 15.5px;
  line-height: 1.65;
  margin-bottom: 18px;
}
.practice__next {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 14px 28px calc(14px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--q-border);
  background: var(--q-card);
}
.practice__key-hint {
  font: 500 11px ui-monospace, Menlo, monospace;
  color: var(--q-hint);
}
.practice__offline {
  text-align: center;
  font-size: 11.5px;
  color: var(--q-faint);
  padding: 6px 0 10px;
}
.practice__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 18px;
}
.practice__skeleton {
  width: 100%;
  max-width: 560px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 12px;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.practice__skeleton-bar {
  height: 12px;
  border-radius: 6px;
  background: var(--q-track);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}
.practice__loading-text {
  font-size: 13px;
  color: var(--q-mut-2);
}
.practice__error {
  max-width: 480px;
  text-align: center;
}
.practice__error-title {
  font-weight: 700;
  font-size: 16px;
  margin-bottom: 8px;
}
.practice__error-text {
  font-size: 13px;
  color: var(--q-mut);
  line-height: 1.55;
  margin-bottom: 18px;
}
.practice__error-actions,
.practice__summary-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
.practice__summary {
  width: 100%;
  max-width: 520px;
  text-align: center;
}
.practice__summary-title {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin: 0 0 20px;
}
.practice__summary-grid {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.practice__stat {
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 12px;
  padding: 14px 22px;
}
.practice__stat-num {
  font-weight: 800;
  font-size: 26px;
}
.practice__stat-sub {
  font-size: 14px;
  color: var(--q-mut-2);
  font-weight: 600;
}
.practice__stat-label {
  font-size: 11px;
  color: var(--q-faint);
  margin-top: 2px;
}
.practice__stat--verdicts {
  display: flex;
  align-items: center;
  gap: 14px;
}
.practice__verdict {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 15px;
}
.practice__summary-comps {
  display: flex;
  gap: 7px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.practice__sync-note {
  font-size: 12px;
  color: var(--q-mut-2);
  margin-bottom: 16px;
}
@media (max-width: 640px) {
  .practice__content,
  .practice__meta {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>
