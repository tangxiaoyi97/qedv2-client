<script setup lang="ts">
/**
 * Radar (spider) chart for per-Kompetenz mastery — pure SVG, token-themed.
 * Axes are given in order; values are 0..1. Renders grid rings, axis lines,
 * labels and one filled polygon.
 */
import { computed } from 'vue';

export interface RadarAxis {
  label: string;
  /** 0..1 */
  value: number;
  /** Optional secondary line under the label (e.g. "45 %"). */
  hint?: string;
}

const props = defineProps<{
  axes: RadarAxis[];
  size?: number;
}>();

const SIZE = computed(() => props.size ?? 260);
const CX = computed(() => SIZE.value / 2);
const CY = computed(() => SIZE.value / 2);
const R = computed(() => SIZE.value * 0.34);
const RINGS = [0.25, 0.5, 0.75, 1];

function point(index: number, radius: number): { x: number; y: number } {
  const n = Math.max(props.axes.length, 3);
  const angle = (Math.PI * 2 * index) / n - Math.PI / 2; // start at 12 o'clock
  return { x: CX.value + radius * Math.cos(angle), y: CY.value + radius * Math.sin(angle) };
}

function ringPath(fraction: number): string {
  const n = Math.max(props.axes.length, 3);
  return (
    Array.from({ length: n }, (_, i) => {
      const p = point(i, R.value * fraction);
      return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(' ') + ' Z'
  );
}

const valuePath = computed(() => {
  if (props.axes.length < 3) return '';
  return (
    props.axes
      .map((a, i) => {
        const clamped = Math.min(1, Math.max(0, a.value));
        const p = point(i, R.value * clamped);
        return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(' ') + ' Z'
  );
});

const labels = computed(() =>
  props.axes.map((a, i) => {
    const p = point(i, R.value + 26);
    const anchor = Math.abs(p.x - CX.value) < 4 ? 'middle' : p.x > CX.value ? 'start' : 'end';
    return { ...a, x: p.x, y: p.y, anchor, dot: point(i, R.value * Math.min(1, Math.max(0, a.value))) };
  }),
);
</script>

<template>
  <div class="q-radar" role="img" :aria-label="axes.map((a) => `${a.label}: ${Math.round(a.value * 100)} %`).join(', ')">
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="q-radar__svg">
      <path
        v-for="ring in RINGS"
        :key="ring"
        :d="ringPath(ring)"
        fill="none"
        class="q-radar__ring"
      />
      <line
        v-for="(a, i) in axes"
        :key="`ax-${i}`"
        :x1="CX"
        :y1="CY"
        :x2="point(i, R).x"
        :y2="point(i, R).y"
        class="q-radar__axis"
      />
      <path v-if="valuePath" :d="valuePath" class="q-radar__area" />
      <circle
        v-for="(l, i) in labels"
        :key="`pt-${i}`"
        :cx="l.dot.x"
        :cy="l.dot.y"
        r="3.5"
        class="q-radar__point"
      />
      <text
        v-for="(l, i) in labels"
        :key="`lb-${i}`"
        :x="l.x"
        :y="l.y"
        :text-anchor="l.anchor"
        class="q-radar__label"
      >
        {{ l.label }}
        <tspan v-if="l.hint" :x="l.x" dy="13" class="q-radar__hint">{{ l.hint }}</tspan>
      </text>
    </svg>
  </div>
</template>

<style scoped>
.q-radar {
  display: flex;
  justify-content: center;
}
.q-radar__svg {
  width: 100%;
  max-width: 320px;
  height: auto;
}
.q-radar__ring {
  stroke: var(--q-track);
  stroke-width: 1;
}
.q-radar__axis {
  stroke: var(--q-border);
  stroke-width: 1;
}
.q-radar__area {
  fill: var(--q-accent);
  fill-opacity: 0.28;
  stroke: var(--q-accent-strong);
  stroke-width: 2;
  stroke-linejoin: round;
}
.q-radar__point {
  fill: var(--q-accent-strong);
}
.q-radar__label {
  font: 700 12px 'Public Sans', system-ui, sans-serif;
  fill: var(--q-mut);
}
.q-radar__hint {
  font: 600 10.5px 'Public Sans', system-ui, sans-serif;
  fill: var(--q-faint);
}
</style>
