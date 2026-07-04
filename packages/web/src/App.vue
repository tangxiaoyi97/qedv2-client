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
import { Calendar, Play, ListTodo, History, LineChart, Settings, UserCircle } from 'lucide-vue-next';
import { useAppStore } from './stores/app.js';
import { useAuthStore } from './stores/auth.js';
import { useProgressStore } from './stores/progress.js';
import { useUiStore } from './stores/ui.js';
import ConflictDialog from './routes/ConflictDialog.vue';
import AuthModal from './routes/AuthModal.vue';
import ArchiveChoiceDialog from './routes/ArchiveChoiceDialog.vue';
import ChangelogDialog from './routes/ChangelogDialog.vue';

const route = useRoute();
const app = useAppStore();
const auth = useAuthStore();
const progress = useProgressStore();
const ui = useUiStore();

provideAssetResolver((src) => app.assetUrl(src));

const focusMode = computed(() => route.meta.focus === true);

/** Two practice entries, visually grouped (supplement §7). */
const practiceItems = [
  { to: '/practice', label: 'Intelligent üben', icon: Play, title: 'FSRS-Empfehlungen' },
  { to: '/questions', label: 'Aufgaben', icon: ListTodo, title: 'Selbst Aufgaben auswählen' },
] as const;

const otherItems = [
  { to: '/history', label: 'Verlauf', icon: History },
  { to: '/progress', label: 'Fortschritt', icon: LineChart },
  { to: '/settings', label: 'Einstellungen', icon: Settings },
] as const;

/** Mobile tab bar — 5 slots; Einstellungen via the fixed gear button. */
const tabItems = [
  { to: '/', label: 'Heute', icon: Calendar },
  { to: '/practice', label: 'Üben', icon: Play },
  { to: '/questions', label: 'Aufgaben', icon: ListTodo },
  { to: '/history', label: 'Verlauf', icon: History },
  { to: '/progress', label: 'Fortschritt', icon: LineChart },
] as const;

function isActive(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path.startsWith(to);
}
</script>

<template>
  <div class="app q-app">
    <aside class="app__sidebar" :class="{ 'app__sidebar--hidden': focusMode }">
        <div class="app__logo">QED<span class="app__logo-accent">2</span></div>
        <nav class="app__nav">
          <RouterLink
            to="/"
            class="app__nav-item"
            :class="{ 'app__nav-item--active': isActive('/') }"
          >
            <Calendar class="app__nav-icon" aria-hidden="true" />
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
            <component :is="item.icon" class="app__nav-icon" aria-hidden="true" />
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
            <component :is="item.icon" class="app__nav-icon" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>
        <div v-if="!auth.isLoggedIn" class="app__guest-card">
          <div class="app__guest-header">
            <UserCircle class="app__guest-avatar" aria-hidden="true" />
            <div class="app__guest-info">
              <div class="app__guest-title">Als Gast unterwegs</div>
              <div class="app__guest-text">Lokal gespeichert</div>
            </div>
          </div>
          <button type="button" class="app__guest-btn" @click="ui.openAuthModal()">Anmelden</button>
        </div>
        <div v-else class="app__guest-card">
          <div class="app__guest-header">
            <UserCircle class="app__guest-avatar" aria-hidden="true" />
            <div class="app__guest-info">
              <div class="app__guest-title">{{ auth.username }}</div>
              <div class="app__guest-text">
                <template v-if="progress.syncStatus.state === 'synced'">✓ Synchronisiert</template>
                <template v-else-if="progress.syncStatus.state === 'syncing'">⟳ Sync …</template>
                <template v-else-if="progress.syncStatus.state === 'offline'">Offline</template>
                <template v-else-if="progress.syncStatus.state === 'conflict'">⚠ Konflikt</template>
                <template v-else>Cloud aktiv</template>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <nav class="app__tabbar" :class="{ 'app__tabbar--hidden': focusMode }">
        <RouterLink
          v-for="item in tabItems"
          :key="item.to"
          :to="item.to"
          class="app__tab"
          :class="{ 'app__tab--active': isActive(item.to) }"
        >
          <component :is="item.icon" class="app__tab-icon" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <RouterLink to="/settings" class="app__gear" :class="{ 'app__gear--hidden': focusMode }" aria-label="Einstellungen" title="Einstellungen">
        <Settings aria-hidden="true" />
      </RouterLink>

    <main class="app__main">
      <RouterView v-slot="{ Component }">
        <transition name="page-fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </RouterView>
    </main>

    <ConflictDialog />
    <AuthModal />
    <ArchiveChoiceDialog />
    <ChangelogDialog />
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
}

