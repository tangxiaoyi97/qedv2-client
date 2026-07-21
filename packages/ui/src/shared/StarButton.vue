<script setup lang="ts">
/**
 * Star / bookmark toggle (supplement §2) — independent of grading.
 * ★ filled when starred, ☆ outline otherwise; aria-pressed carries the
 * state (never color-only: the glyph itself changes).
 */
import { computed } from 'vue';

const props = defineProps<{
  starred: boolean;
  size?: number;
}>();

defineEmits<{ toggle: [] }>();

const title = computed(() => (props.starred ? 'Gemerkt' : 'Merken'));
</script>

<template>
  <button
    type="button"
    class="q-star-btn"
    :class="{ 'q-star-btn--on': starred }"
    :aria-pressed="starred ? 'true' : 'false'"
    :aria-label="title"
    :title="title"
    :style="{ fontSize: `${size ?? 20}px` }"
    @click="$emit('toggle')"
  >
    <span class="q-star-btn__glyph" aria-hidden="true">{{ starred ? '★' : '☆' }}</span>
  </button>
</template>

<style scoped>
.q-star-btn {
  display: inline-grid;
  place-items: center;
  padding: 4px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  color: var(--q-mut-2);
  line-height: 1;
  transition: color 0.12s ease;
}
.q-star-btn--on {
  color: var(--q-part);
}
@media (hover: hover) and (pointer: fine) {
  .q-star-btn:hover {
    color: var(--q-part);
  }
}
.q-star-btn:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
@media (pointer: coarse) {
  /* ~44px hit area; negative margin keeps the visual footprint */
  .q-star-btn {
    padding: 12px;
    margin: -8px;
  }
}
.q-star-btn__glyph {
  /* ★ and ☆ have different glyph widths — fix the slot so toggling never
   * nudges neighbouring layout */
  display: inline-block;
  width: 1em;
  text-align: center;
  transition: transform 0.08s ease;
}
.q-star-btn:active .q-star-btn__glyph {
  transform: scale(0.9);
}
</style>
