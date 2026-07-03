<script setup lang="ts">
/**
 * App shell: sidebar navigation on desktop, bottom tab bar on mobile
 * (prototype 3a / 5a). Practice routes (meta.focus) render without the
 * navigation chrome. The sync-conflict dialog mounts globally.
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { provideAssetResolver } from '@qed2/ui';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useProgressStore } from './stores/progress.js';
import ConflictDialog from './routes/ConflictDialog.vue';

const route = useRoute();
const app = useAppStore();
const auth = useAuthStore();
const progress = useProgressStore();

provideAssetResolver((src) => app.assetUrl(src));

const focusMode = computed(() => route.meta.focus === true);

const navItems = [
  { to: '/', label: 'Heute', icon: '◈' },
  { to: '/aufgaben', label: 'Aufgaben', icon: '▤' },
  { to: '/fortschritt', label: 'Fortschritt', icon: '▨' },
  { to: '/einstellungen', label: 'Einstellungen', icon: '⚙' },
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
            v-for="item in navItems"
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
          <RouterLink to="/anmelden" class="app__guest-btn">Anmelden</RouterLink>
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
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="app__tab"
          :class="{ 'app__tab--active': isActive(item.to) }"
        >
          <span class="app__tab-icon" aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </template>

    <main class="app__main" :class="{ 'app__main--focus': focusMode }">
      <RouterView />
    </main>

    <ConflictDialog />
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
  text-align: center;
  border: 1px solid var(--q-btn-border);
  background: var(--q-panel);
  color: var(--q-ink);
  font-weight: 600;
  font-size: 12px;
  padding: 8px;
  border-radius: 7px;
  text-decoration: none;
}

/* bottom tab bar (mobile) */
.app__tabbar {
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
  }
  .app__tab--active {
    color: var(--q-accent-strong);
    font-weight: 700;
  }
  .app__tab-icon {
    font-size: 18px;
  }
  .app__main:not(.app__main--focus) {
    padding-bottom: 84px;
  }
}
</style>
