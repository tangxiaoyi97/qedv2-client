<script setup lang="ts">
/**
 * Distribution of mastery grading states (supplement §5): one compact donut
 * chart + clickable legend with GradingDot, German label and count per state.
 * Reused by Fortschritt and the dashboard.
 *
 * Segment colors: good = ok green; the three orange states are opacity
 * steps of var(--q-part) (careless 1 / meh .7 / baffled .45) on solid
 * rects — shape order + legend carry the meaning, never color alone;
 * excluded = neutral grey; unseen = track (bar background).
 */
import { computed, ref } from 'vue';
import type { Grading, GradingOrUnseen } from '@qed2/core-logic';
import GradingDot, { GRADING_LABELS } from '../shared/GradingDot.vue';

const props = defineProps<{
  counts: Record<Grading, number>;
  /** Unseen-part count — row + segment rendered only when provided. */
  unseen?: number;
  size?: 'compact' | 'large';
}>();

const emit = defineEmits<{ select: [state: GradingOrUnseen] }>();

const ORDER: readonly Grading[] = ['good', 'careless', 'meh', 'baffled', 'excluded'];
const RADIUS = 36;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const activeState = ref<GradingOrUnseen | null>(null);

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

/** Non-zero segments in state order; empty when total is 0 (track only). */
const segments = computed(() => {
  if (total.value === 0) return [];
  let offset = 0;
  return rows.value
    .filter((r) => r.count > 0)
    .map((r) => {
      const length = (r.count / total.value) * CIRCUMFERENCE;
      const seg = {
        state: r.state,
        count: r.count,
        dash: `${length} ${CIRCUMFERENCE - length}`,
        offset: -offset,
      };
      offset += length;
      return seg;
    });
});

function setActiveState(state: GradingOrUnseen): void {
  activeState.value = state;
}

function clearActiveState(state: GradingOrUnseen): void {
  if (activeState.value === state) activeState.value = null;
}
</script>

<template>
  <div
    class="q-dist"
    :class="{
      'q-dist--large': props.size === 'large',
      'q-dist--has-active': activeState !== null,
    }"
  >
    <div class="q-dist__chart-wrap">
      <svg class="q-dist__chart" viewBox="0 0 100 100" role="img" aria-label="Beherrschung nach Status">
        <circle class="q-dist__track" cx="50" cy="50" :r="RADIUS" />
        <circle
          v-for="seg in segments"
          :key="seg.state"
          class="q-dist__seg"
          :class="[
            `q-dist__seg--${seg.state}`,
            {
              'q-dist__seg--active': activeState === seg.state,
              'q-dist__seg--dimmed': activeState !== null && activeState !== seg.state,
            },
          ]"
          cx="50"
          cy="50"
          :r="RADIUS"
          :stroke-dasharray="seg.dash"
          :stroke-dashoffset="seg.offset"
          tabindex="0"
          role="button"
          :aria-label="`${rows.find((r) => r.state === seg.state)?.label}: ${seg.count}`"
          @pointerenter="setActiveState(seg.state)"
          @pointerleave="clearActiveState(seg.state)"
          @mouseenter="setActiveState(seg.state)"
          @mouseleave="clearActiveState(seg.state)"
          @focus="setActiveState(seg.state)"
          @blur="clearActiveState(seg.state)"
          @click.stop="emit('select', seg.state)"
          @keydown.enter.prevent="emit('select', seg.state)"
          @keydown.space.prevent="emit('select', seg.state)"
        />
      </svg>
      <div class="q-dist__center">
        <span class="q-dist__total">{{ total }}</span>
        <span class="q-dist__total-label">Teile</span>
      </div>
    </div>
    <ul class="q-dist__legend">
      <li v-for="row in rows" :key="row.state" class="q-dist__item">
        <button
          type="button"
          class="q-dist__item-button"
          :class="{
            'q-dist__item-button--active': activeState === row.state,
            'q-dist__item-button--dimmed': activeState !== null && activeState !== row.state,
          }"
          :disabled="row.count === 0"
          @pointerenter="setActiveState(row.state)"
          @pointerleave="clearActiveState(row.state)"
          @mouseenter="setActiveState(row.state)"
          @mouseleave="clearActiveState(row.state)"
          @focus="setActiveState(row.state)"
          @blur="clearActiveState(row.state)"
          @click.stop="emit('select', row.state)"
        >
          <GradingDot :grading="row.state" :size="12" />
          <span class="q-dist__label">{{ row.label }}</span>
          <span class="q-dist__count">{{ row.count }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.q-dist {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
  min-width: 0;
}
.q-dist__chart-wrap {
  position: relative;
  width: 118px;
  height: 118px;
}
.q-dist__chart {
  display: block;
  width: 118px;
  height: 118px;
}
.q-dist__track,
.q-dist__seg {
  fill: none;
  stroke-width: 17;
  transform: rotate(-90deg);
  transform-origin: 50px 50px;
}
.q-dist__track {
  stroke: var(--q-track);
}
.q-dist__seg {
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.q-dist__seg:hover,
.q-dist__seg:focus-visible {
  outline: none;
}
.q-dist__seg--good {
  stroke: var(--q-ok);
}
.q-dist__seg--careless {
  stroke: var(--q-part);
}
.q-dist__seg--meh {
  stroke: var(--q-part);
  opacity: 0.7;
}
.q-dist__seg--baffled {
  stroke: var(--q-part);
  opacity: 0.45;
}
.q-dist__seg--excluded {
  stroke: var(--q-neutral);
}
.q-dist__seg--unseen {
  stroke: var(--q-btn-border);
}
.q-dist__seg--dimmed {
  opacity: 0.18;
}
.q-dist__seg--active,
.q-dist__seg--active:hover,
.q-dist__seg--active:focus-visible {
  outline: none;
}
.q-dist__center {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  pointer-events: none;
}
.q-dist__total {
  font-size: 22px;
  font-weight: 850;
  line-height: 1;
}
.q-dist__total-label {
  margin-top: 3px;
  font-size: 10px;
  font-weight: 700;
  color: var(--q-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.q-dist__legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.q-dist__item-button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  border: none;
  border-radius: 7px;
  background: none;
  color: inherit;
  font: inherit;
  padding: 5px 6px;
  cursor: pointer;
  text-align: left;
}
@media (pointer: coarse) {
  .q-dist__item-button {
    min-height: 40px;
  }
}
.q-dist__item-button:not(:disabled):hover,
.q-dist__item-button:focus-visible {
  outline: none;
}
.q-dist__item-button--dimmed {
  opacity: 0.42;
}
.q-dist__item-button--active,
.q-dist__item-button--active:not(:disabled):hover,
.q-dist__item-button--active:focus-visible {
  outline: none;
}
.q-dist__item-button--active .q-dist__label,
.q-dist__item-button--active .q-dist__count {
  color: inherit;
  font-weight: inherit;
}
.q-dist__item-button:disabled {
  cursor: default;
  opacity: 0.55;
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
.q-dist--large {
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 20px;
}
.q-dist--large .q-dist__chart-wrap,
.q-dist--large .q-dist__chart {
  width: 180px;
  height: 180px;
}
.q-dist--large .q-dist__track,
.q-dist--large .q-dist__seg {
  stroke-width: 15;
}
.q-dist--large .q-dist__total {
  font-size: 30px;
}
.q-dist--large .q-dist__label,
.q-dist--large .q-dist__count {
  font-size: 13px;
}
@media (max-width: 420px) {
  .q-dist {
    grid-template-columns: 1fr;
  }
  .q-dist__chart-wrap {
    margin: 0 auto;
  }
}
</style>
