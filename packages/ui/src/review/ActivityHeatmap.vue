<script setup lang="ts">
import { useI18n } from '../i18n.js';

/**
 * GitHub-style activity heatmap (Fortschritt + dashboard). Feed comes from
 * HistoryLog.dailyActivity — keys are LOCAL dates 'YYYY-MM-DD'.
 *
 * Grid: columns = weeks (default 26), rows = Mon..Sun (de-AT convention,
 * Monday on top). Intensity = accent overlay with fill-opacity buckets over a
 * track-colored base rect, so both themes ride on the same two tokens.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const { t, locale, formatDate: localizedDate } = useI18n();

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
const EDGE = 18; // room for focus rings and labels at either end
const LEFT = EDGE + 26; // safe space + weekday-label gutter
const RIGHT = EDGE;
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
  if (locale.value === 'en') return localizedDate(d, { day: '2-digit', month: 'short', year: 'numeric' });
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
        title: `${t(count === 1 ? '{count} Aufgabe' : '{count} Aufgaben', { count })} · ${formatDate(date)}`,
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
    out.push({ x: cols[0]!.x, text: monthName(cols[0]!.month) });
  }
  for (const c of changes) out.push({ x: cols[c]!.x, text: monthName(cols[c]!.month) });
  return out;
});

function monthName(month: number): string {
  return locale.value === 'en' ? localizedDate(new Date(2026, month, 1), { month: 'short' }) : MONTHS[month]!;
}
function weekdayName(row: number, fallback: string): string {
  return locale.value === 'en' ? localizedDate(new Date(2026, 0, 5 + row), { weekday: 'short' }) : fallback;
}

const svgWidth = computed(() => LEFT + weekCount.value * PITCH.value - GAP.value + RIGHT);
const svgHeight = computed(() => TOP + 7 * PITCH.value - GAP.value);

/** Follow the latest range until the user scrolls back. Keep that choice
 * through async loading, hidden panels, resizing and pointer-pitch changes. */
const scrollEl = ref<HTMLDivElement | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);
const followingLatest = ref(true);
const overflowing = ref(false);
let resizeObserver: ResizeObserver | undefined;
let disposed = false;
let measured: { width: number; content: number; left: number; pitch: number } | undefined;

function syncViewport(): void {
  const el = scrollEl.value;
  if (!el || el.clientWidth <= 0) return;
  const max = Math.max(0, el.scrollWidth - el.clientWidth);
  const previous = measured;
  const left = followingLatest.value
    ? max
    : previous
      ? LEFT + (previous.left - LEFT) * PITCH.value / previous.pitch
      : el.scrollLeft;
  el.scrollLeft = Math.max(0, Math.min(max, left));
  measured = { width: el.clientWidth, content: el.scrollWidth, left: el.scrollLeft, pitch: PITCH.value };
  overflowing.value = max > 1;
}

function onScroll(): void {
  const el = scrollEl.value;
  if (!el || el.clientWidth <= 0) return;
  // Layout can dispatch scroll before ResizeObserver. It must not turn an
  // automatic clamp into a user's decision to stop following the latest day.
  if (!measured || measured.width !== el.clientWidth || measured.content !== el.scrollWidth) {
    syncViewport();
    return;
  }
  measured.left = el.scrollLeft;
  followingLatest.value = el.scrollWidth - el.clientWidth - el.scrollLeft <= 2;
}

function scrollToEnd(): void {
  followingLatest.value = true;
  syncViewport();
}

watch(() => [props.data, props.endDate, svgWidth.value], syncViewport, { flush: 'post' });

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

function revealCell(key: string): void {
  focusKey.value = key;
  const el = scrollEl.value;
  const pos = cellIndex.value.get(key);
  if (!el || !pos || el.clientWidth <= 0) return;
  const left = columns.value[pos.col]!.x;
  if (left < el.scrollLeft + EDGE) el.scrollLeft = Math.max(0, left - EDGE);
  else if (left + CELL.value > el.scrollLeft + el.clientWidth - EDGE) {
    el.scrollLeft = Math.min(el.scrollWidth - el.clientWidth, left + CELL.value + EDGE - el.clientWidth);
  }
  onScroll();
}

