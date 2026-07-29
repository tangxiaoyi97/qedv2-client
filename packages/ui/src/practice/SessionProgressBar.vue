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

/**
 * Two or more of the same verdict in a row are drawn as one block instead of
 * separate ticks that happen to share a colour — a streak is a thing the user
 * did, and the bar should say so at a glance.
 *
 * Only a settled verdict chains, and only „richtig" or „falsch": „teilweise"
 * is the outcome that is neither, and an open run is not an achievement.
 */
const STREAKABLE: readonly ProgressSegment[] = ['correct', 'incorrect'];

type RunPosition = 'start' | 'mid' | 'end';

const runs = computed<(RunPosition | undefined)[]>(() => {
  const list = segments.value;
  const positions: (RunPosition | undefined)[] = list.map(() => undefined);
  for (let start = 0; start < list.length; ) {
    const value = list[start]!;
    let end = start + 1;
    while (end < list.length && list[end] === value) end += 1;
    if (end - start >= 2 && STREAKABLE.includes(value)) {
      positions[start] = 'start';
      for (let i = start + 1; i < end - 1; i += 1) positions[i] = 'mid';
      positions[end - 1] = 'end';
    }
    start = end;
  }
  return positions;
});

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
      :class="[`q-sprogress__seg--${segment}`, runs[i] ? `q-sprogress__seg--run-${runs[i]}` : '']"
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
  /* A custom property, not a literal, because the run modifiers below have to
   * cancel exactly this much to close a seam. */
  --q-sprogress-gap: 2px;
  gap: var(--q-sprogress-gap);
}
.q-sprogress--dense {
  --q-sprogress-gap: 1px;
}

.q-sprogress__seg {
  flex: 1;
  min-width: 0;
  border-radius: 2px;
  /* „open" is the absence of a fill — the track shows through. */
  background: transparent;
  /* The radius and the seam are part of the reveal: a streak closing up as
   * the answer lands should ease, not snap. */
  transition: background var(--q-transition-normal), border-radius var(--q-transition-normal),
    margin-left var(--q-transition-normal);
}

/* A streak is drawn as one block. Segments keep their own widths — the bar
 * stays a per-item map — but the seams inside the run close. */
.q-sprogress__seg--run-start {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.q-sprogress__seg--run-mid {
  border-radius: 0;
}
.q-sprogress__seg--run-end {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.q-sprogress__seg--run-mid,
.q-sprogress__seg--run-end {
  /* Pull left by exactly the flex gap. Only the seams inside a run close; the
   * gap to whatever sits either side of the run is untouched. */
  margin-left: calc(-1 * var(--q-sprogress-gap));
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
