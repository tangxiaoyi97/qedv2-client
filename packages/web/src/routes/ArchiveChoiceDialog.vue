<script setup lang="ts">
import { useI18n } from '../i18n.js';
const { t, formatDate } = useI18n();

/**
 * Login-time archive choice (upgrade doc §2.3) — both sides hold different
 * data; the user picks once. Merge is the recommended default (keeps both
 * sides' progress via the normal contract-§5 merge); "cloud only" / "local
 * only" are the explicit overwrite options. Calm and explanatory, styled
 * after the sync-conflict dialog.
 */
import { computed, ref } from 'vue';
import { QButton, useModalA11y } from '@qed2/ui';

import { useProgressStore } from '../stores/progress.js';

const progress = useProgressStore();

const pick = ref<'merge' | 'server' | 'local'>('merge');
const pending = ref(false);
const applyError = ref('');

const choice = computed(() => progress.archiveChoice);

const card = ref<HTMLElement | null>(null);
useModalA11y(card, computed(() => choice.value != null), onEscape);


function summaryLines(side: 'server' | 'local'): { label: string; value: string }[] {
  const s = choice.value?.[side];
  if (!s) return [];
  const lines = [
    { label: 'Bearbeitete Teile', value: String(s.parts) },
    { label: 'Kompetenzen', value: String(s.competencies) },
  ];
  if (s.lastUpdated) lines.push({ label: 'Zuletzt geändert', value: formatDate(new Date(s.lastUpdated), { dateStyle: 'medium', timeStyle: 'short' }) });
  if (s.avgMastery !== undefined) lines.push({ label: 'Ø Bewertung', value: `${Math.round(s.avgMastery * 100)} %` });
  return lines;
}

const OPTIONS = [
  {
    value: 'merge',
    title: 'Beide zusammenführen',
    hint: 'Empfohlen · neuere Einträge zusammenführen.',
  },
  { value: 'server', title: 'Nur Cloud behalten', hint: 'Der lokale Stand dieses Geräts wird überschrieben.' },
  { value: 'local', title: 'Nur dieses Gerät behalten', hint: 'Der Cloud-Stand wird überschrieben.' },
] as const;

async function apply(): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  applyError.value = '';
  try {
    await progress.resolveArchiveChoice(pick.value);
  } catch {
    applyError.value = 'Spielstand konnte nicht übernommen werden. Bitte erneut versuchen.';
  } finally {
    pending.value = false;
  }
}

