<script setup lang="ts">
/**
 * "Warum?" — the AI explanation of a wrong answer, inside the solution drawer.
 *
 * Three deliberate choices:
 *
 *  - It does NOTHING until asked. The request costs real money, and an answer
 *    the user did not want is worse than no answer, so the panel starts as a
 *    single button.
 *  - It is visibly not the official solution. The official Lösungsweg is
 *    authoritative; this is a machine's reading of YOUR answer, and the two
 *    must never blur together on the same screen.
 *  - It renders Markdown AND KaTeX. The model is asked for formulas in `$…$`,
 *    and an explanation that says "also ist $x = 4$" with the dollars showing
 *    would be worse than no explanation at all.
 */
import { computed } from 'vue';
import AiBadge from '../shared/AiBadge.vue';
import MarkdownView from '../shared/MarkdownView.vue';
import QSkeleton from '../shared/QSkeleton.vue';

const props = defineProps<{
  /** Rendered explanation, once there is one. */
  markdown?: string | undefined;
  loading?: boolean;
  /** Human-readable failure; the panel stays usable and offers a retry. */
  error?: string | undefined;
  /** Shown as provenance once an answer exists. */
  model?: string | undefined;
  /** 'byo' | 'pool' — whose key paid for it. */
  source?: string | undefined;
  /** The idle row's label; the panel serves more than one kind of question. */
  offerLabel?: string;
  /** Heading once there is an answer. */
  titleLabel?: string;
}>();

const emit = defineEmits<{ ask: []; dismiss: [] }>();

const hasAnswer = computed(() => Boolean(props.markdown?.trim()));
const idle = computed(() => !hasAnswer.value && !props.loading && !props.error);
</script>

<template>
  <section class="q-aix" :class="{ 'q-aix--idle': idle }" aria-labelledby="q-aix-title">
    <!--
      Idle is deliberately NOT a section. A heading with a divider above it and
      nothing underneath reads as content that failed to load — the shape
      promises something the user has not asked for yet. So until they do, this
      is one quiet row that offers, and nothing else.
    -->
    <button v-if="idle" type="button" class="q-aix__offer" @click="emit('ask')">
      <span class="q-aix__offer-label">{{ offerLabel ?? 'Warum?' }}</span>
      <AiBadge size="md" class="q-aix__badge" />
    </button>

    <template v-else>
    <div class="q-aix__head">
      <h4 id="q-aix-title" class="q-aix__title">{{ titleLabel ?? 'Erklärung' }}</h4>
      <AiBadge class="q-aix__badge" />
      <button
        v-if="hasAnswer || error"
        type="button"
        class="q-aix__dismiss"
        aria-label="Erklärung ausblenden"
        @click="emit('dismiss')"
      >
        ✕
      </button>
    </div>

    <div v-if="loading" class="q-aix__loading">
      <!-- Rows shaped like the prose that replaces them, so nothing jumps. -->
      <QSkeleton :rows="3" height="16px" radius="6px" gap="9px" label="Erklärung wird erzeugt …" />
      <span class="q-aix__loading-label">Die KI liest deine Antwort …</span>
    </div>

    <div v-else-if="error" class="q-aix__error" role="alert">
      <p class="q-aix__error-text">{{ error }}</p>
      <button type="button" class="q-aix__ask q-aix__ask--retry" @click="emit('ask')">
        Nochmal versuchen
      </button>
    </div>

    <template v-else>
      <div class="q-aix__body q-reveal">
        <MarkdownView :source="markdown ?? ''" />
      </div>
      <!--
        Provenance and a warning, permanently attached to the text. The
        official solution above is checked; this is not, and the reader has to
        be able to tell at a glance which is which.
      -->
      <p class="q-aix__foot">
        Generiert von KI — kann Fehler enthalten. Maßgeblich ist der offizielle Lösungsweg.
        <!--
          Provenance only when the reader chose it. On the shared key the
          server picks the model, so naming it tells the user nothing they
          decided and leaks a deployment detail into a study aid.
        -->
        <span v-if="model && source !== 'pool'" class="q-aix__model">{{ model }}</span>
      </p>
    </template>
    </template>
  </section>
</template>

<style scoped>
.q-aix {
  margin-top: 4px;
  padding-top: 14px;
  border-top: 1px solid var(--q-border-2);
}
/* No rule, no heading, no reserved space until there is something to show. */
.q-aix--idle {
  padding-top: 10px;
  border-top: none;
}

/*
 * The offer. Full width so it reads as a row you can tap rather than a button
 * stranded in white space, and quiet enough that it never competes with the
 * official solution above it.
 */
.q-aix__offer {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: 1px dashed var(--q-border-2);
  border-radius: 11px;
  background: transparent;
  color: var(--q-ink);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--q-transition-fast), background var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .q-aix__offer:hover {
    border-style: solid;
    border-color: var(--q-accent);
    background: var(--q-accent-bg);
  }
}
.q-aix__offer:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.q-aix__offer-label {
  font-size: 13.5px;
  font-weight: 700;
  flex: none;
}
.q-aix__offer .q-aix__badge {
  margin-left: auto;
}

.q-aix__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.q-aix__title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--q-ink);
}
/* Appearance lives in AiBadge — identical here and in the assessment panel.
 * This class only positions it. */
.q-aix__dismiss {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--q-faint);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}
@media (hover: hover) and (pointer: fine) {
  .q-aix__dismiss:hover {
    color: var(--q-ink);
    background: var(--q-panel);
  }
}

.q-aix__ask {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--q-border-2);
  border-radius: 10px;
  background: var(--q-card);
  color: var(--q-ink);
  font: 700 13px 'Public Sans', system-ui, sans-serif;
  cursor: pointer;
  transition: border-color var(--q-transition-fast), background var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .q-aix__ask:hover {
    border-color: var(--q-accent);
    background: var(--q-accent-bg);
  }
}
.q-aix__ask:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.q-aix__ask--retry {
  min-height: 38px;
  font-size: 12.5px;
}

.q-aix__loading {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-aix__loading-label {
  font-size: 11.5px;
  color: var(--q-faint);
}

.q-aix__error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--q-err-border);
  background: var(--q-err-bg);
  border-radius: 9px;
}
.q-aix__error-text {
  margin: 0;
  font-size: 12.5px;
  color: var(--q-err-ink);
}

.q-aix__body {
  font-size: 14px;
  line-height: 1.65;
  color: var(--q-ink-2);
}
/* A long derivation scrolls inside the panel instead of widening the drawer. */
.q-aix__body :deep(.q-md__mathblock) {
  max-width: 100%;
}
.q-aix__body :deep(p:first-child) {
  margin-top: 0;
}
.q-aix__body :deep(p:last-child) {
  margin-bottom: 0;
}

.q-aix__foot {
  margin: 12px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--q-faint);
}
.q-aix__model {
  display: block;
  margin-top: 2px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10.5px;
  color: var(--q-hint);
}
</style>
