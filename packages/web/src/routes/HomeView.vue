<script setup lang="ts">
/** Startseite „Heute" (prototype 3a) — the one-glance launchpad. */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { competencyCategory } from '@qed2/core-logic';
import { MasteryBar, StateIcon } from '@qed2/ui';
import { useAuthStore } from '../stores/auth.js';
import { useProgressStore } from '../stores/progress.js';

const router = useRouter();
const auth = useAuthStore();
const progress = useProgressStore();

const greeting = computed(() => {
  const h = new Date().getHours();
  return h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
});
const dateLine = new Intl.DateTimeFormat('de-AT', { weekday: 'long', day: 'numeric', month: 'long' }).format(
  new Date(),
);

const CATEGORY_ORDER = ['AG', 'FA', 'AN', 'WS'] as const;

const categoryMastery = computed(() => {
  const groups = new Map<string, number[]>();
  for (const e of progress.masteryEntries) {
    const cat = competencyCategory(e.code);
    if (cat === 'other') continue;
    const list = groups.get(cat) ?? [];
    list.push(e.mastery);
    groups.set(cat, list);
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => {
    const list = groups.get(c)!;
    return { code: c, mastery: list.reduce((a, b) => a + b, 0) / list.length };
  });
});

const weakest = computed(() =>
  [...categoryMastery.value].sort((a, b) => a.mastery - b.mastery).slice(0, 2).map((c) => c.code),
);

const heroText = computed(() => {
  const due = progress.dueCount;
  const parts: string[] = [];
  parts.push(due === 1 ? '1 fällige Wiederholung' : `${due} fällige Wiederholungen`);
  if (weakest.value.length > 0) parts.push(`neue Aufgaben aus schwächeren Themen (${weakest.value.join(', ')})`);
  else parts.push('neue Aufgaben zum Einstieg');
  return parts.join(' + ') + '.';
});

const recent = computed(() =>
  [...progress.archive.content.perPart]
    .filter((p) => p.lastResult)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 3)
    .map((p) => ({
      partId: p.partId,
      state:
        p.lastResult!.correct ? ('correct' as const) : p.lastResult!.awardedPoints > 0 ? ('partial' as const) : ('incorrect' as const),
      points: p.lastResult!.awardedPoints,
    })),
);

const hasProgress = computed(() => progress.practicedParts > 0);
</script>

<template>
  <div class="home">
    <div class="home__header">
      <div>
        <h1 class="home__greeting">{{ greeting }} 👋</h1>
        <div class="home__date">{{ dateLine }} · Bereit für heute?</div>
      </div>
    </div>

    <div class="home__hero">
      <div class="home__hero-body">
        <div class="home__hero-label">Empfohlen für heute</div>
        <div class="home__hero-title">Intelligent üben</div>
        <div class="home__hero-text">{{ heroText }}</div>
      </div>
      <button type="button" class="home__hero-cta" @click="router.push('/ueben')">Sitzung starten →</button>
    </div>

    <div class="home__cards">
      <div class="home__card">
        <div class="home__card-label">Heute fällig</div>
        <div class="home__big"><b>{{ progress.dueCount }}</b> <span>Aufgaben</span></div>
        <div class="home__card-rows">
          <div class="home__card-row"><span>Bearbeitet gesamt</span><b>{{ progress.practicedParts }}</b></div>
        </div>
      </div>

      <div class="home__card home__card--wide">
        <div class="home__card-label">Beherrschung</div>
        <div v-if="categoryMastery.length > 0" class="home__mastery">
          <MasteryBar v-for="c in categoryMastery" :key="c.code" :code="c.code" :mastery="c.mastery" />
        </div>
        <div v-else class="home__empty-note">Noch keine Daten — starte deine erste Sitzung.</div>
      </div>

      <div class="home__card">
        <div class="home__card-label">Zuletzt</div>
        <div v-if="recent.length > 0" class="home__recent">
          <div v-for="r in recent" :key="r.partId" class="home__recent-row">
            <StateIcon :state="r.state" :size="16" />
            <span class="home__recent-id">{{ r.partId }}</span>
          </div>
        </div>
        <div v-else class="home__empty-note">Noch nichts geübt.</div>
      </div>
    </div>

    <div v-if="!hasProgress" class="home__intro">
      Willkommen bei QED2 — SRDP-Mathematik mit intelligenter Wiederholung. Starte oben eine Sitzung
      oder stöbere in den <RouterLink to="/aufgaben">Aufgaben</RouterLink>.
    </div>

    <div v-if="!auth.isLoggedIn" class="home__guest">
      Anmelden sichert deinen Fortschritt geräteübergreifend —
      <RouterLink to="/anmelden">jetzt anmelden</RouterLink>. Üben geht auch ohne.
    </div>
  </div>
</template>

<style scoped>
.home {
  max-width: 860px;
  margin: 0 auto;
  padding: 26px 20px 40px;
}
.home__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
}
.home__greeting {
  font-weight: 800;
  font-size: 23px;
  letter-spacing: -0.01em;
  margin: 0;
}
.home__date {
  font-size: 13px;
  color: var(--q-mut-2);
  margin-top: 2px;
}
.home__hero {
  background: var(--q-cta-card);
  border-radius: 14px;
  padding: 24px 26px;
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.home__hero-body {
  flex: 1;
  min-width: 220px;
}
.home__hero-label {
  color: var(--q-cta-card-label);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 7px;
}
.home__hero-title {
  color: #fff;
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin-bottom: 6px;
}
.home__hero-text {
  color: var(--q-cta-card-text);
  font-size: 13.5px;
  line-height: 1.5;
}
.home__hero-cta {
  border: none;
  background: var(--q-accent);
  color: #1a1a1a;
  font: 800 14.5px 'Public Sans', system-ui, sans-serif;
  padding: 14px 26px;
  border-radius: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.home__hero-cta:hover {
  filter: brightness(1.06);
}
.home__cards {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.home__card {
  flex: 1;
  min-width: 200px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
  padding: 16px;
}
.home__card--wide {
  flex: 1.3;
  min-width: 240px;
}
.home__card-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  margin-bottom: 10px;
}
.home__big {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.home__big b {
  font-weight: 800;
  font-size: 30px;
}
.home__big span {
  font-size: 12px;
  color: var(--q-mut-2);
}
.home__card-rows {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--q-mut);
}
.home__card-row {
  display: flex;
  justify-content: space-between;
}
.home__mastery {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.home__recent {
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-size: 12px;
}
.home__recent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--q-mut);
}
.home__recent-id {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
}
.home__empty-note {
  font-size: 12px;
  color: var(--q-faint);
}
.home__intro,
.home__guest {
  margin-top: 18px;
  padding: 13px 15px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  font-size: 12.5px;
  color: var(--q-mut-2);
  line-height: 1.55;
}
</style>
