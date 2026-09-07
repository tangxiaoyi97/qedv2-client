<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ArrowRight, Check, Lightbulb, RotateCcw } from 'lucide-vue-next';
import type { AiDiagnosisCode, AiDiagnosisResult, RichText } from '@qed2/core-logic';
import AiBadge from '../shared/AiBadge.vue';
import MarkdownView from '../shared/MarkdownView.vue';
import QButton from '../shared/QButton.vue';
import QIconButton from '../shared/QIconButton.vue';
import QSkeleton from '../shared/QSkeleton.vue';
import RichTextView from '../shared/RichTextView.vue';

const props = defineProps<{
  stage: 'hint' | 'diagnosis' | 'correction';
  hintLevel?: 1 | 2 | 3;
  markdown?: string;
  authoredHint?: RichText;
  nextAction?: string;
  diagnosis?: AiDiagnosisResult;
  correctionOutcome?: 'incorrect' | 'partial' | 'correct';
  loading?: boolean;
  error?: string;
  storageWarning?: string;
  canRenew?: boolean;
  aiGenerated?: boolean;
  canRequestHint?: boolean;
  canRequestDiagnosis?: boolean;
  canCorrect?: boolean;
  model?: string;
  source?: string;
}>();

const emit = defineEmits<{
  requestHint: [];
  requestDiagnosis: [];
  renew: [];
  correct: [];
  dismiss: [];
}>();

const titleId = 'q-learning-title-' + useId();
const hasContent = computed(() => Boolean(
  props.authoredHint?.length || props.markdown?.trim() || props.diagnosis || props.correctionOutcome,
));
const panelTitle = computed(() => props.aiGenerated ? 'KI-Hilfe' : 'Hinweis');

const DIAGNOSIS_LABELS: Record<AiDiagnosisCode, string> = {
  concept: 'Begriff verwechselt',
  setup: 'Ansatz passt noch nicht',
  algebra: 'Algebraischer Schritt',
  arithmetic: 'Rechenfehler',
  condition: 'Bedingung übersehen',
  'notation-unit': 'Notation oder Einheit',
  incomplete: 'Begründung unvollständig',
  careless: 'Flüchtigkeitsfehler',
  unknown: 'Fehler noch unklar',
};

const correctionText = computed(() => {
  if (props.correctionOutcome === 'correct') return 'Korrektur gelungen.';
  if (props.correctionOutcome === 'partial') return 'Fast — ein Schritt fehlt noch.';
  if (props.correctionOutcome === 'incorrect') return 'Noch nicht. Prüfe den ersten abweichenden Schritt.';
  return '';
});
const panelElement = ref<HTMLElement | null>(null);

defineExpose({
  focus: () => panelElement.value?.focus(),
});
</script>

