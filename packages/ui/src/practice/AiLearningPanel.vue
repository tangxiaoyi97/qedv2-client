<script setup lang="ts">
import { useI18n } from '../i18n.js';

import { computed, ref, useId } from 'vue';
import { ArrowRight, KeyRound, Lightbulb } from 'lucide-vue-next';
import type { AiDiagnosisCode, AiDiagnosisResult, RichText } from '@qed2/core-logic';
import AiBadge from '../shared/AiBadge.vue';
import MarkdownView from '../shared/MarkdownView.vue';
import QButton from '../shared/QButton.vue';
import QIconButton from '../shared/QIconButton.vue';
import QSkeleton from '../shared/QSkeleton.vue';
import RichTextView from '../shared/RichTextView.vue';

const { t } = useI18n();

const props = defineProps<{
  stage: 'hint' | 'diagnosis' | 'explanation';
  /** The enclosing dialog already supplies its title and close action. */
  hideHeader?: boolean;
  hintLevel?: 1 | 2 | 3;
  markdown?: string;
  authoredHint?: RichText;
  nextAction?: string;
  diagnosis?: AiDiagnosisResult;
  loading?: boolean;
  error?: string;
  storageWarning?: string;
  canRenew?: boolean;
  aiGenerated?: boolean;
  canRequestHint?: boolean;
  canRequestDiagnosis?: boolean;
  canRequestExplanation?: boolean;
  needsSetup?: boolean;
  model?: string;
  source?: string;
}>();

const emit = defineEmits<{
  requestHint: [];
  requestDiagnosis: [];
  requestExplanation: [];
  renew: [];
  dismiss: [];
  setup: [];
}>();

const titleId = 'q-learning-title-' + useId();
const hasContent = computed(() => Boolean(
  props.authoredHint?.length || props.markdown?.trim() || props.diagnosis,
));
const panelTitle = computed(() => t(props.aiGenerated
  ? 'KI-Hilfe' : props.stage === 'hint' ? 'Hinweis' : 'Erklärung'));

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
    <div class="q-learning__head" :class="{ 'q-learning__head--hidden': hideHeader }">
      <Lightbulb :size="18" aria-hidden="true" />
      <h3 :id="titleId">{{ panelTitle }}</h3>
      <AiBadge v-if="aiGenerated && hasContent" size="sm" />
      <QIconButton :aria-label="t('{title} schließen', { title: panelTitle })" @click="emit('dismiss')" />
    </div>

    <div v-if="loading" class="q-learning__loading" aria-live="polite">
      <QSkeleton :rows="3" height="16px" radius="6px" gap="9px" :label="t('Hilfe wird vorbereitet …')" />
    </div>

    <div v-else-if="error" class="q-learning__error" role="alert">
      <p>{{ error }}</p>
      <QButton v-if="needsSetup" variant="secondary" @click="emit('setup')">
        <KeyRound :size="16" aria-hidden="true" />
        {{ t('KI einrichten') }}
      </QButton>
      <QButton v-else-if="canRenew" variant="secondary" @click="emit('renew')">
        {{ t('Neu anfragen') }}
      </QButton>
      <QButton
        v-else-if="stage === 'hint' ? canRequestHint : stage === 'explanation' ? canRequestExplanation : canRequestDiagnosis"
        variant="secondary"
        @click="stage === 'hint' ? emit('requestHint') : stage === 'explanation' ? emit('requestExplanation') : emit('requestDiagnosis')"
      >
        {{ t('Erneut versuchen') }}
      </QButton>
      <p v-if="canRenew && !needsSetup" class="q-learning__billing-note">
        {{ t('Die neue Anfrage kann erneut berechnet werden.') }}
      </p>
    </div>

    <template v-else>
      <p v-if="!hasContent" class="q-learning__intro">{{ t(needsSetup ? 'Verbinde eine KI, um Hilfe zu dieser Aufgabe zu erhalten.' : stage === 'hint' ? 'Ein Hinweis hilft dir beim nächsten eigenen Schritt.' : stage === 'explanation' ? 'Der Lösungsweg wird Schritt für Schritt erklärt.' : 'Finde heraus, an welcher Stelle dein Lösungsweg abweicht.') }}</p>
      <div v-if="stage === 'hint' && (authoredHint?.length || markdown)" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">{{ t('Hinweis {level}', { level: hintLevel ?? 1 }) }}</span>
        <RichTextView v-if="authoredHint?.length" :nodes="authoredHint" />
        <MarkdownView v-else-if="markdown" :source="markdown" />
        <p v-if="nextAction" class="q-learning__action">
          <ArrowRight :size="16" aria-hidden="true" />
          {{ nextAction }}
        </p>
      </div>

      <div v-else-if="stage === 'diagnosis' && diagnosis" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">{{ t(DIAGNOSIS_LABELS[diagnosis.errorCode]) }}</span>
        <p>{{ diagnosis.reason }}</p>
        <blockquote v-if="diagnosis.evidenceVerified && diagnosis.evidence">
          {{ diagnosis.evidence }}
        </blockquote>
        <p class="q-learning__action">
          <ArrowRight :size="16" aria-hidden="true" />
          {{ diagnosis.correctionPrompt }}
        </p>
      </div>

      <div v-else-if="stage !== 'hint' && markdown" class="q-learning__content q-reveal">
        <span class="q-learning__eyebrow">{{ t('Erklärung') }}</span>
        <MarkdownView :source="markdown" />
      </div>

      <div class="q-learning__actions">
        <QButton v-if="needsSetup" variant="secondary" @click="emit('setup')">
          <KeyRound :size="16" aria-hidden="true" />
          {{ t('KI einrichten') }}
        </QButton>
        <QButton
          v-if="stage === 'hint' && canRequestHint"
          variant="secondary"
          @click="emit('requestHint')"
        >
          {{ t(hasContent ? 'Nächster Hinweis' : 'Hinweis 1') }}
        </QButton>
        <QButton
          v-if="stage !== 'hint' && (stage === 'explanation' ? canRequestExplanation : canRequestDiagnosis) && !diagnosis && !markdown"
          variant="secondary"
          @click="stage === 'explanation' ? emit('requestExplanation') : emit('requestDiagnosis')"
        >
          {{ t('Erklärung anfordern') }}
        </QButton>
      </div>

      <details v-if="aiGenerated && hasContent" class="q-learning__foot">
        <summary>{{ t('KI-Inhalt · kann Fehler enthalten') }}</summary>
        <span v-if="model && source !== 'pool'">{{ model }}</span>
      </details>
    </template>
    <p v-if="storageWarning" class="q-learning__storage" role="status">{{ storageWarning }}</p>
  </section>
</template>

<style scoped>
.q-learning__head--hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.q-learning__head--hidden :deep(button) { display: none; }
.q-learning__intro { margin: 0; color: var(--q-mut); font-size: 14px; line-height: 1.65; }

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
.q-learning__action {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 0;
  color: var(--q-ink);
  font-weight: 650;
}
.q-learning__action svg {
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
