<script setup lang="ts">
import { useI18n } from '../i18n.js';
const { t, formatDate } = useI18n();

/**
 * Startseite „Heute" (prototype 3a) — the one-glance launchpad. Cards are
 * navigable teasers of their detail pages (Bewertung/Status → Fortschritt,
 * Zuletzt/Aktivität → Verlauf) and reuse the shared review components
 * (supplement §6/§8).
 */
import { computed, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { groupMasteryByCategory, type GradingOrUnseen } from '@qed2/core-logic';
import { ActivityHeatmap, GradingDistribution, GradingDot, MasteryBar, QButton } from '@qed2/ui';
import { ChevronRight } from 'lucide-vue-next';
import { useActivityStore } from '../stores/activity.js';
import { useAuthStore } from '../stores/auth.js';
import { useProgressStore } from '../stores/progress.js';
import { useUiStore } from '../stores/ui.js';
import { useSyncIndicator } from '../composables/useSyncIndicator.js';

const router = useRouter();
const auth = useAuthStore();
const activityStore = useActivityStore();
const progress = useProgressStore();
const ui = useUiStore();
const sync = useSyncIndicator();

/** Phones have no sidebar account card; this pill is its stand-in. */
function openAccount(): void {
  if (auth.isLoggedIn) go('/settings');
  else ui.openAuthModal();
}

/** Ticking clock so greeting/date roll over at midnight instead of going
 * stale in a long-lived PWA session. */
const now = ref(new Date());
const clock = setInterval(() => {
  now.value = new Date();
}, 60_000);
onUnmounted(() => clearInterval(clock));

const greeting = computed(() => {
  const h = now.value.getHours();
  return h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
});
const dateLine = computed(() =>
  formatDate(now.value, { weekday: 'long', day: 'numeric', month: 'long' }),
);

const categoryMastery = computed(() =>
  groupMasteryByCategory(progress.masteryEntries).filter((c) => c.count > 0),
);

const weakest = computed(() =>
  [...categoryMastery.value].sort((a, b) => a.mastery - b.mastery).slice(0, 2).map((c) => c.code),
);

const heroText = computed(() => {
  const due = progress.dueCount;
  const next = weakest.value.length > 0
    ? t('Neue Aufgaben · {areas}', { areas: weakest.value.join(' · ') })
    : t('Neue Aufgaben zum Einstieg');
  if (due === 0) return next;
  return t('{count} fällig · {next}', { count: due, next });
});

/** Relative day for the „Zuletzt" rows — text, never color/icon-only. */
function relativeDay(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) return t('heute');
  if (days === 1) return t('gestern');
  return t('vor {days} Tagen', { days });
}

const recent = computed(() =>
  [...progress.archive.content.perPart]
    .filter((p) => p.lastResult)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 3)
    .map((p) => ({
      partId: p.partId,
      grading: progress.partState.get(p.partId)?.grading ?? ('unseen' as const),
      day: relativeDay(p.updatedAt),
    })),
);

/** Guests use this device; accounts use the authoritative cloud activity. */
const activity = computed(() => activityStore.activity);
void activityStore.ensure(84, new Date());

function go(path: string): void {
  void router.push(path);
}

function openStatusFilter(state: GradingOrUnseen): void {
  void router.push({ path: '/questions', query: { grading: state } });
}

function openCategoryFilter(code: string): void {
  void router.push({ path: '/questions', query: { kat: code } });
}
</script>

