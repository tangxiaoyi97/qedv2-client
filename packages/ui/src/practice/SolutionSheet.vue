<script setup lang="ts">
/**
 * Official-solution drawer that expands UPWARD from the practice bottom bar
 * (user feedback #2): a max-height transition container composed into the
 * sticky footer ABOVE the nav row. This file is only the expanding body —
 * the parent bottom bar renders the "Lösung" toggle button.
 *
 * Controlled component: the parent owns `open`; Escape asks the parent to
 * close via update:open.
 */
import { computed } from 'vue';
import type { SolutionEntry, ImageFigure } from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';
import { useAssetResolver } from '../shared/assets.js';

const props = defineProps<{
  solution: SolutionEntry[] | undefined;
  open: boolean;
  /** Constrain the inner content column (e.g. '860px') so the sheet aligns
   *  with the page's content width instead of spanning the whole viewport. */
  contentMaxWidth?: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const resolveAsset = useAssetResolver();

const entries = computed(() => props.solution ?? []);

function imageFigures(entry: SolutionEntry): ImageFigure[] {
  return (entry.figures ?? []).filter((f): f is ImageFigure => f.kind === 'image');
}
</script>

<template>
  <section
    class="q-ssheet"
    :class="{ 'q-ssheet--open': open }"
    :aria-hidden="!open"
    :tabindex="open ? 0 : -1"
    aria-label="Offizieller Lösungsweg"
    @keydown.esc="emit('update:open', false)"
  >
    <div class="q-ssheet__inner" :style="contentMaxWidth ? { maxWidth: contentMaxWidth, margin: '0 auto' } : undefined">
      <div class="q-ssheet__head">
        <span class="q-ssheet__tick" aria-hidden="true"></span>
        <h3 class="q-ssheet__title">Offizieller Lösungsweg</h3>
      </div>
      <p v-if="entries.length === 0" class="q-ssheet__empty">
        Keine offizielle Lösung verfügbar.
      </p>
      <template v-else>
        <template v-for="(entry, i) in entries" :key="i">
          <div v-if="i > 0" class="q-ssheet__divider" role="separator">
            <span class="q-ssheet__divider-label">Alternative</span>
          </div>
          <div class="q-ssheet__entry">
            <div class="q-ssheet__card">
              <RichTextView class="q-ssheet__result" :nodes="entry.result" />
            </div>
            <figure v-for="(fig, fi) in imageFigures(entry)" :key="fi" class="q-ssheet__figure">
              <img
                class="q-ssheet__img"
                :src="resolveAsset(fig.src)"
                :alt="fig.alt ?? ''"
                loading="lazy"
              />
            </figure>
            <div v-if="entry.note" class="q-ssheet__note">
              <span class="q-ssheet__note-label">Beurteilungshinweis</span>
              <span class="q-ssheet__note-text">{{ entry.note }}</span>
            </div>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.q-ssheet {
  max-height: 0;
  overflow-y: auto;
  transition: max-height 0.3s ease;
  border-bottom: 1px solid transparent;
  background: var(--q-card);
  outline: none;
}
.q-ssheet--open {
  max-height: min(55vh, 420px);
  border-bottom: 1px solid var(--q-border);
}
.q-ssheet__inner {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}
.q-ssheet__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.q-ssheet__tick {
  width: 4px;
  height: 15px;
  border-radius: 2px;
  background: var(--q-accent);
  flex: none;
}
.q-ssheet__title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--q-ink);
}
.q-ssheet__empty {
  margin: 0;
  font-size: 13px;
  color: var(--q-faint);
}
.q-ssheet__entry {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.q-ssheet__card {
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--q-ink-2);
}
.q-ssheet__result {
  overflow-wrap: break-word;
}
.q-ssheet__divider {
  display: flex;
  align-items: center;
  gap: 10px;
}
.q-ssheet__divider::before,
.q-ssheet__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--q-border-2);
}
.q-ssheet__divider-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.q-ssheet__figure {
  margin: 0;
}
.q-ssheet__img {
  max-width: 100%;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  display: block;
  margin: 0 auto;
  background: #fff;
}
.q-ssheet__note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 13px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
}
.q-ssheet__note-label {
  font: 700 11px ui-monospace, Menlo, monospace;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.q-ssheet__note-text {
  font: 500 12px/1.6 ui-monospace, Menlo, monospace;
  color: var(--q-mut);
  overflow-wrap: break-word;
}
</style>
