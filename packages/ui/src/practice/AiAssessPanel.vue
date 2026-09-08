<script setup lang="ts">
import { useI18n } from '../i18n.js';

/**
 * AI assistance for the self-assessment step.
 *
 * It PROPOSES; the user disposes. That is not timidity — the grade feeds the
 * FSRS schedule, so a wrong verdict does not just misreport one question, it
 * quietly bends months of revision, and nobody notices. So the primary button
 * stays exactly where it was and still has to be pressed.
 *
 * What the panel adds is evidence: for each criterion, the model's verdict,
 * how sure it is, and the WORDS in the answer it is relying on. The quote is
 * the point — it is what lets a human check the machine in two seconds
 * instead of taking its word.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { KeyRound } from 'lucide-vue-next';
import { AI_SUGGESTION_CONFIDENCE_FLOOR } from '@qed2/core-logic';
import AiBadge from '../shared/AiBadge.vue';
import StateIcon from '../shared/StateIcon.vue';
import QButton from '../shared/QButton.vue';
import QSkeleton from '../shared/QSkeleton.vue';

const { t } = useI18n();

export interface AssessedCriterion {
  index: number;
  met: boolean;
  confidence: number;
  quote: string;
  reason: string;
  quoteVerified: boolean;
}

export interface OverallAssessment {
  points: number;
  confidence: number;
  quote: string;
  reason: string;
  quoteVerified: boolean;
}

const props = defineProps<{
  criteria?: AssessedCriterion[] | undefined;
  /** For parts with no scored criteria: one decision instead of many. */
  overall?: OverallAssessment | undefined;
  /** Max points, so the single score reads as "1 / 1". */
  maxPoints?: number;
  /** Labels from the rubric, indexed the same way. */
  labels: string[];
  loading?: boolean;
  error?: string | undefined;
  storageWarning?: string | undefined;
  canRenew?: boolean;
  needsSetup?: boolean;
  /** Server refuses to vouch for this reply — show it, tick nothing. */
  advisoryOnly?: boolean;
  model?: string | undefined;
  /** Hides the model name on the shared key — the server chose it, not you. */
  source?: string | undefined;
  /** The learner's decision, made before this comparison is requested. */
  studentCriteria?: boolean[];
  studentPoints?: number;
}>();

const emit = defineEmits<{ ask: []; renew: []; setup: [] }>();

const hasResult = computed(() => (props.criteria?.length ?? 0) > 0 || props.overall != null);
const idle = computed(() => !hasResult.value && !props.loading && !props.error);

const shaky = (c: AssessedCriterion): boolean =>
  c.confidence < AI_SUGGESTION_CONFIDENCE_FLOOR || (c.met && !c.quoteVerified);

const differingCriteria = computed(() => (props.criteria ?? []).filter((criterion) => {
  const own = props.studentCriteria?.[criterion.index];
  return own === undefined || own !== criterion.met;
}));
const overallDiffers = computed(() =>
  props.overall != null
  && (props.studentPoints === undefined || props.studentPoints !== props.overall.points),
);
const differenceCount = computed(() =>
  differingCriteria.value.length + (overallDiffers.value ? 1 : 0),
);
const overallShaky = computed(() =>
  props.overall != null &&
  (props.overall.confidence < AI_SUGGESTION_CONFIDENCE_FLOOR ||
    (props.overall.points > 0 && !props.overall.quoteVerified)),
);
const panelElement = ref<HTMLElement | null>(null);
watch(
  () => props.loading,
  async (loading, wasLoading) => {
    if (!loading && !wasLoading) return;
    // A delayed reply must not pull focus away from an answer being edited.
    if (!panelElement.value?.contains(document.activeElement)) return;
    await nextTick();
    if (document.activeElement === document.body || panelElement.value?.contains(document.activeElement)) {
      panelElement.value?.focus({ preventScroll: true });
    }
  },
);
</script>