<template>
  <div class="home q-page">
    <div class="home__header">
      <div class="home__heading">
        <h1 class="home__greeting q-page-title">{{ t(greeting) }} 👋</h1>
        <div class="home__date">{{ dateLine }}</div>
      </div>
      <button
        type="button"
        class="home__status"
        :data-tone="sync.tone"
        :aria-label="auth.isLoggedIn ? t('Synchronisierung: {status}', { status: t(sync.label) }) : t('Anmelden')"
        :title="t('Konto und Synchronisierung')"
        @click="openAccount"
      >
        <component :is="sync.icon" class="home__status-icon" :class="{ 'home__status-icon--busy': sync.busy }" aria-hidden="true" />
        <span class="home__status-label">{{ auth.isLoggedIn ? t(sync.label) : t('Anmelden') }}</span>
      </button>
    </div>

    <div class="home__hero">
      <div class="home__hero-body">
        <div class="home__hero-label">{{ t('Empfohlen') }}</div>
        <div class="home__hero-text">{{ t(heroText) }}</div>
      </div>
      <QButton class="home__hero-cta" @click="go('/practice')">{{ t('Starten →') }}</QButton>
    </div>

    <div class="home__cards">
      <div class="home__card">
        <div class="home__card-label">{{ t('Heute fällig') }}</div>
        <div class="home__big"><b>{{ progress.dueCount }}</b> <span>{{ t('Aufgaben') }}</span></div>
        <div class="home__card-rows">
          <div class="home__card-row"><span>{{ t('Bearbeitet gesamt') }}</span><b>{{ progress.practicedParts }}</b></div>
        </div>
      </div>

      <div
        class="home__card home__card--wide home__card--click q-pressable"
        role="link"
        tabindex="0"
        @click="go('/progress')"
        @keydown.enter.self="go('/progress')"
      >
        <div class="home__card-head">
          <div class="home__card-label">{{ t('Bewertung') }}</div>
          <ChevronRight class="home__card-link" aria-hidden="true" />
        </div>
        <div v-if="categoryMastery.length > 0" class="home__mastery">
          <button
            v-for="c in categoryMastery"
            :key="c.code"
            type="button"
            class="home__mastery-row"
            :title="t('Aufgaben mit {code} anzeigen', { code: c.code })"
            @click.stop="openCategoryFilter(c.code)"
          >
            <MasteryBar :code="c.code" :mastery="c.mastery" />
          </button>
        </div>
        <div v-else class="home__empty-note">{{ t('Noch keine Daten.') }}</div>
      </div>

      <div
        class="home__card home__card--click q-pressable"
        role="link"
        tabindex="0"
        @click="go('/history')"
        @keydown.enter.self="go('/history')"
      >
        <div class="home__card-head">
          <div class="home__card-label">{{ t('Zuletzt') }}</div>
          <ChevronRight class="home__card-link" aria-hidden="true" />
        </div>
        <div v-if="recent.length > 0" class="home__recent">
          <div v-for="r in recent" :key="r.partId" class="home__recent-row">
            <GradingDot :grading="r.grading" :size="14" />
            <span class="home__recent-id">{{ r.partId }}</span>
            <span class="home__recent-day">{{ t(r.day) }}</span>
          </div>
        </div>
        <div v-else class="home__empty-note">{{ t('Noch nichts geübt.') }}</div>
      </div>

      <div
        class="home__card home__card--click q-pressable"
        role="link"
        tabindex="0"
        @click="go('/history')"
        @keydown.enter.self="go('/history')"
      >
        <div class="home__card-head">
          <div class="home__card-label">{{ t('Aktivität') }}</div>
          <ChevronRight class="home__card-link" aria-hidden="true" />
        </div>
        <div
          v-if="activityStore.cloudIncompleteMessage"
          class="home__empty-note"
          :role="progress.attemptUploadStatus.state === 'error' ? 'alert' : 'status'"
        >
          {{ t(activityStore.cloudIncompleteMessage) }}
        </div>
        <div v-else-if="activityStore.loading" class="home__empty-note" role="status">
          {{ t('Aktivität wird geladen …') }}
        </div>
        <div v-else-if="activityStore.error" class="home__empty-note" role="alert">
          {{ t(activityStore.error) }}
        </div>
        <ActivityHeatmap v-else :data="activity" :weeks="12" />
      </div>

      <div
        class="home__card home__card--wide home__card--click q-pressable"
        role="link"
        tabindex="0"
        @click="go('/progress')"
        @keydown.enter.self="go('/progress')"
      >
        <div class="home__card-head">
          <div class="home__card-label">{{ t('Bewertung nach Status') }}</div>
          <ChevronRight class="home__card-link" aria-hidden="true" />
        </div>
        <GradingDistribution :counts="progress.gradingCounts" @click.stop @select="openStatusFilter" />
      </div>
    </div>

    <div v-if="!auth.isLoggedIn" class="home__guest">
      <QButton variant="ghost" @click="ui.openAuthModal()">{{ t('Anmelden') }}</QButton>
    </div>
  </div>
</template>

<style scoped>
.home {
  max-width: 860px;
}
.home__header {
  margin-bottom: 24px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--q-space-3);
}
.home__heading {
  min-width: 0;
}
/*
 * Account / sync pill. Only phones and narrow tablets show it — from 900px
 * the sidebar's account card carries the same reading (useSyncIndicator).
 */
