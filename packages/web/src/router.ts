import { createRouter, createWebHistory } from 'vue-router';

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
    { path: '/settings', name: 'settings', component: () => import('./routes/SettingsView.vue') },
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
