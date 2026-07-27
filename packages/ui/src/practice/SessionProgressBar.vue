<script setup lang="ts">
/**
 * Session progress as one segment per item rather than a single sweep.
 *
 * A percentage bar only answers "how far along the list am I", which stops
 * being true the moment someone skips ahead (the session rail lets them):
 * the bar reads 80 % while half the parts are still open. Segments show what
 * actually happened — green answered right, red wrong, amber partial, empty
 * still open — so a skipped part stays visibly unfinished.
 */
import { computed } from 'vue';

export type ProgressSegment = 'correct' | 'partial' | 'incorrect' | 'current' | 'open';

const props = defineProps<{
  items: readonly { partId: string }[];
  graded: readonly { partId: string; verdict: 'correct' | 'partial' | 'incorrect' }[];
  currentIndex: number;
  /** False while loading/idle/summary — nothing is "where you are" then. */
  active: boolean;
}>();

const verdicts = computed(() => {
  const map = new Map<string, 'correct' | 'partial' | 'incorrect'>();
  for (const record of props.graded) map.set(record.partId, record.verdict);
  return map;
});

const segments = computed<ProgressSegment[]>(() =>
  props.items.map((item, i) => {
    const verdict = verdicts.value.get(item.partId);
    if (verdict) return verdict;
    return props.active && i === props.currentIndex ? 'current' : 'open';
  }),
);

/** Segments get thin fast; drop the separators before they eat the bar. */
const dense = computed(() => props.items.length > 24);

const summary = computed(() => {
  const counts = { correct: 0, partial: 0, incorrect: 0, open: 0 };
  for (const segment of segments.value) {
    if (segment === 'current' || segment === 'open') counts.open += 1;
    else counts[segment] += 1;
  }
  return `${counts.correct} richtig, ${counts.partial} teilweise, ${counts.incorrect} falsch, ${counts.open} offen`;
});
</script>

<template>
  <div
    class="q-sprogress"
    :class="{ 'q-sprogress--dense': dense }"
    role="img"
    :aria-label="segments.length > 0 ? `Fortschritt: ${summary}` : 'Fortschritt'"
  >
    <span
      v-for="(segment, i) in segments"
      :key="i"
      class="q-sprogress__seg"
      :class="`q-sprogress__seg--${segment}`"
    />
  </div>
</template>

<style scoped>
.q-sprogress {
  height: 6px;
  border-radius: 3px;
  background: var(--q-track);
  overflow: hidden;
  display: flex;
  gap: 2px;
}
.q-sprogress--dense {
  gap: 1px;
}

.q-sprogress__seg {
  flex: 1;
  min-width: 0;
  border-radius: 2px;
  /* „open" is the absence of a fill — the track shows through. */
  background: transparent;
  transition: background var(--q-transition-normal);
}
.q-sprogress__seg--correct {
  background: var(--q-ok);
}
.q-sprogress__seg--partial {
  background: var(--q-part);
}
.q-sprogress__seg--incorrect {
  background: var(--q-err);
}
.q-sprogress__seg--current {
  background: var(--q-accent);
}
</style>
