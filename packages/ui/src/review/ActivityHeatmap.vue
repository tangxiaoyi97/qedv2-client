<script setup lang="ts">
/**
 * GitHub-style activity heatmap (Fortschritt + dashboard). Feed comes from
 * HistoryLog.dailyActivity — keys are LOCAL dates 'YYYY-MM-DD'.
 *
 * Grid: columns = weeks (default 26), rows = Mon..Sun (de-AT convention,
 * Monday on top). Intensity = accent overlay with fill-opacity buckets over a
 * track-colored base rect, so both themes ride on the same two tokens.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

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

/* Coarse pointers get bigger cells (18px pitch): 44px per cell is impossible
 * for a density chart, but 18px + title tooltips cuts the mis-tap rate
 * dramatically against the 13px desktop pitch. */
const coarse = ref(false);
let coarseMq: MediaQueryList | undefined;
function syncCoarse(): void {
  coarse.value = coarseMq?.matches ?? false;
}

const CELL = computed(() => (coarse.value ? 15 : 11));
const GAP = computed(() => (coarse.value ? 3 : 2));
const PITCH = computed(() => CELL.value + GAP.value);
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
    cols.push({ x: LEFT + w * PITCH.value, month: monday.getMonth(), cells });
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

const svgWidth = computed(() => LEFT + weekCount.value * PITCH.value - GAP.value);
const svgHeight = computed(() => TOP + 7 * PITCH.value - GAP.value);

/** Scroll container — keep the most recent weeks (right end) in view on
 *  first render. Deliberately NOT re-run on data updates: a user scrolling
 *  back through history must not be yanked to the front when a new answer
 *  lands in the log. */
const scrollEl = ref<HTMLDivElement | null>(null);

function scrollToEnd(): void {
  const el = scrollEl.value;
  if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
}

/* Roving tabindex: exactly ONE cell is in the tab order (the most recent
 * day by default); arrows move within the grid. 364 tabindex="0" cells
 * made keyboard traversal effectively impossible. */
const focusKey = ref<string | null>(null);

const cellIndex = computed(() => {
  const map = new Map<string, { col: number; row: number }>();
  columns.value.forEach((col, ci) => {
    for (const cell of col.cells) map.set(cell.key, { col: ci, row: cell.row });
  });
  return map;
});

function effectiveFocusKey(): string | null {
  if (focusKey.value && cellIndex.value.has(focusKey.value)) return focusKey.value;
  const cols = columns.value;
  const lastCol = cols[cols.length - 1];
  return lastCol?.cells[lastCol.cells.length - 1]?.key ?? null;
}

function cellTabindex(key: string): number {
  return effectiveFocusKey() === key ? 0 : -1;
}

function moveFocus(dCol: number, dRow: number): void {
  const cur = effectiveFocusKey();
  const pos = cur ? cellIndex.value.get(cur) : undefined;
  if (!pos) return;
  const cols = columns.value;
  let ci = pos.col + dCol;
  let ri = pos.row + dRow;
  // vertical wraps within the same week; horizontal clamps at both ends
  if (ri < 0) ri = 6;
  if (ri > 6) ri = 0;
  ci = Math.max(0, Math.min(cols.length - 1, ci));
  const target = cols[ci]?.cells.find((c) => c.row === ri) ?? cols[ci]?.cells[cols[ci]!.cells.length - 1];
  if (!target) return;
  focusKey.value = target.key;
  requestAnimationFrame(() => {
    scrollEl.value
      ?.querySelector<SVGGElement>(`g[data-key="${target.key}"]`)
      ?.focus();
  });
}

function onCellKeydown(ev: KeyboardEvent): void {
  switch (ev.key) {
    case 'ArrowLeft':
      ev.preventDefault();
      moveFocus(-1, 0);
      break;
    case 'ArrowRight':
      ev.preventDefault();
      moveFocus(1, 0);
      break;
    case 'ArrowUp':
      ev.preventDefault();
      moveFocus(0, -1);
      break;
    case 'ArrowDown':
      ev.preventDefault();
      moveFocus(0, 1);
      break;
  }
}

onMounted(() => {
  // jsdom (tests) has no matchMedia — coarse stays false there
  if (typeof window.matchMedia === 'function') {
    coarseMq = window.matchMedia('(pointer: coarse)');
    syncCoarse();
    coarseMq.addEventListener('change', syncCoarse);
  }
  scrollToEnd();
});
onBeforeUnmount(() => coarseMq?.removeEventListener('change', syncCoarse));
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
            :class="[`q-heat__cell--b${cell.bucket}`, { 'q-heat__cell--selected': cell.key === selectedDate }]"
            role="button"
            :tabindex="cellTabindex(cell.key)"
            :data-key="cell.key"
            :aria-label="cell.title"
            :aria-pressed="cell.key === selectedDate"
            @click="emit('select', cell.key)"
            @keydown="onCellKeydown"
            @keydown.enter.prevent="emit('select', cell.key)"
            @keydown.space.prevent="emit('select', cell.key)"
          >
            <title>{{ cell.title }}</title>
            <rect
              v-if="cell.key === selectedDate"
              class="q-heat__ring"
              :x="col.x - 2"
              :y="TOP + cell.row * PITCH - 2"
              :width="CELL + 4"
              :height="CELL + 4"
              rx="3"
            />
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
  /* subtle edge fades hint that older weeks live off-screen — 12px so the
   * fade never eats into the cells themselves */
  mask-image: linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
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
.q-heat__cell:focus-visible .q-heat__base {
  stroke: var(--q-accent-strong);
  stroke-width: 2px;
}
.q-heat__ring {
  fill: none;
  stroke: var(--q-accent-strong);
  stroke-width: 1.5px;
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
