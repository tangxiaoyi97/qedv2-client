<script setup lang="ts">
/**
 * Mastery grouped by Grundkompetenz category (prototype 3c): one card per
 * AG / FA / AN / WS group, header with mean-mastery aggregate, rows of
 * MasteryBar + due dot.
 */
import { computed } from 'vue';
import { competencyCategory, masteryLevel } from '@qed2/core-logic';
import MasteryBar from './MasteryBar.vue';

export interface CompetencyGroupEntry {
  code: string;
  /** 0..1 */
  mastery: number;
  due?: boolean;
}

const props = defineProps<{
  entries: CompetencyGroupEntry[];
}>();

const CATEGORY_NAMES: Record<string, string> = {
  AG: 'Algebra & Geometrie',
  FA: 'Funktionale Abhängigkeiten',
  AN: 'Analysis',
  WS: 'Wahrscheinlichkeit & Statistik',
  other: 'Sonstige',
};

const CATEGORY_ORDER = ['AG', 'FA', 'AN', 'WS', 'other'] as const;

const LEVEL_LABELS = { low: 'gering', medium: 'mittel', high: 'hoch' } as const;

const groups = computed(() => {
  const byCat = new Map<string, CompetencyGroupEntry[]>();
  for (const entry of props.entries) {
    const cat = competencyCategory(entry.code);
    const list = byCat.get(cat);
    if (list) list.push(entry);
    else byCat.set(cat, [entry]);
  }
  return CATEGORY_ORDER.filter((cat) => byCat.has(cat)).map((cat) => {
    const rows = byCat.get(cat)!;
    const mean = rows.reduce((s, e) => s + e.mastery, 0) / rows.length;
    const level = masteryLevel(mean);
    return {
      cat,
      name: CATEGORY_NAMES[cat] ?? cat,
      rows,
      percent: Math.round(Math.min(1, Math.max(0, mean)) * 100),
      level,
      levelLabel: LEVEL_LABELS[level],
    };
  });
});
</script>

<template>
  <div class="q-cgroups">
    <section v-for="group in groups" :key="group.cat" class="q-cgroups__card">
      <header class="q-cgroups__head">
        <span class="q-cgroups__cat">{{ group.cat === 'other' ? '·' : group.cat }}</span>
        <span class="q-cgroups__name">{{ group.name }}</span>
        <span class="q-cgroups__agg" :class="`q-cgroups__agg--${group.level}`">
          {{ group.levelLabel }} · {{ group.percent }}%
        </span>
      </header>
      <div class="q-cgroups__rows">
        <div v-for="entry in group.rows" :key="entry.code" class="q-cgroups__row">
          <MasteryBar class="q-cgroups__bar" :code="entry.code" :mastery="entry.mastery" />
          <span
            class="q-cgroups__due"
            :class="{ 'q-cgroups__due--on': entry.due }"
            :title="entry.due ? 'fällig' : undefined"
          >
            <span v-if="entry.due" class="q-visually-hidden">fällig</span>
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.q-cgroups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.q-cgroups__card {
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
  overflow: hidden;
}
.q-cgroups__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
  background: var(--q-panel);
  border-bottom: 1px solid var(--q-border-soft);
}
.q-cgroups__cat {
  font-weight: 800;
  font-size: 14px;
  color: var(--q-accent-strong);
}
.q-cgroups__name {
  font-size: 13px;
  color: var(--q-ink-2);
  overflow-wrap: break-word;
  min-width: 0;
}
.q-cgroups__agg {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}
.q-cgroups__agg--high {
  color: var(--q-ok);
}
.q-cgroups__agg--medium {
  color: var(--q-part);
}
.q-cgroups__agg--low {
  color: var(--q-mut-2);
}
.q-cgroups__rows {
  padding: 6px 16px 12px;
}
.q-cgroups__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--q-border-soft);
}
.q-cgroups__row:last-child {
  border-bottom: none;
}
.q-cgroups__bar {
  flex: 1;
  min-width: 0;
}
.q-cgroups__due {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: transparent;
}
.q-cgroups__due--on {
  background: var(--q-accent);
}
.q-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
