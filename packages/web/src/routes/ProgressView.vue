<script setup lang="ts">
/** Fortschritt / Beherrschung (prototype 3c, mobile 5d). */
import { computed } from 'vue';
import { CompetencyGroups } from '@qed2/ui';
import { useProgressStore } from '../stores/progress.js';

const progress = useProgressStore();

// Per-competency due flags need the part→competency map, which the archive
// deliberately does not carry (contract stores only codes+mastery). v1 shows
// the global due count in the stats band instead.
const entries = computed(() =>
  progress.masteryEntries.map((e) => ({ code: e.code, mastery: e.mastery, due: false })),
);

const avgMastery = computed(() => {
  const list = progress.masteryEntries;
  if (list.length === 0) return 0;
  return Math.round((list.reduce((s, e) => s + e.mastery, 0) / list.length) * 100);
});
</script>

<template>
  <div class="prog">
    <div class="prog__head">
      <h1 class="prog__title">Fortschritt</h1>
      <div class="prog__legend">
        <span class="prog__legend-item"><span class="prog__sq prog__sq--ok" />hoch</span>
        <span class="prog__legend-item"><span class="prog__sq prog__sq--part" />mittel</span>
        <span class="prog__legend-item"><span class="prog__sq prog__sq--low" />gering</span>
      </div>
    </div>

    <div class="prog__stats">
      <div class="prog__stat">
        <div class="prog__stat-num">{{ progress.practicedParts }}</div>
        <div class="prog__stat-label">Bearbeitete Teile</div>
      </div>
      <div class="prog__stat">
        <div class="prog__stat-num">{{ progress.dueCount }}</div>
        <div class="prog__stat-label">Fällig heute</div>
      </div>
      <div class="prog__stat">
        <div class="prog__stat-num">{{ avgMastery }} %</div>
        <div class="prog__stat-label">Ø Beherrschung</div>
      </div>
    </div>

    <CompetencyGroups v-if="entries.length > 0" :entries="entries" />
    <div v-else class="prog__empty">
      Noch kein Fortschritt — starte deine erste Sitzung.
      <RouterLink to="/ueben" class="prog__cta">Intelligent üben →</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.prog {
  max-width: 720px;
  margin: 0 auto;
  padding: 26px 20px 40px;
}
.prog__head {
  margin-bottom: 16px;
}
.prog__title {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin: 0 0 10px;
}
.prog__legend {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.prog__legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--q-mut);
}
.prog__sq {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.prog__sq--ok {
  background: var(--q-ok);
}
.prog__sq--part {
  background: var(--q-part);
}
.prog__sq--low {
  background: var(--q-mut-2);
}
.prog__stats {
  display: flex;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.prog__stat {
  flex: 1;
  min-width: 120px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
  padding: 14px 16px;
}
.prog__stat-num {
  font-weight: 800;
  font-size: 24px;
}
.prog__stat-label {
  font-size: 11px;
  color: var(--q-faint);
  margin-top: 2px;
}
.prog__empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--q-mut-2);
  font-size: 13.5px;
  background: var(--q-panel);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.prog__cta {
  font-weight: 700;
  color: var(--q-accent-strong);
  text-decoration: none;
}
</style>
