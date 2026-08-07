import { createRouter, createWebHistory } from 'vue-router';
import type { LocationQuery, RouteLocationRaw } from 'vue-router';
import { ports } from './services.js';

const SETTINGS_ROUTE: RouteLocationRaw = { name: 'settings', replace: true };
const DESKTOP_ROUTE: RouteLocationRaw = { name: 'desktop', replace: true };
const DESKTOP_UPDATES_ROUTE: RouteLocationRaw = { name: 'desktop-updates', replace: true };
const DESKTOP_NODE_ROUTE: RouteLocationRaw = { name: 'desktop-node', replace: true };

function isDesktopToolQuery(query: LocationQuery): boolean {
  return (
    query.section === 'desktop' &&
    (query.desktopWindow === 'updates' || query.desktopWindow === 'node')
  );
}

/**
 * Keep the native control centre out of the ordinary Web/PWA route graph at
 * navigation time. The guard runs before the lazy view is resolved, so a Web
 * session neither renders nor briefly flashes the Desktop surface.
 */
export function desktopCapabilityRedirect(): true | RouteLocationRaw {
  return ports.shell.capabilities.desktop ? true : SETTINGS_ROUTE;
}

/**
 * Electron 2.0 preview shipped tool-window URLs under /settings. Translate
 * those bookmarks to the dedicated routes before Settings renders. Malformed
 * or Web-authored desktopWindow queries fail back to Settings.
 */
export function legacyDesktopSettingsRedirect(query: LocationQuery): true | RouteLocationRaw {
  const hasDesktopQuery = query.section === 'desktop' || query.desktopWindow !== undefined;
  if (!hasDesktopQuery) return true;
  if (!ports.shell.capabilities.desktop) return SETTINGS_ROUTE;
  if (isDesktopToolQuery(query)) {
    return query.desktopWindow === 'updates' ? DESKTOP_UPDATES_ROUTE : DESKTOP_NODE_ROUTE;
  }
  return query.desktopWindow === undefined ? DESKTOP_ROUTE : SETTINGS_ROUTE;
}

/**
 * Route views are lazy — keeps the initial PWA shell light.
 * Paths are English (stable, shareable URLs); the v1 German paths redirect.
 * meta.focus: practice runs in a distraction-free full-screen chrome
 * (own top bar, no navigation shell — prototype 1b).
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  // New pages open at the top; back/forward restores where the user was.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 };
  },
  routes: [
    { path: '/', name: 'home', component: () => import('./routes/HomeView.vue') },
    {
      path: '/practice',
      name: 'practice',
      component: () => import('./routes/PracticeView.vue'),
      meta: { focus: true },
    },
    { path: '/questions', name: 'browse', component: () => import('./routes/BrowseView.vue') },
    { path: '/progress', name: 'progress', component: () => import('./routes/ProgressView.vue') },
    { path: '/history', name: 'history', component: () => import('./routes/HistoryView.vue') },
    { path: '/leaderboard', name: 'leaderboard', component: () => import('./routes/LeaderboardView.vue') },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./routes/SettingsView.vue'),
      beforeEnter: (to) => legacyDesktopSettingsRedirect(to.query),
    },
    {
      path: '/desktop',
      name: 'desktop',
      component: () => import('./routes/DesktopView.vue'),
      props: { panel: 'overview' },
      beforeEnter: desktopCapabilityRedirect,
    },
    {
      path: '/desktop/updates',
      name: 'desktop-updates',
      component: () => import('./routes/DesktopView.vue'),
      props: { panel: 'updates' },
      beforeEnter: desktopCapabilityRedirect,
    },
    {
      path: '/desktop/node',
      name: 'desktop-node',
      component: () => import('./routes/DesktopView.vue'),
      props: { panel: 'node' },
      beforeEnter: desktopCapabilityRedirect,
    },
    // Legacy German paths (v1) — permanent client-side redirects.
    { path: '/ueben', redirect: '/practice' },
    { path: '/aufgaben', redirect: '/questions' },
    { path: '/fortschritt', redirect: '/progress' },
    { path: '/einstellungen', redirect: '/settings' },
    // Auth is a modal now (grading supplement §10) — the old page goes home.
    { path: '/anmelden', redirect: '/' },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
