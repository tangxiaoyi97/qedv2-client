<script setup lang="ts">
import { QChip, StarButton } from '@qed2/ui';
import { ExternalLink } from 'lucide-vue-next';

defineProps<{
  title: string;
  competencyCodes: string[];
  sourceLine: string;
  points?: number | null;
  format?: string;
  starred: boolean;
  officialUrl?: string | null;
}>();

const emit = defineEmits<{
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
      <QChip v-if="format" tone="neutral">{{ format }}</QChip>
    </div>
    <div class="practice-qhead__subline">
      <span class="practice-qhead__source">{{ sourceLine }}<template v-if="points != null"> · {{ points }} P</template></span>
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
  font-size: 26px;
  line-height: 1.25;
  font-weight: 800;
  letter-spacing: -0.01em;
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

/* secondary info drops to a quieter line of its own — one glance separates
 * labels (chips) from provenance (source/original/points) */
.practice-qhead__subline {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.practice-qhead__source {
  font-size: 12px;
  color: var(--q-faint);
  font-weight: 500;
}

.practice-qhead__official {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--q-mut-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}
@media (hover: hover) and (pointer: fine) {
  .practice-qhead__official:hover {
    color: var(--q-accent-strong);
    text-decoration: underline;
  }
}
.practice-qhead__official:focus-visible {
  color: var(--q-accent-strong);
  outline: none;
  text-decoration: underline;
}

.practice-qhead__official-icon {
  width: 12px;
  height: 12px;
  stroke-width: 2.2px;
}

@media (max-width: 640px) {
  .practice-qhead__title {
    font-size: 21px;
  }
}
</style>
