<script setup lang="ts">
import { useI18n } from '../i18n.js';

import { computed, ref } from 'vue';
import { CalendarCheck2, CalendarRange, CheckCircle2, Target, Trophy } from 'lucide-vue-next';
import type { LeaderboardDetail } from '@qed2/core-logic';
import QButton from '../shared/QButton.vue';
import QIconButton from '../shared/QIconButton.vue';
import QLoadingPanel from '../shared/QLoadingPanel.vue';
import { useModalA11y } from '../shared/useModalA11y.js';

const { t, formatNumber } = useI18n();


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

const accuracy = computed(() => {
  const value = props.detail?.accuracy;
  return value === null || value === undefined ? '—' : `${formatNumber(value)} %`;
});
</script>

<template>
  <Teleport to="body">
    <transition name="leader-modal">
      <div v-if="isOpen" class="leader-detail__backdrop q-modal-backdrop" @click.self="$emit('close')">
        <section
          ref="dialog"
          class="leader-detail"
          role="dialog"
          aria-modal="true"
          :aria-label="detail ? t('Details zu {name}', { name: detail.nickname }) : t(loading ? 'Details werden geladen' : 'Leaderboard')"
          :aria-busy="loading"
          tabindex="-1"
        >
          <header class="leader-detail__header">
            <h2>{{ detail?.nickname ?? 'Details' }}</h2>
            <QIconButton :aria-label="t('Schließen')" @click="$emit('close')" />
          </header>

          <template v-if="detail">
            <div class="leader-detail__content">
              <div class="leader-detail__summary">
                <article>
                  <span><Target aria-hidden="true" /> {{ t('Aufgaben') }}</span>
                  <strong>{{ formatNumber(detail.totalPracticed) }}</strong>
                </article>
                <article>
                  <span><Trophy aria-hidden="true" /> {{ t('Punkte') }}</span>
                  <strong>{{ formatNumber(detail.totalScore) }}</strong>
                </article>
              </div>

              <section class="leader-detail__section">
                <h3>{{ t('Zeitraum') }}</h3>
                <div class="leader-detail__periods">
                  <div>
                    <span><CalendarCheck2 aria-hidden="true" /> {{ t('Heute') }}</span>
                    <strong>{{ formatNumber(detail.todayPracticed) }}</strong>
                    <small>{{ formatNumber(detail.todayScore) }} {{ t('Punkte') }}</small>
                  </div>
                  <div>
                    <span><CalendarRange aria-hidden="true" /> {{ t('Diese Woche') }}</span>
                    <strong>{{ formatNumber(detail.weekPracticed) }}</strong>
                    <small>{{ formatNumber(detail.weekScore) }} {{ t('Punkte') }}</small>
                  </div>
                </div>
              </section>

              <section class="leader-detail__section">
                <h3>{{ t('Lösungsquote') }}</h3>
                <div class="leader-detail__accuracy">
                  <div>
                    <span><CheckCircle2 aria-hidden="true" /> {{ t('Richtige Antworten') }}</span>
                    <strong>
                      {{ formatNumber(detail.correctAnswers) }}
                      <small>{{ t('von') }} {{ formatNumber(detail.totalScore) }}</small>
                    </strong>
                  </div>
                  <b>{{ accuracy }}</b>
                </div>
              </section>
            </div>

            <footer class="leader-detail__footer">
              <QButton variant="secondary" @click="$emit('close')">{{ t('Schließen') }}</QButton>
            </footer>
          </template>

          <QLoadingPanel v-else-if="loading" bare class="leader-detail__loading" />

          <div v-else-if="error" class="leader-detail__error" role="alert">
            <p>{{ error }}</p>
            <QButton variant="secondary" @click="$emit('retry')">{{ t('Erneut versuchen') }}</QButton>
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
  padding: 16px;
  background: rgba(12, 13, 10, 0.62);
}

.leader-detail {
  width: min(460px, 100%);
  max-height: min(760px, calc(100dvh - 32px));
  overflow-y: auto;
  border: 1px solid var(--q-border-2);
  border-radius: var(--q-radius-dialog);
  background: var(--q-card);
  color: var(--q-ink);
  box-shadow: var(--q-shadow-modal);
}

.leader-detail:focus-visible {
  outline: none;
}

.leader-detail__header {
  min-height: 76px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border-bottom: 1px solid var(--q-border);
}

.leader-detail__header h2 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--q-ink);
  font-size: var(--q-font-title);
  line-height: 1.2;
  letter-spacing: -0.025em;
}

.leader-detail__section h3 {
  color: var(--q-mut);
  font-size: var(--q-font-ui);
  font-weight: 600;
}

.leader-detail__content {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
}

.leader-detail__summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.leader-detail__summary article {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-control);
  background: var(--q-panel);
}

.leader-detail__summary span,
.leader-detail__periods span,
.leader-detail__accuracy span {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--q-mut);
  font-size: var(--q-font-small);
  font-weight: 650;
}

.leader-detail__summary svg,
.leader-detail__periods svg,
.leader-detail__accuracy svg {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--q-accent-strong);
}

.leader-detail__summary strong {
  display: block;
  margin-top: 8px;
  font-size: clamp(var(--q-font-title), 6vw, 28px);
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

.leader-detail__section h3 {
  margin: 0 0 8px;
}

.leader-detail__periods {
  overflow: hidden;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-control);
  background: var(--q-panel);
}

.leader-detail__periods > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 12px;
}

.leader-detail__periods > div + div {
  border-top: 1px solid var(--q-border);
}

.leader-detail__periods strong {
  color: var(--q-accent-strong);
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}

.leader-detail__periods small {
  color: var(--q-mut);
  font-size: var(--q-font-small);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.leader-detail__accuracy {
  min-height: 80px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-control);
  background: var(--q-panel);
}

.leader-detail__accuracy strong {
  display: block;
  margin-top: 8px;
  font-size: var(--q-font-ui);
  font-variant-numeric: tabular-nums;
}

.leader-detail__accuracy strong small {
  color: var(--q-mut);
  font-size: var(--q-font-small);
  font-weight: 500;
}

.leader-detail__accuracy b {
  color: var(--q-accent-strong);
  font-size: 28px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.leader-detail__footer {
  padding: 16px 24px;
  border-top: 1px solid var(--q-border);
}

.leader-detail__footer :deep(.q-btn) {
  width: 100%;
}

.leader-detail__loading {
  min-height: 220px;
  justify-content: center;
}

.leader-detail__error {
  min-height: 220px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 16px;
  padding: 32px 24px;
  text-align: center;
}

.leader-detail__error p {
  margin: 0;
  color: var(--q-err-text);
  font-size: var(--q-font-ui);
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
    border-radius: var(--q-radius-dialog) var(--q-radius-dialog) 0 0;
  }

  .leader-detail__content {
    padding: 16px;
  }

  .leader-detail__periods > div {
    gap: 8px;
  }

  .leader-detail__footer {
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
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
