<script setup lang="ts">
/**
 * GitHub-style activity heatmap (Fortschritt + dashboard). Feed comes from
 * HistoryLog.dailyActivity — keys are LOCAL dates 'YYYY-MM-DD'.
 *
 * Grid: columns = weeks (default 26), rows = Mon..Sun (de-AT convention,
 * Monday on top). Intensity = accent overlay with fill-opacity buckets over a
 * track-colored base rect, so both themes ride on the same two tokens.
 */
import { computed, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  /** Answer events per LOCAL day, keys 'YYYY-MM-DD'. */
  data: Record<string, number>;
  /** Number of week columns (default 26). */
  weeks?: number;
  /** Last day shown, LOCAL 'YYYY-MM-DD' (default: today). */
  endDate?: string;
  /** Selected LOCAL day key. */
  selectedDate?: string | null;
}>();

const emit = defineEmits<{ select: [date: string] }>();

const CELL = 11;
const GAP = 2;
const PITCH = CELL + GAP;
const LEFT = 26; // weekday-label gutter
const TOP = 14; // month-label band

/** de-AT short month names (Jänner!). */
const MONTHS = [
  'Jän.',
  'Feb.',
  'März',
  'Apr.',
  'Mai',
  'Juni',
  'Juli',
  'Aug.',
  'Sep.',
  'Okt.',
  'Nov.',
  'Dez.',
];

const WEEKDAY_LABELS: ReadonlyArray<{ row: number; text: string }> = [
  { row: 0, text: 'Mo' },
  { row: 2, text: 'Mi' },
  { row: 4, text: 'Fr' },
];

