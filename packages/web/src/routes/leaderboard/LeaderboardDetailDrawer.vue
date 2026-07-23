<script setup lang="ts">
import { computed, ref } from 'vue';
import { CalendarDays, CheckCircle2, Target, Trophy, X } from 'lucide-vue-next';
import type { LeaderboardDetail } from '@qed2/core-logic';
import { QButton } from '@qed2/ui';
import { useModalA11y } from '../../composables/useModalA11y.js';

const props = defineProps<{
  open: boolean;
  detail: LeaderboardDetail | undefined;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{ close: []; retry: [] }>();

const dialog = ref<HTMLElement | null>(null);
const isOpen = computed(() => props.open);
useModalA11y(dialog, isOpen, () => emit('close'));

const numberFormat = new Intl.NumberFormat('de-AT');
const accuracy = computed(() => {
  const value = props.detail?.accuracy;
  return value === null || value === undefined ? '—' : `${numberFormat.format(value)} %`;
});
</script>

<template>
  <Teleport to="body">
    <transition name="leader-modal">
      <div v-if="isOpen" class="leader-detail__backdrop" @click.self="$emit('close')">
        <section
          ref="dialog"
          class="leader-detail"
          role="dialog"
          aria-modal="true"
          :aria-label="detail ? `Details zu ${detail.nickname}` : 'Details werden geladen'"
          tabindex="-1"
        >
          <header class="leader-detail__header">
            <div>
              <h2>{{ detail?.nickname ?? 'Details' }}</h2>
              <span>Statistik</span>
            </div>
            <button type="button" class="leader-detail__close" aria-label="Schließen" @click="$emit('close')">
              <X aria-hidden="true" />
            </button>
          </header>

          <template v-if="detail">
            <div class="leader-detail__content">
              <div class="leader-detail__summary">
                <article>
                  <span><Target aria-hidden="true" /> Aufgaben</span>
                  <strong>{{ numberFormat.format(detail.totalPracticed) }}</strong>
                </article>
                <article>
                  <span><Trophy aria-hidden="true" /> Punkte</span>
                  <strong>{{ numberFormat.format(detail.totalScore) }}</strong>
                </article>
              </div>

              <section class="leader-detail__section">
                <h3>Zeitraum</h3>
                <div class="leader-detail__periods">
                  <div>
                    <span><CalendarDays aria-hidden="true" /> Heute</span>
                    <strong>{{ numberFormat.format(detail.todayPracticed) }}</strong>
                    <small>{{ numberFormat.format(detail.todayScore) }} Punkte</small>
                  </div>
                  <div>
                    <span><CalendarDays aria-hidden="true" /> Diese Woche</span>
                    <strong>{{ numberFormat.format(detail.weekPracticed) }}</strong>
                    <small>{{ numberFormat.format(detail.weekScore) }} Punkte</small>
                  </div>
                </div>
              </section>

              <section class="leader-detail__section">
                <h3>Lösungsquote</h3>
                <div class="leader-detail__accuracy">
                  <div>
                    <span><CheckCircle2 aria-hidden="true" /> Richtige Antworten</span>
                    <strong>
                      {{ numberFormat.format(detail.correctAnswers) }}
                      <small>von {{ numberFormat.format(detail.totalScore) }}</small>
                    </strong>
                  </div>
                  <b>{{ accuracy }}</b>
                </div>
              </section>
            </div>

            <footer class="leader-detail__footer">
              <QButton variant="secondary" @click="$emit('close')">Schließen</QButton>
            </footer>
          </template>

          <div v-else-if="loading" class="leader-detail__loading" role="status">
            Wird geladen …
          </div>

          <div v-else-if="error" class="leader-detail__error" role="alert">
            <p>{{ error }}</p>
            <QButton variant="secondary" @click="$emit('retry')">Erneut versuchen</QButton>
          </div>
        </section>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.leader-detail__backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(12, 13, 10, 0.62);
  -webkit-backdrop-filter: var(--q-backdrop-filter);
  backdrop-filter: var(--q-backdrop-filter);
}

.leader-detail {
  width: min(460px, 100%);
  max-height: min(760px, calc(100dvh - 36px));
  overflow-y: auto;
  border: 1px solid var(--q-border-2);
  border-radius: 14px;
  background: var(--q-card);
  color: var(--q-ink);
  box-shadow: var(--q-shadow-modal);
}

