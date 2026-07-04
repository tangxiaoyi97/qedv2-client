<script setup lang="ts">
/**
 * App shell: sidebar navigation on desktop, bottom tab bar on mobile
 * (prototype 3a / 5a). The sidebar separates the two practice modes
 * (supplement §7): „Intelligent üben" (FSRS-driven) vs „Aufgaben"
 * (user-picked). Practice routes (meta.focus) render without the
 * navigation chrome. Sync-conflict dialog + auth modal mount globally.
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { provideAssetResolver } from '@qed2/ui';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useProgressStore } from './stores/progress.js';
import { useUiStore } from './stores/ui.js';
import ConflictDialog from './routes/ConflictDialog.vue';
import AuthModal from './routes/AuthModal.vue';
import ArchiveChoiceDialog from './routes/ArchiveChoiceDialog.vue';

const route = useRoute();
const app = useAppStore();
const auth = useAuthStore();
const progress = useProgressStore();
const ui = useUiStore();

provideAssetResolver((src) => app.assetUrl(src));

const focusMode = computed(() => route.meta.focus === true);

/** Two practice entries, visually grouped (supplement §7). */
const practiceItems = [
  { to: '/practice', label: 'Intelligent üben', icon: '▶', title: 'FSRS-Empfehlungen' },
  { to: '/questions', label: 'Aufgaben', icon: '▤', title: 'Selbst Aufgaben auswählen' },
] as const;

const otherItems = [
  { to: '/history', label: 'Verlauf', icon: '≡' },
  { to: '/progress', label: 'Fortschritt', icon: '▨' },
  { to: '/settings', label: 'Einstellungen', icon: '⚙' },
] as const;

/** Mobile tab bar — 5 slots; Einstellungen via the fixed gear button. */
const tabItems = [
  { to: '/', label: 'Heute', icon: '◈' },
  { to: '/practice', label: 'Üben', icon: '▶' },
  { to: '/questions', label: 'Aufgaben', icon: '▤' },
  { to: '/history', label: 'Verlauf', icon: '≡' },
  { to: '/progress', label: 'Fortschritt', icon: '▨' },
] as const;

function isActive(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path.startsWith(to);
}
</script>

<template>
  <div class="app q-app">
    <template v-if="!focusMode">
      <aside class="app__sidebar">
        <div class="app__logo">QED<span class="app__logo-accent">2</span></div>
        <nav class="app__nav">
          <RouterLink
            to="/"
            class="app__nav-item"
            :class="{ 'app__nav-item--active': isActive('/') }"
          >
            <span class="app__nav-icon" aria-hidden="true">◈</span>
            <span>Heute</span>
          </RouterLink>

          <div class="app__nav-group" aria-hidden="true">Üben</div>
          <RouterLink
            v-for="item in practiceItems"
            :key="item.to"
            :to="item.to"
            class="app__nav-item"
            :class="{ 'app__nav-item--active': isActive(item.to) }"
            :title="item.title"
          >
            <span class="app__nav-icon" aria-hidden="true">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </RouterLink>

          <div class="app__nav-sep" aria-hidden="true" />
          <RouterLink
            v-for="item in otherItems"
            :key="item.to"
            :to="item.to"
            class="app__nav-item"
            :class="{ 'app__nav-item--active': isActive(item.to) }"
          >
            <span class="app__nav-icon" aria-hidden="true">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>
        <div v-if="!auth.isLoggedIn" class="app__guest-card">
          <div class="app__guest-title">Als Gast unterwegs</div>
          <div class="app__guest-text">Anmelden sichert deinen Fortschritt geräteübergreifend.</div>
          <button type="button" class="app__guest-btn" @click="ui.openAuthModal()">Anmelden</button>
        </div>
        <div v-else class="app__guest-card">
          <div class="app__guest-title">{{ auth.username }}</div>
          <div class="app__guest-text">
            <template v-if="progress.syncStatus.state === 'synced'">✓ Synchronisiert</template>
            <template v-else-if="progress.syncStatus.state === 'syncing'">⟳ Synchronisiere …</template>
            <template v-else-if="progress.syncStatus.state === 'offline'">Offline · lokal gespeichert</template>
            <template v-else-if="progress.syncStatus.state === 'conflict'">⚠ Konflikt — bitte wählen</template>
            <template v-else>Cloud-Sync aktiv</template>
          </div>
        </div>
      </aside>

      <nav class="app__tabbar">
        <RouterLink
          v-for="item in tabItems"
          :key="item.to"
          :to="item.to"
          class="app__tab"
          :class="{ 'app__tab--active': isActive(item.to) }"
        >
          <span class="app__tab-icon" aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <RouterLink to="/settings" class="app__gear" aria-label="Einstellungen" title="Einstellungen">
        <span aria-hidden="true">⚙</span>
      </RouterLink>
    </template>

    <main class="app__main" :class="{ 'app__main--focus': focusMode }">
      <RouterView />
    </main>

    <ConflictDialog />
    <AuthModal />
    <ArchiveChoiceDialog />
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
}

