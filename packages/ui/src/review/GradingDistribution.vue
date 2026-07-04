<script setup lang="ts">
/**
 * Distribution of mastery grading states (supplement §5): one stacked bar
 * (proportional segment widths) + a legend grid with GradingDot, German
 * label and count per state. Reused by Fortschritt and the dashboard.
 *
 * Segment colors: good = ok green; the three orange states are opacity
 * steps of var(--q-part) (careless 1 / meh .7 / baffled .45) on solid
 * rects — shape order + legend carry the meaning, never color alone;
 * excluded = neutral grey; unseen = track (bar background).
 */
import { computed } from 'vue';
import type { Grading, GradingOrUnseen } from '@qed2/core-logic';
import GradingDot, { GRADING_LABELS } from '../shared/GradingDot.vue';

const props = defineProps<{
  counts: Record<Grading, number>;
  /** Unseen-part count — row + segment rendered only when provided. */
  unseen?: number;
}>();

const ORDER: readonly Grading[] = ['good', 'careless', 'meh', 'baffled', 'excluded'];

interface Row {
  state: GradingOrUnseen;
  label: string;
  count: number;
}

const rows = computed<Row[]>(() => {
  const out: Row[] = ORDER.map((state) => ({
    state,
    label: GRADING_LABELS[state],
    count: props.counts[state] ?? 0,
  }));
  if (props.unseen !== undefined) {
    out.push({ state: 'unseen', label: GRADING_LABELS.unseen, count: props.unseen });
  }
  return out;
});

const total = computed(() => rows.value.reduce((sum, r) => sum + r.count, 0));

/** Non-zero segments in state order; empty when total is 0 (full track bar). */
const segments = computed(() =>
  total.value === 0
    ? []
    : rows.value
        .filter((r) => r.count > 0)
        .map((r) => ({ state: r.state, width: (r.count / total.value) * 100 })),
);
</script>

<template>
  <div class="q-dist">
    <div class="q-dist__bar" :class="{ 'q-dist__bar--empty': total === 0 }" aria-hidden="true">
      <div
        v-for="seg in segments"
        :key="seg.state"
        class="q-dist__seg"
        :class="`q-dist__seg--${seg.state}`"
        :style="{ width: `${seg.width}%` }"
      />
    </div>
    <ul class="q-dist__legend">
      <li v-for="row in rows" :key="row.state" class="q-dist__item">
        <GradingDot :grading="row.state" :size="12" />
        <span class="q-dist__label">{{ row.label }}</span>
        <span class="q-dist__count">{{ row.count }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.q-dist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.q-dist__bar {
  display: flex;
  height: 10px;
  border-radius: 5px;
  overflow: hidden;
  background: var(--q-track);
}
.q-dist__seg {
  height: 100%;
  flex: none;
}
.q-dist__seg--good {
  background: var(--q-ok);
}
.q-dist__seg--careless {
  background: var(--q-part);
  opacity: 1;
}
.q-dist__seg--meh {
  background: var(--q-part);
  opacity: 0.7;
}
.q-dist__seg--baffled {
  background: var(--q-part);
  opacity: 0.45;
}
.q-dist__seg--excluded {
  background: var(--q-neutral);
}
.q-dist__seg--unseen {
  background: var(--q-track);
}
.q-dist__legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 6px 16px;
}
.q-dist__item {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.q-dist__label {
  font-size: 12px;
  color: var(--q-mut);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-dist__count {
  margin-left: auto;
  font-size: 12px;
  font-weight: 700;
  color: var(--q-ink-2);
  font-variant-numeric: tabular-nums;
}
</style>