/** Legend / cell buckets: 0, 1, 2–3, 4–6, 7+. */
function bucketOf(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/** 0 = Monday … 6 = Sunday. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

const weekCount = computed(() => props.weeks ?? 26);

const endDay = computed(() => {
  if (props.endDate) return parseLocalDate(props.endDate);
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
});

interface HeatCell {
  key: string;
  row: number;
  count: number;
  bucket: number;
  title: string;
}

interface HeatColumn {
  x: number;
  month: number;
  cells: HeatCell[];
}

const columns = computed<HeatColumn[]>(() => {
  const end = endDay.value;
  const weeks = weekCount.value;
  const endDow = mondayIndex(end);
  const cols: HeatColumn[] = [];
  for (let w = 0; w < weeks; w++) {
    const monday = new Date(
      end.getFullYear(),
      end.getMonth(),
      end.getDate() - endDow - (weeks - 1 - w) * 7,
    );
    const cells: HeatCell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + r);
      if (date.getTime() > end.getTime()) break;
      const count = props.data[keyOf(date)] ?? 0;
      cells.push({
        key: keyOf(date),
        row: r,
        count,
        bucket: bucketOf(count),
        title: `${count === 1 ? '1 Aufgabe' : `${count} Aufgaben`} · ${formatDate(date)}`,
      });
    }
    cols.push({ x: LEFT + w * PITCH, month: monday.getMonth(), cells });
  }
  return cols;
});

/**
 * Month label at each month's first column. The very first column is only
 * labelled when the next month change is far enough away not to overlap.
 */
const monthLabels = computed(() => {
  const cols = columns.value;
  const out: Array<{ x: number; text: string }> = [];
  const changes: number[] = [];
  for (let i = 1; i < cols.length; i++) {
    if (cols[i]!.month !== cols[i - 1]!.month) changes.push(i);
  }
  if (cols.length > 0 && !changes.some((c) => c <= 2)) {
    out.push({ x: cols[0]!.x, text: MONTHS[cols[0]!.month]! });
  }
  for (const c of changes) out.push({ x: cols[c]!.x, text: MONTHS[cols[c]!.month]! });
  return out;
});

const svgWidth = computed(() => LEFT + weekCount.value * PITCH - GAP);
const svgHeight = TOP + 7 * PITCH - GAP;

/** Scroll container — keep the most recent weeks (right end) in view. */
const scrollEl = ref<HTMLDivElement | null>(null);

function scrollToEnd(): void {
  const el = scrollEl.value;
  if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
}

onMounted(scrollToEnd);
watch(() => [props.data, props.weeks, props.endDate], scrollToEnd, { flush: 'post' });
</script>

<template>
  <div class="q-heat">
    <div ref="scrollEl" class="q-heat__scroll">
      <svg
        class="q-heat__svg"
        :width="svgWidth"
        :height="svgHeight"
        :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
        role="img"
        :aria-label="`Aktivität der letzten ${weekCount} Wochen`"
      >
        <text
          v-for="m in monthLabels"
          :key="`m${m.x}`"
          class="q-heat__month"
          :x="m.x"
          :y="9"
        >
          {{ m.text }}
        </text>
        <text
          v-for="d in WEEKDAY_LABELS"
          :key="d.text"
          class="q-heat__weekday"
          :x="0"
          :y="TOP + d.row * PITCH + 9"
        >
          {{ d.text }}
        </text>
        <template v-for="col in columns" :key="col.x">
          <g
            v-for="cell in col.cells"
            :key="cell.key"
            class="q-heat__cell"
            :class="`q-heat__cell--b${cell.bucket}`"
            role="button"
            tabindex="0"
            :aria-label="cell.title"
            @click="emit('select', cell.key)"
            @keydown.enter.prevent="emit('select', cell.key)"
            @keydown.space.prevent="emit('select', cell.key)"
          >
            <title>{{ cell.title }}</title>
            <rect
              class="q-heat__base"
              :x="col.x"
              :y="TOP + cell.row * PITCH"
              :width="CELL"
              :height="CELL"
              rx="2"
            />
            <rect
              v-if="cell.bucket > 0"
              class="q-heat__fill"
              :class="`q-heat__fill--b${cell.bucket}`"
              :x="col.x"
              :y="TOP + cell.row * PITCH"
              :width="CELL"
              :height="CELL"
              rx="2"
            />
          </g>
        </template>
      </svg>
    </div>
    <div class="q-heat__legend" aria-hidden="true">
      <span class="q-heat__legend-text">Weniger</span>
      <svg
        v-for="b in 5"
        :key="`l${b}`"
        class="q-heat__swatch"
        :width="CELL"
        :height="CELL"
        :viewBox="`0 0 ${CELL} ${CELL}`"
      >
        <rect class="q-heat__base" x="0" y="0" :width="CELL" :height="CELL" rx="2" />
        <rect
          v-if="b > 1"
          class="q-heat__fill"
          :class="`q-heat__fill--b${b - 1}`"
          x="0"
          y="0"
          :width="CELL"
          :height="CELL"
          rx="2"
        />
      </svg>
      <span class="q-heat__legend-text">Mehr</span>
    </div>
  </div>
</template>

<style scoped>
.q-heat {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.q-heat__scroll {
  overflow-x: auto;
  max-width: 100%;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;
}
.q-heat__svg {
  display: block;
}
.q-heat__month,
.q-heat__weekday {
  font-size: 9px;
  font-weight: 600;
  fill: var(--q-faint);
}
.q-heat__base {
  fill: var(--q-track);
}
.q-heat__cell {
  cursor: pointer;
}
.q-heat__cell:focus {
  outline: none;
}
.q-heat__fill {
  fill: var(--q-accent);
}
.q-heat__fill--b1 {
  fill-opacity: 0.3;
}
.q-heat__fill--b2 {
  fill-opacity: 0.55;
}
.q-heat__fill--b3 {
  fill-opacity: 0.8;
}
.q-heat__fill--b4 {
  fill-opacity: 1;
}
.q-heat__legend {
  display: flex;
  align-items: center;
  gap: 3px;
  justify-content: flex-end;
}
.q-heat__legend-text {
  font-size: 10.5px;
  color: var(--q-faint);
}
.q-heat__legend-text:first-child {
  margin-right: 3px;
}
.q-heat__legend-text:last-child {
  margin-left: 3px;
}
.q-heat__swatch {
  display: block;
  flex: none;
}
</style>