<template>
  <section
    ref="panelElement"
    class="q-aia"
    tabindex="-1"
    aria-live="polite"
    :aria-busy="loading ? 'true' : 'false'"
  >
    <QButton v-if="needsSetup" variant="secondary" class="q-aia__ask" @click="emit('setup')">
      <KeyRound :size="16" aria-hidden="true" />
      {{ t('KI einrichten') }}
    </QButton>
    <QButton v-else-if="idle" variant="secondary" class="q-aia__ask" @click="emit('ask')">
      <AiBadge size="md" />
      {{ t('KI vergleichen') }}
    </QButton>

    <div v-else-if="loading" class="q-aia__loading">
      <QSkeleton :rows="labels.length || 2" height="34px" radius="8px" gap="7px" :label="t('KI prüft die Kriterien …')" />
    </div>

    <div v-else-if="error" class="q-aia__error" role="alert">
      <p class="q-aia__error-text">{{ error }}</p>
      <QButton v-if="canRenew" variant="secondary" @click="emit('renew')">{{ t('Neu anfragen') }}</QButton>
      <QButton v-else variant="secondary" @click="emit('ask')">{{ t('Nochmal versuchen') }}</QButton>
      <p v-if="canRenew" class="q-aia__billing-note">
        {{ t('Die neue Anfrage kann erneut berechnet werden.') }}
      </p>
    </div>

    <template v-else>
      <div class="q-aia__head">
        <AiBadge />
        <span class="q-aia__head-text">{{ t(advisoryOnly ? 'Nur als Hinweis' : 'KI-Vergleich') }}</span>
        <strong class="q-aia__summary">
          {{ differenceCount === 0 ? t('Keine Abweichung') : t(differenceCount === 1 ? '{count} Abweichung' : '{count} Abweichungen', { count: differenceCount }) }}
        </strong>
      </div>

      <!-- allOrNothing / tiered parts: one score, same evidence rules. -->
      <div
        v-if="overall && overallDiffers"
        class="q-aia__item q-aia__overall"
        :class="{ 'q-aia__item--shaky': overallShaky }"
      >
        <div class="q-aia__item-main">
          <StateIcon :state="overall.points > 0 ? 'correct' : 'incorrect'" :size="16" />
          <p class="q-aia__criterion">
            {{ t('Vorschlag:') }} {{ overall.points }}<template v-if="maxPoints !== undefined"> / {{ maxPoints }}</template> P
          </p>
          <span class="q-aia__confidence">{{ Math.round(overall.confidence * 100) }}%</span>
        </div>
        <details class="q-aia__evidence" :open="overallShaky">
          <summary>{{ t(overallShaky ? 'Begründung prüfen' : 'Begründung') }}</summary>
          <div class="q-aia__evidence-body">
            <p v-if="overall.quote" class="q-aia__quote" :class="{ 'q-aia__quote--unverified': !overall.quoteVerified }">
              „{{ overall.quote }}"
              <span v-if="!overall.quoteVerified" class="q-aia__quote-warn">{{ t('nicht wörtlich gefunden') }}</span>
            </p>
            <p v-if="overall.reason" class="q-aia__reason">{{ overall.reason }}</p>
          </div>
        </details>
      </div>

      <ul v-else class="q-aia__list">
        <li
          v-for="c in differingCriteria"
          :key="c.index"
          class="q-aia__item"
          :class="{ 'q-aia__item--shaky': shaky(c) }"
        >
          <div class="q-aia__item-main">
            <StateIcon :state="c.met ? 'correct' : 'incorrect'" :size="16" />
            <p class="q-aia__criterion">{{ labels[c.index] ?? t('Kriterium {index}', { index: c.index + 1 }) }}</p>
            <span class="q-aia__confidence" :title="t('Sicherheit {percent} %', { percent: Math.round(c.confidence * 100) })">
              {{ Math.round(c.confidence * 100) }}%
            </span>
          </div>
          <details class="q-aia__evidence" :open="shaky(c)">
            <summary>{{ t(shaky(c) ? 'Begründung prüfen' : 'Begründung') }}</summary>
            <div class="q-aia__evidence-body">
              <p v-if="c.quote" class="q-aia__quote" :class="{ 'q-aia__quote--unverified': !c.quoteVerified }">
                „{{ c.quote }}"
                <span v-if="!c.quoteVerified" class="q-aia__quote-warn">{{ t('nicht wörtlich gefunden') }}</span>
              </p>
              <p v-if="c.reason" class="q-aia__reason">{{ c.reason }}</p>
            </div>
          </details>
        </li>
      </ul>

      <p v-if="differenceCount === 0" class="q-aia__same">
        {{ t('Deine Einschätzung und die KI stimmen überein.') }}
      </p>

      <p class="q-aia__foot">
        {{ t('Bitte selbst bestätigen.') }}
        <span v-if="model && source !== 'pool'" class="q-aia__model">{{ model }}</span>
      </p>
    </template>
    <p v-if="storageWarning" class="q-aia__storage" role="status">{{ storageWarning }}</p>
  </section>