<template>
  <section
    ref="panelElement"
    class="q-learning"
    :aria-labelledby="titleId"
    tabindex="-1"
    aria-live="polite"
    :aria-busy="loading ? 'true' : 'false'"
  >
    <div class="q-learning__head">
      <Lightbulb :size="18" aria-hidden="true" />
      <h3 :id="titleId">{{ panelTitle }}</h3>
      <AiBadge v-if="aiGenerated && hasContent" size="sm" />
      <QIconButton :aria-label="`${panelTitle} schließen`" @click="emit('dismiss')" />
    </div>

    <div v-if="loading" class="q-learning__loading" aria-live="polite">
      <QSkeleton :rows="3" height="16px" radius="6px" gap="9px" label="Hilfe wird vorbereitet …" />
    </div>

    <div v-else-if="error" class="q-learning__error" role="alert">
      <p>{{ error }}</p>
      <QButton v-if="canRenew" variant="secondary" @click="emit('renew')">
        Neu anfragen
      </QButton>
      <QButton
        v-else
        variant="secondary"
        @click="stage === 'hint' ? emit('requestHint') : emit('requestDiagnosis')"
      >
        Erneut versuchen
      </QButton>
      <p v-if="canRenew" class="q-learning__billing-note">
        Die neue Anfrage kann erneut berechnet werden.
      </p>
    </div>

    <template v-else>
      <div v-if="stage === 'hint' && (authoredHint?.length || markdown)" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">Hinweis {{ hintLevel ?? 1 }}</span>
        <RichTextView v-if="authoredHint?.length" :nodes="authoredHint" />
        <MarkdownView v-else-if="markdown" :source="markdown" />
        <p v-if="nextAction" class="q-learning__action">
          <ArrowRight :size="16" aria-hidden="true" />
          {{ nextAction }}
        </p>
      </div>

      <div v-else-if="stage === 'diagnosis' && diagnosis" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">{{ DIAGNOSIS_LABELS[diagnosis.errorCode] }}</span>
        <p>{{ diagnosis.reason }}</p>
        <blockquote v-if="diagnosis.evidenceVerified && diagnosis.evidence">
          {{ diagnosis.evidence }}
        </blockquote>
        <p class="q-learning__action">
          <ArrowRight :size="16" aria-hidden="true" />
          {{ diagnosis.correctionPrompt }}
        </p>
      </div>

      <div v-else-if="stage === 'diagnosis' && markdown" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">Erklärung</span>
        <MarkdownView :source="markdown" />
      </div>

      <div v-else-if="stage === 'correction' && correctionOutcome" class="q-learning__correction" role="status">
        <Check v-if="correctionOutcome === 'correct'" :size="18" aria-hidden="true" />
        <RotateCcw v-else :size="18" aria-hidden="true" />
        <span>{{ correctionText }}</span>
      </div>

      <div v-else-if="stage === 'correction' && diagnosis" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">{{ DIAGNOSIS_LABELS[diagnosis.errorCode] }}</span>
        <p>{{ diagnosis.reason }}</p>
        <p class="q-learning__action">
          <ArrowRight :size="16" aria-hidden="true" />
          {{ diagnosis.correctionPrompt }}
        </p>
      </div>

      <div v-else-if="stage === 'correction' && markdown" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">Für die Korrektur</span>
        <MarkdownView :source="markdown" />
        <p v-if="nextAction" class="q-learning__action">
          <ArrowRight :size="16" aria-hidden="true" />
          {{ nextAction }}
        </p>
      </div>

      <p v-else-if="stage === 'correction'" class="q-learning__correction" role="status">
        Versuche die Aufgabe noch einmal.
      </p>

      <div class="q-learning__actions">
        <QButton
          v-if="stage === 'hint' && canRequestHint"
          variant="secondary"
          @click="emit('requestHint')"
        >
          {{ hasContent ? 'Nächster Hinweis' : 'Hinweis 1' }}
        </QButton>
        <QButton
          v-if="stage === 'diagnosis' && canRequestDiagnosis && !diagnosis && !markdown"
          variant="secondary"
          @click="emit('requestDiagnosis')"
        >
          Fehler ansehen
        </QButton>
        <QButton v-if="stage === 'diagnosis' && canCorrect" @click="emit('correct')">
          Jetzt korrigieren
        </QButton>
      </div>

      <details v-if="aiGenerated && hasContent" class="q-learning__foot">
        <summary>KI-Inhalt · kann Fehler enthalten</summary>
        <span v-if="model && source !== 'pool'">{{ model }}</span>
      </details>
    </template>
    <p v-if="storageWarning" class="q-learning__storage" role="status">{{ storageWarning }}</p>
  </section>
</template>

<style scoped>
.q-learning {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding-top: 4px;
}
.q-learning__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--q-accent-strong);
}
.q-learning__head h3 {
  margin: 0;
  color: var(--q-ink);
  font-size: 15px;
  font-weight: 750;
}
.q-learning__head :deep(.q-icon-button) {
  margin-left: auto;
}
.q-learning__content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 14px;
  line-height: 1.65;
  color: var(--q-ink-2);
}
.q-learning__content :deep(p) {
  margin: 0;
}
.q-learning__eyebrow {
  width: max-content;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--q-accent-bg);
  color: var(--q-accent-strong);
  font-size: 10.5px;
  font-weight: 750;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.q-learning__content blockquote {
  margin: 0;
  padding: 9px 12px;
  border-left: 3px solid var(--q-border-2);
  background: var(--q-panel);
  color: var(--q-mut);
  font-size: 12.5px;
}
.q-learning__action,
.q-learning__correction {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-panel);
  color: var(--q-ink);
  font-weight: 650;
}
.q-learning__action svg,
.q-learning__correction svg {
  flex: none;
  margin-top: 2px;
}
.q-learning__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.q-learning__error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--q-err-border);
  border-radius: 9px;
  background: var(--q-err-bg);
  color: var(--q-err-ink);
}
.q-learning__error p {
  margin: 0;
}
.q-learning__billing-note {
  font-size: 12px;
}
.q-learning__storage {
  margin: 0;
  color: var(--q-warn-ink, var(--q-mut));
  font-size: 12px;
  line-height: 1.45;
}
.q-learning__foot {
  color: var(--q-faint);
  font-size: 11px;
}
.q-learning__foot summary {
  cursor: pointer;
}
.q-learning__foot span {
  display: block;
  margin-top: 4px;
  font-family: ui-monospace, Menlo, monospace;
}
@media (max-width: 360px) {
  .q-learning__actions :deep(.q-btn) {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .q-learning :deep(.q-reveal) {
    animation: none;
  }
}
</style>