/* sidebar (desktop) */
.app__sidebar {
  width: var(--q-sidebar-width);
  flex: none;
  background: var(--q-panel);
  border-right: 1px solid var(--q-border);
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
  position: sticky;
  top: 0;
  height: 100vh;
  transition: margin-left var(--q-transition-normal), opacity var(--q-transition-normal);
}
.app__sidebar--hidden {
  margin-left: calc(-1 * var(--q-sidebar-width));
  opacity: 0;
  pointer-events: none;
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
  transition: all var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .app__nav-item:hover {
    background: linear-gradient(135deg, var(--q-panel-2), var(--q-panel));
    color: var(--q-ink);
  }
}
.app__nav-item:active {
  background: var(--q-panel-2);
  opacity: 0.8;
  transform: scale(0.98);
}
.app__nav-item--active,
.app__nav-item--active:hover {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-weight: 700;
}
.app__nav-icon {
  width: 18px;
  height: 18px;
  stroke-width: 2.2px;
  flex-shrink: 0;
}
.app__guest-card {
  margin-top: auto;
  padding: 10px;
  background: var(--q-panel-2);
  border-radius: 12px;
  border: 1px solid var(--q-border-soft);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.app__guest-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.app__guest-avatar {
  width: 32px;
  height: 32px;
  color: var(--q-mut-2);
  flex-shrink: 0;
  stroke-width: 1.5;
}
.app__guest-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}
.app__guest-title {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--q-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.app__guest-text {
  font-size: 11px;
  color: var(--q-mut-2);
  margin-top: 3px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  transition: all var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .app__guest-btn:hover {
    background: linear-gradient(135deg, var(--q-panel-2), var(--q-panel));
    transform: scale(1.02);
  }
}
.app__guest-btn:active {
  background: var(--q-panel-2);
  transform: scale(0.97);
}

/* bottom tab bar + gear (mobile only) */
.app__tabbar,
.app__gear {
  display: none;
}

.app__main {
  flex: 1;
  min-width: 0;
  transition: padding var(--q-transition-normal);
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
    transition: transform var(--q-transition-normal);
  }
  .app__tabbar--hidden {
    transform: translateY(100%);
    pointer-events: none;
  }
  .app__tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--q-disabled);
    font-size: 10.5px;
    font-weight: 500;
    text-decoration: none;
    padding-top: 2px;
    min-width: 0;
    min-height: 48px;
    transition: color var(--q-transition-fast), transform 0.1s ease;
  }
  .app__tab:active {
    background: rgba(0, 0, 0, 0.03);
    border-radius: 6px;
    transform: scale(0.95);
  }
  .app__tab--active {
    color: var(--q-accent-strong);
    font-weight: 700;
  }
  .app__tab-icon {
    width: 22px;
    height: 22px;
    stroke-width: 2.2px;
  }
  /* Einstellungen on mobile: fixed round gear, top-right (safe-area aware). */
  .app__gear {
    display: grid;
    place-items: center;
    position: fixed;
    top: calc(env(safe-area-inset-top) + 10px);
    right: 12px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--q-card);
    border: 1px solid var(--q-border);
    color: var(--q-mut);
    text-decoration: none;
    z-index: 40;
    transition: transform 0.1s ease, background 0.1s ease, opacity var(--q-transition-normal);
  }
  .app__gear--hidden {
    opacity: 0;
    pointer-events: none;
  }
  .app__gear svg {
    width: 20px;
    height: 20px;
    stroke-width: 2.2px;
  }
  .app__gear:active {
    background: var(--q-panel-2);
    transform: scale(0.92);
  }
  .app__main:not(.app__main--focus) {
    padding-bottom: 84px;
  }
  /* we override padding via focusMode class indirectly or just use body padding, but 
     since app__main--focus is removed, let's keep padding-bottom dynamic via a wrapper class?
     Wait, I can just do .app__tabbar--hidden ~ .app__main { padding-bottom: 0 } */
  .app__main {
    padding-bottom: 84px;
  }
  .app__tabbar--hidden ~ .app__main {
    padding-bottom: 0;
  }
}
</style>