async function focusCell(key: string): Promise<void> {
  focusKey.value = key;
  await nextTick();
  // Only reveal within this chart; browser focus scrolling must not move
  // the whole page while navigating historical days with the keyboard.
  scrollEl.value?.querySelector<SVGGElement>(`g[data-key="${key}"]`)?.focus({ preventScroll: true });
  revealCell(key);
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
  void focusCell(target.key);
}

function onCellKeydown(ev: KeyboardEvent): void {
  switch (ev.key) {
    case 'Home': {
      ev.preventDefault();
      const first = columns.value[0]?.cells[0];
      if (scrollEl.value) {
        scrollEl.value.scrollLeft = 0;
        onScroll();
      }
      if (first) void focusCell(first.key);
      break;
    }
    case 'End': {
      ev.preventDefault();
      const last = columns.value.at(-1)?.cells.at(-1);
      scrollToEnd();
      if (last) void focusCell(last.key);
      break;
    }
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

onMounted(async () => {
  // jsdom (tests) has no matchMedia — coarse stays false there
  if (typeof window.matchMedia === 'function') {
    coarseMq = window.matchMedia('(pointer: coarse)');
    syncCoarse();
    coarseMq?.addEventListener?.('change', syncCoarse);
  }
  // Coarse input changes the SVG column pitch. Measure only after that
  // render, otherwise mobile opens several months short of the latest day.
  await nextTick();
  if (disposed) return;
  syncViewport();
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(syncViewport);
    if (scrollEl.value) resizeObserver.observe(scrollEl.value);
    if (svgEl.value) resizeObserver.observe(svgEl.value);
  } else {
    window.addEventListener('resize', syncViewport);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  coarseMq?.removeEventListener?.('change', syncCoarse);
  resizeObserver?.disconnect();
  window.removeEventListener('resize', syncViewport);
});
</script>

<template>
  <div class="q-heat">
    <div ref="scrollEl" class="q-heat__scroll" @scroll.passive="onScroll">
      <svg
        ref="svgEl"
        class="q-heat__svg"
        :width="svgWidth"
        :height="svgHeight"
        :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
        role="group"
        :aria-label="t('Aktivität der letzten {count} Wochen', { count: weekCount })"
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
          :x="EDGE"
          :y="TOP + d.row * PITCH + 9"
        >
          {{ weekdayName(d.row, d.text) }}
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
            @focus="revealCell(cell.key)"
            @click="focusKey = cell.key; emit('select', cell.key)"
            @keydown="onCellKeydown"
            @keydown.enter.prevent="emit('select', cell.key)"
            @keydown.space.prevent="emit('select', cell.key)"
          >
            <title>{{ cell.title }}</title>
            <rect
              class="q-heat__hit"
              :x="col.x - GAP / 2"
              :y="TOP + cell.row * PITCH - GAP / 2"
              :width="PITCH"
              :height="PITCH"
            />
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
    <div class="q-heat__footer">
      <button v-if="overflowing" class="q-heat__latest" type="button" :disabled="followingLatest" @click="scrollToEnd">
        {{ t('Aktuell') }} <span aria-hidden="true">→</span>
      </button>
      <div class="q-heat__legend" aria-hidden="true">
        <span class="q-heat__legend-text">{{ t('Weniger') }}</span>
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
        <span class="q-heat__legend-text">{{ t('Mehr') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.q-heat {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  contain: inline-size;
}
.q-heat__scroll {
  overflow-x: auto;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  padding-block: 3px;
  scrollbar-width: thin;
  scrollbar-color: var(--q-border-2) transparent;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;
}
.q-heat__svg {
  display: block;
  max-width: none;
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
.q-heat__hit {
  fill: transparent;
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
  margin-left: auto;
}
.q-heat__footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  min-width: 0;
}
.q-heat__latest {
  border: 0;
  border-radius: 6px;
  padding: 5px 8px;
  min-height: 30px;
  background: var(--q-panel);
  color: var(--q-accent-strong);
  font: 650 11px 'Public Sans', system-ui, sans-serif;
  cursor: pointer;
}
.q-heat__latest:disabled {
  background: transparent;
  color: var(--q-faint);
  cursor: default;
}
.q-heat__latest:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
@media (pointer: coarse) {
  .q-heat__latest { min-height: 44px; }
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
