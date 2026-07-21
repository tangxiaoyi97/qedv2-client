<script setup lang="ts">
/**
 * Sync-conflict dialog (prototype 4d; contract §5.2) — calm, explanatory.
 * Summary mode picks one side for everything; the advanced mode picks per
 * entry. Resolution goes through progressStore.resolveConflict; a nested
 * conflict (another device wrote meanwhile) starts a new round in place.
 */
import { computed, ref, watch } from 'vue';
import { isPartConflict, type ConflictEntry } from '@qed2/core-logic';
import { QButton } from '@qed2/ui';
import { useModalA11y } from '../composables/useModalA11y.js';
import { useProgressStore } from '../stores/progress.js';

const progress = useProgressStore();

const perEntry = ref(false);
const summaryPick = ref<'server' | 'local'>('server');
const entryPicks = ref<Record<string, 'server' | 'local'>>({});
const pending = ref(false);
const rounds = ref(0);

const conflict = computed(() => progress.conflict);

const card = ref<HTMLElement | null>(null);
useModalA11y(card, computed(() => conflict.value != null), onEscape);

watch(conflict, (c, prev) => {
  if (c) {
    entryPicks.value = Object.fromEntries(c.conflicts.map((e) => [keyOf(e), 'server' as const]));
    if (prev) rounds.value += 1;
    else rounds.value = 0;
    perEntry.value = false;
    summaryPick.value = 'server';
  }
});

function keyOf(e: ConflictEntry): string {
  return isPartConflict(e) ? e.partId : e.competencyCode;
}

function sideStamp(side: 'server' | 'local'): string {
  const c = conflict.value;
  if (!c) return '';
  let max = 0;
  for (const e of c.conflicts) {
    const t = new Date(e[side].updatedAt).getTime();
    if (t > max) max = t;
  }
  return new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(max));
}

const cloudNewer = computed(() => {
  const c = conflict.value;
  if (!c) return false;
  const m = (side: 'server' | 'local') =>
    Math.max(...c.conflicts.map((e) => new Date(e[side].updatedAt).getTime()));
  return m('server') >= m('local');
});

function entryTitle(e: ConflictEntry): string {
  return isPartConflict(e) ? e.partId : `Kompetenz ${e.competencyCode}`;
}

function entrySummary(e: ConflictEntry, side: 'server' | 'local'): string {
  const stamp = new Intl.DateTimeFormat('de-AT', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(e[side].updatedAt),
  );
  if (isPartConflict(e)) {
    const entry = e[side];
    const pts = entry.lastResult ? `${entry.lastResult.awardedPoints} P` : '—';
    return `${stamp} · ${pts} · fällig ${new Intl.DateTimeFormat('de-AT', { dateStyle: 'short' }).format(new Date(entry.fsrs.due))}`;
  }
  return `${stamp} · Beherrschung ${Math.round(e[side].mastery * 100)} %`;
}

async function apply(): Promise<void> {
  const c = conflict.value;
  if (!c || pending.value) return;
  pending.value = true;
  try {
    const choices: Record<string, 'server' | 'local'> = {};
    for (const e of c.conflicts) {
      const k = keyOf(e);
      choices[k] = perEntry.value ? (entryPicks.value[k] ?? 'server') : summaryPick.value;
    }
    await progress.resolveConflict(choices);
  } finally {
    pending.value = false;
  }
}