function onChoiceKeydown(event: KeyboardEvent): void {
  const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
  if (!direction && !['Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (pending.value) return;
  const index = OPTIONS.findIndex(option => option.value === pick.value);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? OPTIONS.length - 1 : (index + direction + OPTIONS.length) % OPTIONS.length;
  pick.value = OPTIONS[next]!.value;
  (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
}

function onEscape(): void {
  if (!pending.value) progress.dismissArchiveChoice();
}
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        v-if="choice"
      class="achoice q-modal-scrim q-modal-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Spielstand wählen')"
    >
      <div ref="card" class="achoice__card">
        <div class="achoice__head">
          <span class="achoice__icon" aria-hidden="true">⇄</span>
          <div class="achoice__title">{{ t('Zwei Spielstände gefunden') }}</div>
        </div>
        <p class="achoice__text">
          {{ t('Konto und Gerät enthalten unterschiedliche Stände.') }}
        </p>

        <div class="achoice__sides">
          <div class="achoice__side">
            <div class="achoice__side-head"><span aria-hidden="true">☁️</span><b>{{ t('Cloud (Konto)') }}</b></div>
            <div v-for="line in summaryLines('server')" :key="t(line.label)" class="achoice__line">
              <span>{{ t(line.label) }}</span><b>{{ line.value }}</b>
            </div>
          </div>
          <div class="achoice__side">
            <div class="achoice__side-head"><span aria-hidden="true">💻</span><b>{{ t('Dieses Gerät') }}</b></div>
            <div v-for="line in summaryLines('local')" :key="t(line.label)" class="achoice__line">
              <span>{{ t(line.label) }}</span><b>{{ line.value }}</b>
            </div>
          </div>
        </div>

        <div class="achoice__options" role="radiogroup" :aria-label="t('Vorgehen wählen')" @keydown="onChoiceKeydown">
          <button
            v-for="o in OPTIONS"
            :key="o.value"
            type="button"
            class="achoice__option"
            :class="{ 'achoice__option--on': pick === o.value }"
            role="radio"
            :aria-checked="pick === o.value"
            :tabindex="pick === o.value ? 0 : -1"
            :disabled="pending"
            @click="pick = o.value"
          >
            <span class="achoice__radio" :class="{ 'achoice__radio--on': pick === o.value }" aria-hidden="true" />
            <span class="achoice__option-body">
              <span class="achoice__option-title">
                {{ t(o.title) }}
              </span>
              <span class="achoice__option-hint">{{ t(o.hint) }}</span>
            </span>
          </button>
        </div>

        <p v-if="applyError" role="alert">{{ t(applyError) }}</p>
        <div class="achoice__footer">
          <QButton variant="secondary" :disabled="pending" @click="progress.dismissArchiveChoice()">
            {{ t('Später entscheiden') }}
          </QButton>
          <QButton :disabled="pending" @click="apply">{{ pending ? t('Übernehme …') : t('Weiter') }}</QButton>
        </div>
      </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.modal-fade-enter-active .achoice__card,
.modal-fade-leave-active .achoice__card {
  transition: transform var(--q-transition-fast), opacity var(--q-transition-fast);
}
.modal-fade-enter-from .achoice__card,
.modal-fade-leave-to .achoice__card {
  opacity: 0;
  transform: scale(0.96) translateY(8px);
}
.achoice__card {
  width: 100%;
  max-width: 540px;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--q-card);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
  padding: 22px 24px 18px;
}
.achoice__head {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 8px;
}
.achoice__icon {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--q-chip-bg);
  color: var(--q-accent-strong);
  display: grid;
  place-items: center;
  font-size: 16px;
  flex: none;
}
.achoice__title {
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.01em;
}
.achoice__text {
  font-size: var(--q-font-ui);
  line-height: 1.55;
  color: var(--q-mut);
  margin: 0 0 14px;
}
.achoice__sides {
  display: flex;
  gap: 12px;
  margin-bottom: 14px;
}
.achoice__side {
  flex: 1;
  border: 1px solid var(--q-border-2);
  border-radius: 12px;
  padding: 13px 14px;
}
.achoice__side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--q-font-ui);
  margin-bottom: 9px;
}
.achoice__line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--q-font-small);
  color: var(--q-mut);
  padding: 2px 0;
}
.achoice__options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.achoice__option {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 12px 13px;
  border: 1px solid var(--q-border-2);
  border-radius: 11px;
  background: var(--q-card);
  cursor: pointer;
  font: inherit;
  color: var(--q-ink);
  text-align: left;
  width: 100%;
  transition: border-color var(--q-transition-fast), background-color var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .achoice__option:not(.achoice__option--on):hover {
    border-color: var(--q-accent);
    background: linear-gradient(135deg, var(--q-card), var(--q-panel-2));
    transform: translateY(-1px);
    box-shadow: var(--q-shadow-card);
  }
}
.achoice__option:not(.achoice__option--on):active {
  background: var(--q-panel-2);
  transform: scale(0.99);
}
.achoice__option--on {
  border: 2px solid var(--q-accent);
  background: var(--q-accent-bg);
  padding: 11px 12px;
}
.achoice__option:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.achoice__radio {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--q-btn-border);
  flex: none;
  margin-top: 1px;
}
.achoice__radio--on {
  border: 5px solid var(--q-accent-strong);
}
.achoice__option-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.achoice__option-title {
  font-size: var(--q-font-ui);
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.achoice__option-hint {
  font-size: var(--q-font-small);
  color: var(--q-mut-2);
  line-height: 1.45;
}
.achoice__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
  flex-wrap: wrap;
}
@media (max-width: 520px) {
  .achoice__sides {
    flex-direction: column;
  }
}
</style>