.home__status {
  display: none;
  flex: none;
  align-items: center;
  gap: 6px;
  max-width: 48%;
  min-height: var(--q-touch-target);
  padding: 0 14px;
  border: 1px solid var(--q-border-2);
  border-radius: var(--q-radius-pill);
  background: var(--q-card);
  color: var(--q-mut);
  font: 700 var(--q-font-small) var(--q-font-family);
  cursor: pointer;
  transition: transform var(--q-transition-fast), background-color var(--q-transition-fast);
}
.home__status:active { transform: scale(0.97); background: var(--q-panel); }
.home__status[data-tone='ok'] { color: var(--q-ok-ink); }
.home__status[data-tone='warn'] { color: var(--q-part-ink); border-color: var(--q-part-border); }
.home__status[data-tone='error'] { color: var(--q-err-ink); border-color: var(--q-err-border); }
.home__status-icon { width: 16px; height: 16px; flex: none; }
.home__status-icon--busy { animation: home-status-spin 1.2s linear infinite; }
@keyframes home-status-spin { to { transform: rotate(360deg); } }
.home__status-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 899px) {
  .home__status { display: inline-flex; }
  /* The pill above is the sign-in entry on phones; don't offer it twice. */
  .home__guest { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .home__status-icon--busy { animation: none; }
}
.home__greeting {
  overflow-wrap: anywhere;
}
.home__date {
  font-size: var(--q-font-ui);
  color: var(--q-mut-2);
  margin-top: 2px;
}
.home__hero {
  background: var(--q-cta-card);
  border-radius: var(--q-radius-card);
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.home__hero-body {
  flex: 1;
  min-width: 0;
}
.home__hero-label {
  color: var(--q-cta-card-label);
  font-size: var(--q-font-small);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 7px;
}
.home__hero-text {
  color: var(--q-cta-card-text);
  font-size: var(--q-font-ui);
  line-height: 1.5;
}
.home__hero-cta {
  white-space: nowrap;
}
.home__cards {
  /* fixed 12-col grid — flex+min-width used to overflow into a squeezed
     single row (deformed dashboard); explicit spans place every card. */
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 14px;
}
.home__card {
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-card);
  padding: 16px;
  min-width: 0;
  grid-column: span 6;
}
.home__cards > .home__card:nth-child(1) {
  grid-column: span 4;
}
.home__cards > .home__card:nth-child(2) {
  grid-column: span 8;
}
.home__cards > .home__card:nth-child(5) {
  grid-column: span 12;
}
@media (max-width: 719px) {
  .home__cards > .home__card {
    grid-column: span 12 !important;
  }
}
.home__card--click {
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .home__card--click:hover {
    border-color: var(--q-accent);
  }
}
.home__card--click:active {
  border-color: var(--q-accent);
}
.home__card--click:focus-visible {
  border-color: var(--q-accent);
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
/* The label carries the head's bottom margin, so centre the chevron on the
 * label's own line box rather than on the baseline (it sat ~4px high). */
.home__card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.home__card-head .home__card-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home__card-label {
  font-size: var(--q-font-small);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  margin-bottom: 10px;
}
.home__card-link {
  width: 16px;
  height: 16px;
  margin-top: 1px;
  color: var(--q-accent-strong);
  flex: none;
}
.home__big {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.home__big b {
  font-weight: 800;
  font-size: var(--q-font-display);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.home__big span {
  font-size: var(--q-font-small);
  color: var(--q-mut-2);
}
.home__card-rows {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--q-font-small);
  color: var(--q-mut);
}
.home__card-row {
  display: flex;
  justify-content: space-between;
}
.home__mastery {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.home__mastery-row {
  display: block;
  width: 100%;
  min-height: var(--q-control-height);
  padding: 8px 6px;
  border: 1px solid transparent;
  border-radius: var(--q-radius-sm);
  background: none;
  color: inherit;
  cursor: pointer;
}
@media (max-width: 480px) {
  .home__header { margin-bottom: 18px; }
  .home__hero { padding: 16px; gap: 12px; }
  .home__hero-text { font-size: var(--q-font-small); }
  .home__cards { gap: 12px; }
  .home__card { padding: 14px; }
  .home__guest { padding: 0; background: transparent; border: none; }
}
@media (hover: hover) and (pointer: fine) {
  .home__mastery-row:hover {
    border-color: var(--q-accent);
    background: var(--q-panel);
  }
}
.home__mastery-row:focus-visible {
  border-color: var(--q-accent);
  background: var(--q-panel);
  outline: none;
}
.home__recent {
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-size: var(--q-font-small);
}
.home__recent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--q-mut);
}
.home__recent-id {
  font-family: var(--q-font-mono);
  font-size: var(--q-font-small);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home__recent-day {
  margin-left: auto;
  font-size: var(--q-font-small);
  color: var(--q-faint);
  white-space: nowrap;
}
.home__empty-note {
  font-size: var(--q-font-small);
  color: var(--q-faint);
}
.home__intro,
.home__guest {
  margin-top: 18px;
  padding: 13px 15px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: var(--q-radius-control);
  font-size: var(--q-font-ui);
  color: var(--q-mut-2);
  line-height: 1.55;
}
.home__guest-link {
  border: none;
  background: none;
  padding: 0;
  font: 600 var(--q-font-meta) var(--q-font-family);
  color: var(--q-accent-strong);
  cursor: pointer;
  text-decoration: underline;
}
</style>