.leader-detail:focus-visible {
  outline: none;
}

.leader-detail__header {
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--q-border);
}

.leader-detail__header h2 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--q-ink);
  font-size: 21px;
  line-height: 1.2;
  letter-spacing: -0.025em;
}

.leader-detail__header span,
.leader-detail__section h3 {
  color: var(--q-faint);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.leader-detail__close {
  width: 36px;
  height: 36px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--q-mut);
  cursor: pointer;
}

.leader-detail__close svg {
  width: 19px;
  height: 19px;
}

.leader-detail__close:hover {
  background: var(--q-panel-2);
  color: var(--q-ink);
}

.leader-detail__close:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}

.leader-detail__content {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 20px;
}

.leader-detail__summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.leader-detail__summary article {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  background: var(--q-panel);
}

.leader-detail__summary span,
.leader-detail__periods span,
.leader-detail__accuracy span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--q-mut);
  font-size: 10.5px;
  font-weight: 650;
}

.leader-detail__summary svg,
.leader-detail__periods svg,
.leader-detail__accuracy svg {
  width: 14px;
  height: 14px;
  color: var(--q-accent-strong);
}

.leader-detail__summary strong {
  display: block;
  margin-top: 9px;
  font-size: 25px;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
}

.leader-detail__section h3 {
  margin: 0 0 9px 2px;
}

.leader-detail__periods {
  overflow: hidden;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  background: var(--q-panel);
}

.leader-detail__periods > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 14px;
  min-height: 58px;
  padding: 12px 14px;
}

.leader-detail__periods > div + div {
  border-top: 1px solid var(--q-border);
}

.leader-detail__periods strong {
  color: var(--q-accent-strong);
  font-size: 19px;
  font-variant-numeric: tabular-nums;
}

.leader-detail__periods small {
  min-width: 70px;
  color: var(--q-mut);
  font-size: 11px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.leader-detail__accuracy {
  min-height: 78px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 15px;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  background: var(--q-panel);
}

.leader-detail__accuracy strong {
  display: block;
  margin-top: 7px;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.leader-detail__accuracy strong small {
  color: var(--q-mut);
  font-size: 11px;
  font-weight: 500;
}

.leader-detail__accuracy b {
  color: var(--q-accent-strong);
  font-size: 28px;
  letter-spacing: -0.04em;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.leader-detail__footer {
  padding: 13px 20px;
  border-top: 1px solid var(--q-border);
}

.leader-detail__footer :deep(.q-btn) {
  width: 100%;
}

.leader-detail__loading {
  padding: 80px 20px;
  color: var(--q-mut);
  font-size: 13px;
  text-align: center;
}

.leader-detail__error {
  min-height: 220px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 16px;
  padding: 32px 20px;
  text-align: center;
}

.leader-detail__error p {
  margin: 0;
  color: var(--q-err-text);
  font-size: 13px;
  font-weight: 650;
}

.leader-modal-enter-active,
.leader-modal-leave-active {
  transition: opacity 160ms ease;
}

.leader-modal-enter-active .leader-detail,
.leader-modal-leave-active .leader-detail {
  transition: transform 180ms ease, opacity 160ms ease;
}

.leader-modal-enter-from,
.leader-modal-leave-to {
  opacity: 0;
}

.leader-modal-enter-from .leader-detail,
.leader-modal-leave-to .leader-detail {
  opacity: 0;
  transform: translateY(8px) scale(0.985);
}

@media (max-width: 520px) {
  .leader-detail__backdrop {
    align-items: end;
    padding: 0;
  }

  .leader-detail {
    width: 100%;
    max-height: 88dvh;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 16px 16px 0 0;
  }

  .leader-detail__content {
    padding: 16px;
  }

  .leader-detail__periods > div {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .leader-detail__periods small {
    grid-column: 1 / -1;
    margin-top: -6px;
    text-align: left;
  }

  .leader-modal-enter-from .leader-detail,
  .leader-modal-leave-to .leader-detail {
    transform: translateY(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .leader-modal-enter-active,
  .leader-modal-leave-active,
  .leader-modal-enter-active .leader-detail,
  .leader-modal-leave-active .leader-detail {
    transition: none;
  }
}
</style>
