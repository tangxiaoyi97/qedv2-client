<script setup lang="ts">
import { useI18n } from '../i18n.js';

import { ChevronRight } from 'lucide-vue-next';
import type { LeaderboardItem, LeaderboardPeriod } from '@qed2/core-logic';

const { t, formatNumber } = useI18n();

const props = defineProps<{
  item: LeaderboardItem;
  period: LeaderboardPeriod;
}>();
defineEmits<{ open: [profileId: string] }>();


function periodCount(): number {
  return props.period === 'today' ? props.item.todayPracticed : props.item.weekPracticed;
}
</script>

<template>
  <button
    type="button"
    class="leader-row"
    :class="{
      'leader-row--me': item.isMe,
      'leader-row--podium': item.rank <= 3,
    }"
    :aria-label="[
      t('{name}, Rang {rank}, Details öffnen', { name: item.nickname, rank: item.rank }),
      `${t(period === 'today' ? 'Heute' : 'Diese Woche')}: ${formatNumber(periodCount())}`,
      `${t('Gesamt')}: ${formatNumber(item.totalPracticed)}`,
      `${t('Punkte')}: ${formatNumber(item.totalScore)}`,
      item.isMe ? t('Du') : '',
    ].filter(Boolean).join(', ')"
    @click="$emit('open', item.profileId)"
  >
    <span class="leader-row__top">
      <span class="leader-row__rank" :class="`leader-row__rank--${Math.min(item.rank, 4)}`">
        <span>{{ item.rank }}</span>
      </span>

      <span class="leader-row__identity">
        <span class="leader-row__nickname" :title="item.nickname">{{ item.nickname }}</span>
        <span v-if="item.isMe" class="leader-row__you">{{ t('Du') }}</span>
      </span>
    </span>

    <span class="leader-row__stats">
      <span class="leader-row__stat leader-row__stat--primary">
        <strong :title="formatNumber(periodCount())">{{ formatNumber(periodCount()) }}</strong>
      </span>
      <span class="leader-row__stat">
        <strong :title="formatNumber(item.totalPracticed)">{{ formatNumber(item.totalPracticed) }}</strong>
      </span>
      <span class="leader-row__stat leader-row__stat--score">
        <strong :title="formatNumber(item.totalScore)">{{ formatNumber(item.totalScore) }}</strong>
      </span>
    </span>

    <ChevronRight class="leader-row__chevron" aria-hidden="true" />
  </button>
</template>

<style scoped>
.leader-row {
  position: relative;
  width: 100%;
  min-height: 64px;
  display: grid;
  grid-template-columns: var(--q-leaderboard-columns);
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-card);
  background: var(--q-card);
  color: var(--q-ink);
  cursor: pointer;
  font-family: 'Public Sans', system-ui, sans-serif;
  text-align: left;
  transition:
    border-color var(--q-transition-fast),
    background var(--q-transition-fast);
}

@media (hover: hover) and (pointer: fine) {
  .leader-row:hover {
    border-color: var(--q-border-3);
    background: var(--q-panel);
  }
}

.leader-row:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}

.leader-row--me {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
}

.leader-row__top {
  display: contents;
}

.leader-row__rank {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  justify-self: center;
  border-radius: 50%;
  color: var(--q-mut);
  font-size: var(--q-font-ui);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.leader-row__rank--1 {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
}

.leader-row__rank--2 {
  border: 1px solid var(--q-border-3);
  background: var(--q-panel-2);
  color: var(--q-ink-2);
}

.leader-row__rank--3 {
  border: 1px solid color-mix(in srgb, var(--q-accent) 45%, var(--q-border));
  background: color-mix(in srgb, var(--q-accent-bg) 70%, var(--q-panel-2));
  color: var(--q-accent-strong);
}

.leader-row__identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.leader-row__nickname {
  overflow: hidden;
  color: var(--q-ink-2);
  font-size: var(--q-font-ui);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leader-row__you {
  flex: none;
  padding: 2px 4px;
  border: 1px solid color-mix(in srgb, var(--q-accent) 38%, transparent);
  border-radius: 5px;
  background: var(--q-card);
  color: var(--q-accent-strong);
  font-size: var(--q-font-small);
  font-weight: 600;
}

.leader-row__stats {
  display: contents;
}

.leader-row__stat {
  min-width: 0;
  color: var(--q-ink-2);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.leader-row__stat strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--q-font-ui);
  font-weight: 650;
}

.leader-row__stat--primary strong {
  color: var(--q-accent-strong);
  font-size: 20px;
  font-weight: 800;
}

.leader-row__stat--score {
  color: var(--q-mut);
}

.leader-row__chevron {
  width: 16px;
  height: 16px;
  color: var(--q-faint);
  opacity: 0.65;
  transition: opacity var(--q-transition-fast), transform var(--q-transition-fast);
}

.leader-row:hover .leader-row__chevron {
  opacity: 1;
  transform: translateX(2px);
}

@media (max-width: 700px) {
  .leader-row {
    gap: 8px;
    min-height: 56px;
    padding: 12px 8px;
    border-radius: var(--q-radius-control);
  }

  .leader-row__rank {
    width: 24px;
    height: 24px;
    font-size: var(--q-font-small);
  }

  .leader-row__nickname {
    font-size: var(--q-font-small);
  }

  .leader-row__identity {
    gap: 4px;
  }

  .leader-row__stat strong,
  .leader-row__stat--primary strong {
    font-size: var(--q-font-small);
  }

  .leader-row__you {
    padding: 0;
    border: 0;
    background: transparent;
    font-size: 10px;
  }

  .leader-row__chevron {
    width: 12px;
    height: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .leader-row,
  .leader-row__chevron {
    transition: none;
  }
  .leader-row:hover .leader-row__chevron {
    transform: none;
  }
}
</style>
