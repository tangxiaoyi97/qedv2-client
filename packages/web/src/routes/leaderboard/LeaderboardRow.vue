<script setup lang="ts">
import { ChevronRight, Trophy } from 'lucide-vue-next';
import type { LeaderboardItem, LeaderboardPeriod } from '@qed2/core-logic';

const props = defineProps<{
  item: LeaderboardItem;
  period: LeaderboardPeriod;
}>();
defineEmits<{ open: [profileId: string] }>();

const numberFormat = new Intl.NumberFormat('de-AT');

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
    :aria-label="`${item.nickname}, Rang ${item.rank}, Details öffnen`"
    @click="$emit('open', item.profileId)"
  >
    <span class="leader-row__top">
      <span class="leader-row__rank" :class="`leader-row__rank--${Math.min(item.rank, 4)}`">
        <Trophy v-if="item.rank <= 3" aria-hidden="true" />
        <span v-else>{{ item.rank }}</span>
      </span>

      <span class="leader-row__identity">
        <span class="leader-row__nickname">{{ item.nickname }}</span>
        <span v-if="item.isMe" class="leader-row__you">Du</span>
      </span>

      <ChevronRight class="leader-row__chevron leader-row__chevron--mobile" aria-hidden="true" />
    </span>

    <span class="leader-row__stats">
      <span class="leader-row__stat leader-row__stat--primary">
        <span class="leader-row__mobile-label">Aktuell</span>
        <strong>{{ numberFormat.format(periodCount()) }}</strong>
      </span>
      <span class="leader-row__stat">
        <span class="leader-row__mobile-label">Gesamt</span>
        <strong>{{ numberFormat.format(item.totalPracticed) }}</strong>
      </span>
      <span class="leader-row__stat leader-row__stat--score">
        <span class="leader-row__mobile-label">Punkte</span>
        <strong>{{ numberFormat.format(item.totalScore) }}</strong>
      </span>
    </span>

    <ChevronRight class="leader-row__chevron leader-row__chevron--desktop" aria-hidden="true" />
  </button>
</template>

<style scoped>
.leader-row {
  position: relative;
  width: 100%;
  min-height: 68px;
  display: grid;
  grid-template-columns: 64px minmax(170px, 1fr) 116px 96px 96px 24px;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border: 1px solid var(--q-border);
  border-radius: 11px;
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
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  justify-self: center;
  border-radius: 50%;
  color: var(--q-mut);
  font-size: 17px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.leader-row__rank svg {
  width: 16px;
  height: 16px;
  stroke-width: 2.2;
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
  gap: 9px;
}

.leader-row__nickname {
  overflow: hidden;
  color: var(--q-ink-2);
  font-size: 15px;
  font-weight: 720;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leader-row__you {
  flex: none;
  padding: 3px 7px;
  border: 1px solid color-mix(in srgb, var(--q-accent) 38%, transparent);
  border-radius: 5px;
  background: var(--q-card);
  color: var(--q-accent-strong);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.leader-row__stats {
  display: contents;
}

.leader-row__stat {
  color: var(--q-ink-2);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.leader-row__stat strong {
  font-size: 14px;
  font-weight: 650;
}

.leader-row__stat--primary strong {
  color: var(--q-accent-strong);
  font-size: 21px;
  font-weight: 820;
  letter-spacing: -0.035em;
}

.leader-row__stat--score {
  color: var(--q-mut);
}

.leader-row__chevron {
  width: 17px;
  height: 17px;
  color: var(--q-faint);
  opacity: 0.65;
  transition: opacity var(--q-transition-fast), transform var(--q-transition-fast);
}

.leader-row:hover .leader-row__chevron {
  opacity: 1;
  transform: translateX(2px);
}

.leader-row__chevron--mobile,
.leader-row__mobile-label {
  display: none;
}

@media (max-width: 700px) {
  .leader-row {
    display: flex;
    flex-direction: column;
    gap: 11px;
    min-height: 0;
    padding: 14px;
    border-radius: 10px;
  }

  .leader-row__top {
    width: 100%;
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) 18px;
    align-items: center;
    gap: 10px;
  }

  .leader-row__rank {
    width: 30px;
    height: 30px;
    justify-self: start;
    font-size: 14px;
  }

  .leader-row__nickname {
    font-size: 14px;
  }

  .leader-row__stats {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    padding-top: 11px;
    border-top: 1px solid var(--q-border-soft);
  }

  .leader-row__stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    text-align: center;
  }

  .leader-row__stat + .leader-row__stat {
    border-left: 1px solid var(--q-border-soft);
  }

  .leader-row__stat strong,
  .leader-row__stat--primary strong {
    font-size: 17px;
  }

  .leader-row__mobile-label {
    display: block;
    color: var(--q-faint);
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  .leader-row__stat--primary .leader-row__mobile-label {
    color: var(--q-accent-strong);
  }

  .leader-row__chevron--desktop {
    display: none;
  }

  .leader-row__chevron--mobile {
    display: block;
  }
}
</style>