function onEscape(): void {
  if (!pending.value) progress.dismissConflict();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="conflict" class="conflict" role="dialog" aria-modal="true" aria-label="Synchronisierungskonflikt">
      <div ref="card" class="conflict__card">
        <div class="conflict__head">
          <span class="conflict__icon" aria-hidden="true">⟳</span>
          <div class="conflict__title">Synchronisierungskonflikt</div>
        </div>
        <p class="conflict__text">
          Dein Fortschritt wurde auf einem anderen Gerät geändert, während dieses Gerät nicht synchron war.
          Wähle, welche Version behalten werden soll — die andere wird überschrieben.
        </p>
        <p v-if="rounds > 0" class="conflict__renote">Erneut geändert — bitte noch einmal wählen.</p>

        <div v-if="!perEntry" class="conflict__sides">
          <button
            type="button"
            class="conflict__side"
            :class="{ 'conflict__side--on': summaryPick === 'server' }"
            @click="summaryPick = 'server'"
          >
            <div class="conflict__side-head">
              <span aria-hidden="true">☁️</span>
              <b>Cloud-Version</b>
              <span class="conflict__radio" :class="{ 'conflict__radio--on': summaryPick === 'server' }" />
            </div>
            <div class="conflict__side-stamp">Zuletzt geändert<br /><b>{{ sideStamp('server') }}</b></div>
            <div class="conflict__side-n">{{ conflict.conflicts.length }} Einträge betroffen</div>
          </button>
          <button
            type="button"
            class="conflict__side"
            :class="{ 'conflict__side--on': summaryPick === 'local' }"
            @click="summaryPick = 'local'"
          >
            <div class="conflict__side-head">
              <span aria-hidden="true">💻</span>
              <b>Lokale Version</b>
              <span class="conflict__radio" :class="{ 'conflict__radio--on': summaryPick === 'local' }" />
            </div>
            <div class="conflict__side-stamp">Zuletzt geändert<br /><b>{{ sideStamp('local') }}</b></div>
            <div class="conflict__side-n">dieses Gerät</div>
          </button>
        </div>

        <div v-else class="conflict__entries">
          <div v-for="e in conflict.conflicts" :key="keyOf(e)" class="conflict__entry">
            <div class="conflict__entry-title">{{ entryTitle(e) }}</div>
            <label class="conflict__entry-opt">
              <input v-model="entryPicks[keyOf(e)]" type="radio" :name="keyOf(e)" value="server" />
              <span>☁️ {{ entrySummary(e, 'server') }}</span>
            </label>
            <label class="conflict__entry-opt">
              <input v-model="entryPicks[keyOf(e)]" type="radio" :name="keyOf(e)" value="local" />
              <span>💻 {{ entrySummary(e, 'local') }}</span>
            </label>
          </div>
        </div>

        <button type="button" class="conflict__toggle" @click="perEntry = !perEntry">
          {{ perEntry ? '‹ Zurück zur einfachen Auswahl' : '⚙ Pro Eintrag auswählen (erweitert)' }}
        </button>

        <div class="conflict__footer">
          <span class="conflict__hint">{{ cloudNewer ? 'Cloud ist neuer — meist die sichere Wahl.' : 'Lokal ist neuer.' }}</span>
          <QButton variant="secondary" :disabled="pending" @click="progress.dismissConflict()">Später entscheiden</QButton>
          <QButton :disabled="pending" @click="apply">{{ pending ? 'Übernehme …' : 'Auswahl übernehmen' }}</QButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.conflict {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
}
.conflict__card {
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--q-card);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
  padding: 22px 24px 16px;
}
.conflict__head {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 8px;
}
.conflict__icon {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--q-part-bg);
  color: var(--q-part);
  display: grid;
  place-items: center;
  font-size: 16px;
  flex: none;
}
.conflict__title {
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.01em;
}
.conflict__text {
  font-size: 13px;
  line-height: 1.55;
  color: var(--q-mut);
  margin: 0 0 6px;
}
.conflict__renote {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-part-ink);
  background: var(--q-part-bg);
  border: 1px solid var(--q-part-border);
  border-radius: 8px;
  padding: 8px 11px;
  margin: 8px 0 0;
}
.conflict__sides {
  display: flex;
  gap: 12px;
  margin: 16px 0 4px;
}
.conflict__side {
  flex: 1;
  border: 1px solid var(--q-border-2);
  border-radius: 12px;
  padding: 15px;
  background: var(--q-card);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--q-ink);
}
.conflict__side--on {
  border: 2px solid var(--q-accent);
  background: var(--q-accent-bg);
  padding: 14px;
}
.conflict__side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13.5px;
}
.conflict__radio {
  margin-left: auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--q-btn-border);
  flex: none;
}
.conflict__radio--on {
  border: none;
  background: var(--q-accent-strong);
  position: relative;
}
.conflict__radio--on::after {
  content: '✓';
  color: var(--q-on-accent);
  font-size: 11px;
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}
.conflict__side-stamp {
  font-size: 11.5px;
  color: var(--q-mut-2);
  margin-bottom: 8px;
}
.conflict__side-n {
  font-size: 12px;
  color: var(--q-mut);
}
.conflict__entries {
  margin: 14px 0 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 320px;
  overflow-y: auto;
}
.conflict__entry {
  border: 1px solid var(--q-border);
  border-radius: 10px;
  padding: 11px 13px;
}
.conflict__entry-title {
  font-weight: 700;
  font-size: 12.5px;
  margin-bottom: 7px;
  font-family: ui-monospace, Menlo, monospace;
}
.conflict__entry-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--q-mut);
  padding: 3px 0;
  cursor: pointer;
}
.conflict__toggle {
  border: none;
  background: none;
  color: var(--q-accent-strong);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 8px 0;
  font-family: inherit;
}
.conflict__footer {
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid var(--q-border);
  margin: 8px -24px 0;
  padding: 14px 24px 2px;
  background: var(--q-panel);
  border-radius: 0 0 14px 14px;
  flex-wrap: wrap;
}
.conflict__hint {
  font-size: 11.5px;
  color: var(--q-faint);
  flex: 1;
  min-width: 140px;
}
@media (max-width: 560px) {
  .conflict__sides {
    flex-direction: column;
  }
}
</style>
