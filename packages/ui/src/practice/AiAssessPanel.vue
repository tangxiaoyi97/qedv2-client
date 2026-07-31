<script setup lang="ts">
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
import { computed } from 'vue';
import StateIcon from '../shared/StateIcon.vue';
import QSkeleton from '../shared/QSkeleton.vue';

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
  /** Server refuses to vouch for this reply — show it, tick nothing. */
  advisoryOnly?: boolean;
  model?: string | undefined;
}>();

const emit = defineEmits<{ ask: [] }>();

const hasResult = computed(() => (props.criteria?.length ?? 0) > 0 || props.overall != null);
const idle = computed(() => !hasResult.value && !props.loading && !props.error);

/** Below this the verdict is shown but never pre-ticked. */
const CONFIDENCE_FLOOR = 0.75;

const shaky = (c: AssessedCriterion): boolean =>
  c.confidence < CONFIDENCE_FLOOR || (c.met && !c.quoteVerified);
</script>

<template>
  <section class="q-aia">
    <button v-if="idle" type="button" class="q-aia__ask" @click="emit('ask')">
      <span class="q-aia__badge">KI</span>
      Vorschlag holen
    </button>

    <div v-else-if="loading" class="q-aia__loading">
      <QSkeleton :rows="labels.length || 2" height="34px" radius="8px" gap="7px" label="KI prüft die Kriterien …" />
    </div>

    <div v-else-if="error" class="q-aia__error" role="alert">
      <p class="q-aia__error-text">{{ error }}</p>
      <button type="button" class="q-aia__retry" @click="emit('ask')">Nochmal versuchen</button>
    </div>

    <template v-else>
      <div class="q-aia__head">
        <span class="q-aia__badge">KI</span>
        <span class="q-aia__head-text">
          {{ advisoryOnly ? 'Nur als Hinweis — bitte selbst entscheiden' : 'Vorschlag — bitte prüfen' }}
        </span>
      </div>

      <!-- allOrNothing / tiered parts: one score, same evidence rules. -->
      <div
        v-if="overall"
        class="q-aia__item q-aia__overall"
        :class="{ 'q-aia__item--shaky': overall.confidence < CONFIDENCE_FLOOR || (overall.points > 0 && !overall.quoteVerified) }"
      >
        <StateIcon :state="overall.points > 0 ? 'correct' : 'incorrect'" :size="16" />
        <div class="q-aia__item-body">
          <p class="q-aia__criterion">
            Vorschlag: {{ overall.points }}<template v-if="maxPoints !== undefined"> / {{ maxPoints }}</template> P
          </p>
          <p v-if="overall.quote" class="q-aia__quote" :class="{ 'q-aia__quote--unverified': !overall.quoteVerified }">
            „{{ overall.quote }}"
            <span v-if="!overall.quoteVerified" class="q-aia__quote-warn">nicht wörtlich gefunden</span>
          </p>
          <p v-if="overall.reason" class="q-aia__reason">{{ overall.reason }}</p>
        </div>
        <span class="q-aia__confidence">{{ Math.round(overall.confidence * 100) }}%</span>
      </div>

      <ul v-else class="q-aia__list">
        <li
          v-for="c in criteria"
          :key="c.index"
          class="q-aia__item"
          :class="{ 'q-aia__item--shaky': shaky(c) }"
        >
          <StateIcon :state="c.met ? 'correct' : 'incorrect'" :size="16" />
          <div class="q-aia__item-body">
            <p class="q-aia__criterion">{{ labels[c.index] ?? `Kriterium ${c.index + 1}` }}</p>
            <!--
              The quote is the whole reason this is checkable. An unverified one
              means the model produced words that are not in the answer, which
              is exactly the failure that would otherwise inflate a grade.
            -->
            <p v-if="c.quote" class="q-aia__quote" :class="{ 'q-aia__quote--unverified': !c.quoteVerified }">
              „{{ c.quote }}"
              <span v-if="!c.quoteVerified" class="q-aia__quote-warn">nicht wörtlich gefunden</span>
            </p>
            <p v-if="c.reason" class="q-aia__reason">{{ c.reason }}</p>
          </div>
          <span class="q-aia__confidence" :title="`Sicherheit ${Math.round(c.confidence * 100)} %`">
            {{ Math.round(c.confidence * 100) }}%
          </span>
        </li>
      </ul>

      <p class="q-aia__foot">
        <template v-if="advisoryOnly">
          Nichts wurde vorausgewählt: die KI konnte nicht alles belegen (oder die Aufgabe enthält eine
          Abbildung, die sie nicht sieht).
        </template>
        <template v-else>
          {{ overall ? 'Die Punkte oben sind vorausgewählt' : 'Die Häkchen oben sind gesetzt' }}, aber
          nicht gespeichert — du bestätigst mit „Bewertung übernehmen".
        </template>
        <span v-if="model" class="q-aia__model">{{ model }}</span>
      </p>
    </template>
  </section>
</template>

<style scoped>
.q-aia {
  margin-top: 12px;
}

.q-aia__badge {
  font: 800 9.5px 'Public Sans', system-ui, sans-serif;
  letter-spacing: 0.1em;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--q-neutral-bg);
  border: 1px solid var(--q-neutral-border);
  color: var(--q-neutral);
  flex: none;
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
  font: 700 12.5px 'Public Sans', system-ui, sans-serif;
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

.q-aia__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.q-aia__item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 11px;
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
.q-aia__item-body {
  flex: 1;
  min-width: 0;
}
.q-aia__criterion {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-ink);
  overflow-wrap: anywhere;
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
  font: 700 9.5px 'Public Sans', system-ui, sans-serif;
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
  flex: none;
  font: 700 10.5px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--q-faint);
}

/* Single-verdict variant sits alone, so it needs its own bottom gap. */
.q-aia__overall {
  margin-bottom: 0;
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
.q-aia__retry {
  border: 1px solid var(--q-err-border);
  border-radius: 8px;
  background: var(--q-card);
  color: var(--q-err-ink);
  font: 700 11.5px 'Public Sans', system-ui, sans-serif;
  padding: 7px 12px;
  cursor: pointer;
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