/* sidebar (desktop) */
.app__sidebar {
  width: 212px;
  flex: none;
  background: var(--q-panel);
  border-right: 1px solid var(--q-border);
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
  position: sticky;
  top: 0;
  height: 100vh;
}
.app__logo {
  font-weight: 800;
  font-size: 20px;
  letter-spacing: -0.02em;
  padding: 0 8px 18px;
}
.app__logo-accent {
  color: var(--q-accent);
}
.app__nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.app__nav-group {
  margin: 12px 0 3px;
  padding: 0 12px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.app__nav-sep {
  height: 1px;
  margin: 10px 8px;
  background: var(--q-border);
}
.app__nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 12px;
  border-radius: 9px;
  color: var(--q-mut);
  font-weight: 500;
  font-size: 13.5px;
  text-decoration: none;
}
.app__nav-item:hover {
  background: var(--q-panel-2);
}
.app__nav-item--active {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-weight: 700;
}
.app__nav-icon {
  font-size: 14px;
  width: 16px;
  text-align: center;
}
.app__guest-card {
  margin-top: auto;
  padding: 11px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 10px;
}
.app__guest-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 3px;
}
.app__guest-text {
  font-size: 11px;
  color: var(--q-mut-2);
  line-height: 1.4;
  margin-bottom: 9px;
}
.app__guest-btn {
  display: block;
  width: 100%;
  text-align: center;
  border: 1px solid var(--q-btn-border);
  background: var(--q-panel);
  color: var(--q-ink);
  font: 600 12px 'Public Sans', system-ui, sans-serif;
  padding: 8px;
  border-radius: 7px;
  cursor: pointer;
}
.app__guest-btn:hover {
  background: var(--q-panel-2);
}

/* bottom tab bar + gear (mobile only) */
.app__tabbar,
.app__gear {
  display: none;
}

.app__main {
  flex: 1;
  min-width: 0;
}
.app__main--focus {
  width: 100%;
}

@media (max-width: 899px) {
  .app__sidebar {
    display: none;
  }
  .app__tabbar {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: calc(64px + env(safe-area-inset-bottom));
    padding: 8px 8px env(safe-area-inset-bottom);
    background: var(--q-card);
    border-top: 1px solid var(--q-border);
    z-index: 40;
  }
  .app__tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    color: var(--q-disabled);
    font-size: 10.5px;
    font-weight: 500;
    text-decoration: none;
    padding-top: 2px;
    min-width: 0;
  }
  .app__tab--active {
    color: var(--q-accent-strong);
    font-weight: 700;
  }
  .app__tab-icon {
    font-size: 18px;
  }
  /* Einstellungen on mobile: fixed round gear, top-right (safe-area aware). */
  .app__gear {
    display: grid;
    place-items: center;
    position: fixed;
    top: calc(env(safe-area-inset-top) + 10px);
    right: 12px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--q-card);
    border: 1px solid var(--q-border);
    color: var(--q-mut);
    font-size: 16px;
    text-decoration: none;
    z-index: 40;
  }
  .app__main:not(.app__main--focus) {
    padding-bottom: 84px;
  }
}
</style>