</template>

<style scoped>
.q-aia {
  margin-top: 12px;
}

.q-aia__ask {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--q-border-2);
  border-radius: 10px;
  background: var(--q-card);
  color: var(--q-ink);
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  transition: border-color var(--q-transition-fast), background var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .q-aia__ask:hover {
    border-color: var(--q-accent);
    background: var(--q-accent-bg);
  }
}
.q-aia__ask:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}

.q-aia__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.q-aia__head-text {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--q-mut-2);
}
.q-aia__summary {
  margin-left: auto;
  font-size: 12px;
  color: var(--q-ink);
}

.q-aia__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.q-aia__item {
  display: block;
  padding: 9px 11px 8px;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-card);
}
/* Low confidence, or a positive the model could not evidence — the two cases
 * a human most needs to look at. */
.q-aia__item--shaky {
  border-style: dashed;
  border-color: var(--q-part-border);
  background: var(--q-part-bg);
}
.q-aia__item-main {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.q-aia__criterion {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-ink);
  overflow-wrap: anywhere;
  flex: 1;
}
.q-aia__evidence {
  margin: 5px 0 0 25px;
  color: var(--q-faint);
}
.q-aia__evidence summary {
  width: max-content;
  max-width: 100%;
  cursor: pointer;
  font-size: 11px;
  font-weight: 650;
  list-style-position: outside;
}
.q-aia__evidence-body {
  padding: 2px 0 2px 1px;
}
.q-aia__quote {
  margin: 4px 0 0;
  font: 500 11.5px/1.5 ui-monospace, Menlo, monospace;
  color: var(--q-mut);
  overflow-wrap: anywhere;
}
.q-aia__quote--unverified {
  color: var(--q-err-ink);
}
.q-aia__quote-warn {
  display: inline-block;
  margin-left: 6px;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--q-err);
}
.q-aia__reason {
  margin: 4px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--q-faint);
}
.q-aia__confidence {
  margin-left: auto;
  flex: none;
  font: 700 10.5px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--q-faint);
}

/* Single-verdict variant sits alone, so it needs its own bottom gap. */
.q-aia__overall {
  margin-bottom: 0;
}
.q-aia__same {
  margin: 0;
  color: var(--q-ok-ink);
  font-size: 12.5px;
  font-weight: 650;
}

.q-aia__loading {
  padding: 2px 0;
}

.q-aia__error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid var(--q-err-border);
  background: var(--q-err-bg);
  border-radius: 9px;
}
.q-aia__error-text {
  margin: 0;
  font-size: 12px;
  color: var(--q-err-ink);
}
.q-aia__billing-note,
.q-aia__storage {
  margin: 0;
  color: var(--q-warn-ink, var(--q-mut));
  font-size: 11.5px;
  line-height: 1.45;
}
.q-aia__storage {
  margin-top: 8px;
}
.q-aia__foot {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--q-faint);
}
.q-aia__model {
  display: block;
  margin-top: 2px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10px;
  color: var(--q-hint);
}
</style>
