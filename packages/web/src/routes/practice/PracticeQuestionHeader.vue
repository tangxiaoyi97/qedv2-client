<script setup lang="ts">
import type { Grading, GradingOrUnseen } from '@qed2/core-logic';
import { GradingMenu, QChip, StarButton } from '@qed2/ui';
import { ExternalLink } from 'lucide-vue-next';

defineProps<{
  title: string;
  competencyCodes: string[];
  grading: GradingOrUnseen;
  sourceLine: string;
  points?: number | null;
  format?: string;
  starred: boolean;
  officialUrl?: string | null;
}>();

const emit = defineEmits<{
  gradingSelect: [grading: Grading];
  starToggle: [];
}>();
</script>

<template>
  <header class="practice-qhead">
    <div class="practice-qhead__title-row">
      <h1 class="practice-qhead__title">{{ title }}</h1>
      <StarButton :starred="starred" @toggle="emit('starToggle')" />
    </div>

    <div class="practice-qhead__meta">
      <QChip v-for="code in competencyCodes" :key="code">{{ code }}</QChip>
      <GradingMenu :grading="grading" @select="emit('gradingSelect', $event)" />
      <QChip v-if="format" tone="neutral">{{ format }}</QChip>
      <span class="practice-qhead__source">{{ sourceLine }}</span>
      <a
        v-if="officialUrl"
        class="practice-qhead__official"
        :href="officialUrl"
        target="_blank"
        rel="noopener noreferrer"
        title="Offizielle Originalaufgabe"
      >
        Originalaufgabe <ExternalLink class="practice-qhead__official-icon" aria-hidden="true" />
      </a>
      <span v-if="points != null" class="practice-qhead__points">{{ points }} P</span>
    </div>
  </header>
</template>

<style scoped>
.practice-qhead {
  border-bottom: 1px solid var(--q-border);
  padding-bottom: 18px;
  margin-bottom: 20px;
}

.practice-qhead__title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.practice-qhead__title {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: 0;
  margin: 0;
  flex: 1;
  min-width: 0;
  overflow-wrap: break-word;
}

.practice-qhead__meta {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.practice-qhead__source {
  font-size: 12.5px;
  color: var(--q-mut-2);
  font-weight: 500;
}

.practice-qhead__official {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  border: 1px solid var(--q-border-2);
  border-radius: 7px;
  background: var(--q-panel);
  color: var(--q-accent-strong);
  font-size: 12px;
  font-weight: 750;
  line-height: 1;
  padding: 5px 9px;
  text-decoration: none;
  white-space: nowrap;
}

.practice-qhead__official-icon {
  width: 12px;
  height: 12px;
  stroke-width: 2.2px;
}

@media (hover: hover) and (pointer: fine) {
  .practice-qhead__official:hover {
    border-color: var(--q-accent);
    background: var(--q-accent-bg);
  }
}
.practice-qhead__official:focus-visible {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  outline: none;
}

.practice-qhead__points {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--q-mut-2);
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  padding: 3px 10px;
  border-radius: 20px;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .practice-qhead__title {
    font-size: 24px;
  }
}
</style>
