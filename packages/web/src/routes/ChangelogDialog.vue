<script setup lang="ts">
/**
 * Release notes dialog — used both for "what changed while you were away"
 * (opened automatically after an update) and for the full history from the
 * settings page. Same list, different length.
 *
 * It renders SEVERAL versions, because skipping a release is normal: the app
 * updates itself in the background and a fortnight between sessions can cover
 * three of them. Showing only the newest quietly threw the rest away.
 */
import { computed, ref } from 'vue';
import { MarkdownView, QButton, useModalA11y } from '@qed2/ui';

import { useUiStore } from '../stores/ui.js';

const ui = useUiStore();

const card = ref<HTMLElement | null>(null);
useModalA11y(card, computed(() => ui.changelogOpen), () => ui.closeChangelog());

/** One version is an announcement; several is a history. */
const many = computed(() => ui.changelogShown.length > 1);
const title = computed(() => (many.value ? 'Änderungen' : 'Was ist neu'));

/** de-AT reading order for a machine date, without pulling in a formatter. */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        v-if="ui.changelogOpen"
        class="clog q-modal-scrim q-modal-backdrop"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <div ref="card" class="clog__card">
          <div class="clog__head">
            <span class="clog__spark" aria-hidden="true">✦</span>
            <div class="clog__title">{{ title }}</div>
          </div>
          <div class="clog__body">
            <section v-for="entry in ui.changelogShown" :key="entry.version" class="clog__entry">
              <div class="clog__entry-head">
                <span class="clog__version">{{ entry.version }}</span>
                <span v-if="entry.draft" class="clog__draft">Entwurf</span>
                <span class="clog__date">{{ formatDate(entry.date) }}</span>
              </div>
              <MarkdownView :source="entry.body" />
            </section>
          </div>
          <div class="clog__footer">
            <QButton @click="ui.closeChangelog()">Verstanden</QButton>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.clog__card {
  width: 100%;
  max-width: 480px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--q-card);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
  overflow: hidden;
}
.clog__head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 20px 24px 12px;
}
.clog__spark {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--q-chip-bg);
  color: var(--q-accent-strong);
  display: grid;
  place-items: center;
  font-size: 15px;
  flex: none;
}
.clog__title {
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.01em;
}
.clog__body {
  padding: 4px 24px 8px;
  overflow-y: auto;
}

/* Versions need a visible seam; without one a three-release catch-up reads as
 * one long, self-contradicting note. */
.clog__entry + .clog__entry {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--q-border);
}
.clog__entry-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.clog__version {
  font: 800 13px 'Public Sans', system-ui, sans-serif;
  letter-spacing: -0.01em;
  color: var(--q-ink);
}
.clog__date {
  margin-left: auto;
  font-size: 11px;
  color: var(--q-faint);
  font-variant-numeric: tabular-nums;
}
.clog__draft {
  font: 700 9.5px 'Public Sans', system-ui, sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--q-neutral-bg);
  border: 1px solid var(--q-neutral-border);
  color: var(--q-neutral);
}
/* The body's own first heading sits right under the version line. */
.clog__entry :deep(h3:first-child) {
  margin-top: 0;
}

.clog__footer {
  display: flex;
  justify-content: flex-end;
  padding: 14px 24px 18px;
  border-top: 1px solid var(--q-border);
  margin-top: 8px;
}
</style>
