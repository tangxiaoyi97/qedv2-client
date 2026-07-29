<script lang="ts">
import type { Verdict } from '@qed2/core-logic';

/** One row of the programme overview. */
export interface SessionItem {
  index: number;
  partId: string;
  title: string;
  partLabel: string | undefined;
  state: Verdict | 'current' | 'pending';
  /** Graded parts are not revisitable — re-answering would advance FSRS twice. */
  jumpable: boolean;
}
</script>

<script setup lang="ts">
/**
 * The programme list, shared by the desktop rail and the mobile drawer.
 *
 * Those two differ only in their chrome — a sticky sidebar versus a modal
 * sheet — and used to carry a byte-identical copy of this list, its labels
 * and its type. `dense` keeps the rail's tighter metrics; the drawer's
 * roomier ones are the default because it is the touch surface.
 */
import { VERDICT_LABELS } from '@qed2/core-logic';
import StateIcon from '../shared/StateIcon.vue';

const STATE_LABELS: Record<SessionItem['state'], string> = {
  ...VERDICT_LABELS,
  current: 'Aktuelle Aufgabe',
  pending: 'Noch nicht beantwortet',
};

const props = withDefaults(
  defineProps<{
    items: readonly SessionItem[];
    dense?: boolean;
  }>(),
  { dense: false },
);

const emit = defineEmits<{ jump: [index: number] }>();

const isAnswered = (state: SessionItem['state']): boolean =>
  state === 'correct' || state === 'partial' || state === 'incorrect';

function title(item: SessionItem): string {
  if (item.state === 'current') return 'Aktuelle Aufgabe';
  return item.jumpable ? 'Zu dieser Aufgabe springen' : 'Bereits beantwortet';
}
</script>

<template>
  <ol class="q-sitems" :class="{ 'q-sitems--dense': props.dense }">
    <li v-for="item in items" :key="item.partId">
      <button
        type="button"
        class="q-sitems__item"
        :class="{
          'q-sitems__item--current': item.state === 'current',
          'q-sitems__item--done': isAnswered(item.state),
        }"
        :disabled="!item.jumpable && item.state !== 'current'"
        :title="title(item)"
        :aria-label="`${item.index + 1}. ${item.title}${item.partLabel ? ` · ${item.partLabel}` : ''}: ${STATE_LABELS[item.state]}`"
        @click="item.jumpable && emit('jump', item.index)"
      >
        <span class="q-sitems__icon" aria-hidden="true">
          <StateIcon
            v-if="isAnswered(item.state)"
            :state="item.state as 'correct' | 'partial' | 'incorrect'"
            :size="props.dense ? 15 : 16"
          />
          <span v-else-if="item.state === 'current'" class="q-sitems__now">→</span>
          <span v-else class="q-sitems__pending" />
        </span>
        <span class="q-sitems__nr">{{ item.index + 1 }}</span>
        <span class="q-sitems__label">
          {{ item.title }}<template v-if="item.partLabel"> · {{ item.partLabel }}</template>
        </span>
      </button>
    </li>
  </ol>
</template>

<style scoped>
.q-sitems {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.q-sitems--dense {
  gap: 2px;
}

.q-sitems__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px 8px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--q-mut);
  font: 600 13px 'Public Sans', system-ui, sans-serif;
  text-align: left;
  cursor: pointer;
}
.q-sitems--dense .q-sitems__item {
  gap: 8px;
  padding: 7px 8px;
  font: 500 12px 'Public Sans', system-ui, sans-serif;
}

.q-sitems__item:disabled {
  cursor: default;
}
.q-sitems__item--done {
  color: var(--q-faint);
}
.q-sitems__item--current {
  background: var(--q-accent-bg);
  color: var(--q-ink);
  font-weight: 800;
}
.q-sitems--dense .q-sitems__item--current {
  font-weight: 700;
}

@media (hover: hover) and (pointer: fine) {
  .q-sitems__item:not(:disabled):hover {
    background: var(--q-panel);
  }
  .q-sitems--dense .q-sitems__item:not(:disabled):hover {
    background: var(--q-panel-2);
  }
  .q-sitems__item--current:hover {
    background: var(--q-accent-bg);
  }
}

.q-sitems__icon {
  width: 18px;
  display: inline-flex;
  justify-content: center;
  flex: none;
}
.q-sitems--dense .q-sitems__icon {
  width: 16px;
}

.q-sitems__now {
  color: var(--q-accent-strong);
  font-weight: 800;
}

.q-sitems__pending {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--q-btn-border);
  display: inline-block;
}

.q-sitems__nr {
  font: 700 11px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
  width: 24px;
  flex: none;
  text-align: right;
}
.q-sitems--dense .q-sitems__nr {
  font: 600 10.5px ui-monospace, Menlo, monospace;
  width: 20px;
}

.q-sitems__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
