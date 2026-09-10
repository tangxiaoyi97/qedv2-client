<script setup lang="ts">
/**
 * KaTeX rendering of a single math source string.
 * Errors never throw into the app — fall back to monospace source with a
 * tooltip so a bad formula still shows something readable.
 */
import { computed } from 'vue';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useI18n } from '../i18n.js';

const { t } = useI18n();

const props = defineProps<{
  /** KaTeX source (the `v` of a {t:"math"} node). */
  src: string;
  /** Render as display (block, centered) math. */
  display?: boolean;
}>();

const rendered = computed(() => {
  try {
    return {
      ok: true,
      html: katex.renderToString(props.src, {
        displayMode: props.display === true,
        throwOnError: true,
        strict: 'ignore',
        output: 'htmlAndMathml',
      }),
    };
  } catch {
    return { ok: false, html: '' };
  }
});
</script>

<template>
  <span v-if="rendered.ok" class="q-math" :class="{ 'q-math--display': display }" v-html="rendered.html" />
  <code v-else class="q-math-fallback" :title="t('Formel konnte nicht angezeigt werden')">{{ src }}</code>
</template>

<style scoped>
.q-math {
  /* Constrain the formula, not its surrounding sentence or answer card.
   * Inline-block lets KaTeX line breaks determine the full natural height;
   * an unbreakable matrix/fraction can still pan horizontally on a phone. */
  display: inline-block;
  box-sizing: border-box;
  max-width: 100%;
  vertical-align: middle;
  overflow-x: auto;
  overflow-y: hidden;
  /* KaTeX's italic overhang and deep fraction/sum struts extend slightly
   * outside their line box. Keep those ink edges inside the scrollport. */
  padding: 0.15em 0.15em 0.45em;
}
.q-math--display {
  display: block;
  text-align: center;
  overflow-x: auto;
  overflow-y: hidden;
}
.q-math-fallback {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 0.9em;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 5px;
  padding: 1px 5px;
}
</style>
